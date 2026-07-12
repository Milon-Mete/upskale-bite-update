const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const User = require('../models/User');
const Order = require('../models/Order');
const Coupon = require('../models/Coupon');
const Cohort = require('../models/Cohort');
const Masterclass = require('../models/Masterclass');
const BiteSizeCourse = require('../models/BiteSizeCourse');

// =====================================================
// ⚡ RAZORPAY WEBHOOK — THE SINGLE SOURCE OF TRUTH
// =====================================================
//
// WHY THIS EXISTS:
//   Your frontend verify-payment calls are unreliable.
//   If a user pays and their tab crashes, app closes,
//   or network drops — the payment goes through on
//   Razorpay's side but your DB never gets updated.
//
//   Razorpay webhooks solve this. Razorpay calls YOUR
//   server directly (server-to-server) after every
//   payment event — no browser involved at all.
//
// HOW TO REGISTER IN RAZORPAY DASHBOARD:
//   Dashboard → Settings → Webhooks → Add New Webhook
//   URL: https://yourdomain.com/api/webhook/razorpay
//   Secret: (set RAZORPAY_WEBHOOK_SECRET in your .env)
//   Active Events:
//     ✅ payment.captured
//     ✅ payment.failed
//     ✅ order.paid
//
// HOW TO ADD TO server.js (ONE LINE):
//   app.use('/api/webhook', require('./webhook'));
//
//   ⚠️  CRITICAL: Mount this BEFORE bodyParser.json()
//   middleware, or raw body reading will break.
//   Put it at the TOP of your middleware stack.
//
// =====================================================

// =====================================================
// STEP 1: SIGNATURE VERIFICATION MIDDLEWARE
// =====================================================
// Razorpay signs every webhook with HMAC-SHA256.
// We MUST verify this before trusting any data.
// We need the RAW body bytes for this — NOT parsed JSON.
// That's why this route uses express.raw() instead of
// express.json().

router.post(
    '/razorpay',
    express.raw({ type: 'application/json' }), // ← RAW body, not parsed
    async (req, res) => {

        // ---------------------------------------------------
        // 1. VERIFY THE WEBHOOK SIGNATURE
        // ---------------------------------------------------
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
        const receivedSignature = req.headers['x-razorpay-signature'];

        if (!webhookSecret || !receivedSignature) {
            console.error('❌ Webhook: Missing secret or signature header');
            return res.status(400).json({ message: 'Missing signature' });
        }

        const expectedSignature = crypto
            .createHmac('sha256', webhookSecret)
            .update(req.body) // req.body is raw Buffer here
            .digest('hex');

        if (expectedSignature !== receivedSignature) {
            console.error('❌ Webhook: Invalid signature — possible spoofing attempt');
            return res.status(400).json({ message: 'Invalid signature' });
        }

        // ---------------------------------------------------
        // 2. PARSE THE PAYLOAD (now safe to parse)
        // ---------------------------------------------------
         let event;
        try {
            event = JSON.parse(req.body.toString());
        } catch (e) {
            return res.status(400).json({ message: 'Invalid JSON' });
        }

        const eventType = event.event;

        try {
            switch (eventType) {
                case 'payment.captured':
                    await handlePaymentCaptured(event.payload);
                    break;
                case 'order.paid':
                    await handleOrderPaid(event.payload);
                    break;
                case 'payment.failed':
                    await handlePaymentFailed(event.payload);
                    break;
            }
            // Only send 200 if processing succeeded
            return res.status(200).json({ received: true });
        } catch (err) {
            console.error(`Webhook handler error for "${eventType}":`, err);
            // Return 500 so Razorpay retries
            return res.status(500).json({ message: 'Processing failed' });
        }
    }
);

// =====================================================
// HANDLER: payment.captured
// =====================================================
// Fires when a single payment succeeds and is captured.
// This is the main event for standard one-time payments.
// We use the razorpay_order_id to find our pending Order(s).

async function handlePaymentCaptured(payload) {
    const payment = payload.payment?.entity;
    if (!payment) {
        console.error('❌ handlePaymentCaptured: No payment entity in payload');
        return;
    }

    const razorpayOrderId  = payment.order_id;
    const razorpayPaymentId = payment.id;

    console.log(`✅ payment.captured | order: ${razorpayOrderId} | payment: ${razorpayPaymentId}`);

    await fulfillByOrderId(razorpayOrderId, razorpayPaymentId, 'webhook:payment.captured');
}

// =====================================================
// HANDLER: order.paid
// =====================================================
// More reliable for multi-item cart orders. Fires once
// the full order amount is collected by Razorpay.

async function handleOrderPaid(payload) {
    const order   = payload.order?.entity;
    const payment = payload.payment?.entity;

    if (!order || !payment) {
        console.error('❌ handleOrderPaid: Missing order or payment entity');
        return;
    }

    const razorpayOrderId   = order.id;
    const razorpayPaymentId = payment.id;

    console.log(`✅ order.paid | order: ${razorpayOrderId} | payment: ${razorpayPaymentId}`);

    await fulfillByOrderId(razorpayOrderId, razorpayPaymentId, 'webhook:order.paid');
}

// =====================================================
// HANDLER: payment.failed
// =====================================================
// Fires when a payment attempt fails. We mark orders as
// 'failed' so the user can retry with a NEW Razorpay order.
// We do NOT delete orders — keep them for audit trail.

async function handlePaymentFailed(payload) {
    const payment = payload.payment?.entity;
    if (!payment) {
        console.error('❌ handlePaymentFailed: No payment entity in payload');
        return;
    }

    const razorpayOrderId = payment.order_id;
    const errorDesc       = payment.error_description || 'Unknown error';
    const errorCode       = payment.error_code || 'UNKNOWN';

    console.log(`❌ payment.failed | order: ${razorpayOrderId} | reason: ${errorCode} — ${errorDesc}`);

    // Find all pending orders for this Razorpay order ID
    const pendingOrders = await Order.find({
        razorpayOrderId,
        status: 'pending'
    });

    if (!pendingOrders.length) {
        console.log(`ℹ️  payment.failed: No pending orders found for ${razorpayOrderId} — already processed or not found`);
        return;
    }

    // Mark them all as failed with reason stored
    for (const order of pendingOrders) {
        order.status       = 'failed';
        order.failureReason = `${errorCode}: ${errorDesc}`;
        await order.save();
    }

    console.log(`📋 Marked ${pendingOrders.length} order(s) as failed for ${razorpayOrderId}`);
    // NOTE: These orders stay in DB for your audit log.
    // The user will need to go back and checkout again,
    // which creates a NEW Razorpay order — this is correct behavior.
}

// =====================================================
// CORE FULFILLMENT ENGINE
// =====================================================
// This is the heart of the webhook. It is called by both
// payment.captured and order.paid handlers.
//
// KEY DESIGN DECISIONS:
//   1. IDEMPOTENCY: We check `status === 'paid'` first.
//      If already processed (e.g. webhook fires twice),
//      we skip silently. Safe to call multiple times.
//
//   2. UNIVERSAL: Handles all itemModel types —
//      Cohort, Course, Masterclass, Subscription (BiteSize).
//
//   3. ATOMIC COUPON INCREMENT: Only increments coupon
//      usage ONCE, guarded by the idempotency check.

// =====================================================
// CORE FULFILLMENT ENGINE (HARDENED)
// =====================================================

async function fulfillByOrderId(razorpayOrderId, razorpayPaymentId, source) {
    // 1. Fetch all orders tied to this Razorpay transaction
    const orders = await Order.find({ razorpayOrderId });

    if (!orders.length) {
        console.error(`❌ fulfillByOrderId [${source}]: No orders found for ${razorpayOrderId}`);
        return;
    }

    // ---------------------------------------------------
    // ATOMIC IDEMPOTENCY GUARD
    // ---------------------------------------------------
    // We attempt to atomically update the first order from 'pending' (or 'failed') to 'processing'.
    // If this returns null, another thread (frontend or duplicate webhook) already claimed it.
    const lock = await Order.findOneAndUpdate(
        { 
            _id: orders[0]._id, 
            status: { $in: ['pending', 'failed'] } 
        },
        { $set: { status: 'processing' } },
        { new: true }
    );

    if (!lock) {
        console.log(`ℹ️ [${source}] Orders for ${razorpayOrderId} already processed or processing by another thread. Skipping.`);
        return; 
    }

    // ---------------------------------------------------
    // COUPON USAGE INCREMENT (Guaranteed Atomic & Run Once)
    // ---------------------------------------------------
    const appliedCode = orders[0].appliedCoupon?.code || orders[0].couponUsed;
    if (appliedCode) {
        await Coupon.findOneAndUpdate(
            { code: appliedCode },
            { $inc: { usedCount: 1 } }
        );
        console.log(`🎟️ Coupon "${appliedCode}" usage incremented`);
    }

    // ---------------------------------------------------
    // PROCESS ALL ORDERS
    // ---------------------------------------------------
    const userId = orders[0].userId;
    const user = await User.findById(userId);

    if (!user) {
        console.error(`❌ [${source}] User ${userId} not found`);
        // Note: You may want to revert the order status or alert an admin here.
        return;
    }

    for (const order of orders) {
        // Handle Subscription Order
        if (order.itemModel === 'Subscription') {
            await fulfillSubscription(order, user, razorpayPaymentId, source);
            continue; // PROPER FIX: Move to next order, do not exit function
        }

        // Handle Product Orders
        order.status = 'paid';
        order.razorpayPaymentId = razorpayPaymentId;
        order.fulfilledVia = source;
        await order.save();

        const existing = user.enrolledCourses.find(
            e => e.item.toString() === order.item.toString()
        );

        if (existing) {
            // Upgrades
            if (existing.paymentStatus === 'partial' && order.paymentType === 'full') {
                existing.paymentStatus = 'full';
                existing.amountPaid += order.amountPaid;
                console.log(`⬆️ Upgraded ${order.item} to full payment`);
            }
            if (existing.planType === 'recorded' && order.planType === 'live') {
                existing.planType = 'live';
                existing.amountPaid += order.amountPaid;
                existing.paymentStatus = order.paymentType === 'installment' ? 'partial' : 'full';
                console.log(`⬆️ Upgraded ${order.item} to live plan`);
            }
        } else {
            // Fresh Enrollment
            user.enrolledCourses.push({
                item: order.item,
                itemModel: order.itemModel || 'Cohort',
                planType: order.planType || 'recorded',
                paymentStatus: order.paymentType === 'installment' ? 'partial' : 'full',
                amountPaid: order.amountPaid,
                purchasedAt: new Date()
            });
            await incrementEnrolledCount(order.itemModel, order.item);
            console.log(`🎓 Enrolled user ${userId} in ${order.itemModel} ${order.item}`);
        }
    }

    user.markModified('enrolledCourses');
    await user.save();

    console.log(`✅ [${source}] Fulfilled ${orders.length} order(s) for user ${userId}`);
}

// =====================================================
// SUBSCRIPTION FULFILLMENT (Refactored to accept user object)
// =====================================================

async function fulfillSubscription(order, user, razorpayPaymentId, source) {
    order.status = 'paid';
    order.razorpayPaymentId = razorpayPaymentId;
    order.fulfilledVia = source;
    await order.save();

    const daysMap = { trial: 3, monthly: 30, yearly: 365 };
    const daysToAdd = daysMap[order.planType] || 30;

    const currentExpiration = user.biteSizeSubscription?.expiresAt;
    const baseDate = (currentExpiration && new Date(currentExpiration) > new Date())
        ? new Date(currentExpiration)
        : new Date();

    const newExpirationDate = new Date(baseDate.getTime() + (daysToAdd * 24 * 60 * 60 * 1000));
    const wasTrialUsed = user.biteSizeSubscription?.trialUsed || false;

    user.biteSizeSubscription = {
        status: 'active',
        planType: order.planType,
        expiresAt: newExpirationDate,
        trialUsed: order.planType === 'trial' ? true : wasTrialUsed
    };

    console.log(`✅ [${source}] BiteSize subscription activated for user ${user._id}`);
}

// =====================================================
// HELPER: Increment enrolledCount on product model
// =====================================================

async function incrementEnrolledCount(itemModel, itemId) {
    const modelMap = {
        Course:        Course,
        Cohort:        Cohort,
        Masterclass:   Masterclass,
        BiteSizeCourse: BiteSizeCourse
    };

    const Model = modelMap[itemModel];
    if (Model) {
        await Model.findByIdAndUpdate(itemId, { $inc: { enrolledCount: 1 } });
    }
}

module.exports = router;