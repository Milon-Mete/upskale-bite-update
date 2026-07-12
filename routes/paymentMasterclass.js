const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const mongoose = require('mongoose');

// Import ONLY the Masterclass Model
const Masterclass = require('../models/Masterclass'); 
const User = require('../models/User');
const Order = require('../models/Order');
const Coupon = require('../models/Coupon');
const Promotion = require('../models/Promotion');

// 🔴 SECURE MIDDLEWARE IMPORTED
const { adminOnly, requireAuth } = require('../middleware/auth');

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ==========================================
// 1. PUBLIC: GET UPCOMING MASTERCLASSES
// ==========================================
// This is for your WEBSITE (Hides expired/drafts)
router.get('/', async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0); 

        const list = await Masterclass.find({
            'schedule.startDate': { $gte: today }, // Only future
            manualStatus: 'published'              // Only published
        }).sort({ 'schedule.startDate': 1 });      // Soonest first

        res.json(list);
    } catch (err) {
        console.error("❌ Fetch Error:", err);
        res.status(500).json({ success: false, message: "Could not fetch masterclasses" });
    }
});

// ==========================================
// 2. ADMIN: GET ALL MASTERCLASSES
// ==========================================
// This is for your DASHBOARD (Shows everything)
router.get('/admin/all', adminOnly, async (req, res) => {
    try {
        const list = await Masterclass.find({}).sort({ createdAt: -1 });
        res.json(list);
    } catch (err) {
        res.status(500).json({ success: false, message: "Server Error" });
    }
});
router.get('/search', adminOnly, async (req, res) => {
    const users = await User.find({
        $or: [
            { name: { $regex: req.query.q, $options: 'i' } },
            { email: { $regex: req.query.q, $options: 'i' } },
            { phone: { $regex: req.query.q, $options: 'i' } }
        ]
    }).select('_id name email phone').limit(10);
    res.json(users);
})

// ==========================================
// 3. GET SINGLE MASTERCLASS BY SLUG
// ==========================================
router.get('/:slug', async (req, res) => {
    try {
        const item = await Masterclass.findOne({ slug: req.params.slug }).select('-meetingLink');
        if (!item) return res.status(404).json({ message: "Masterclass Not Found" });
        
        res.json({ masterclassData: item });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// ==========================================
// 4. CREATE MASTERCLASS ORDER (SECURED)
// ==========================================
router.post('/create-order', requireAuth, async (req, res) => {
    try {
        const { masterclassId, couponCode } = req.body;
        const userId = req.user._id;

        const masterclass = await Masterclass.findById(masterclassId);
        if (!masterclass) {
            return res.status(404).json({ success: false, message: "Masterclass not found in DB" });
        }

        let basePrice = masterclass.price.discounted;
        let finalAmountToCharge = basePrice;
        let appliedCouponData = { code: null, discountValue: 0 };
        let appliedPromotionsData = [];

        // --- DECOUPLED PROMOTIONS ENGINE ---
        if (couponCode) {
            // 1. Validate without incrementing usage count yet
            const coupon = await Coupon.findOne({
                code: couponCode.toUpperCase(),
                isActive: true,
                $or: [
                    { usageLimit: null },
                    { $expr: { $lt: ["$usedCount", "$usageLimit"] } }
                ]
            });

            if (coupon) {
                if (coupon.validUntil && new Date() > coupon.validUntil) {
                    return res.status(400).json({ message: "Coupon Expired" });
                }
                if (basePrice < coupon.minOrderValue) {
                    return res.status(400).json({ message: `Min order value is ₹${coupon.minOrderValue}` });
                }

                // 2. Base Discount Calculation
                let baseDiscount = coupon.discountType === 'percentage'
                    ? (basePrice * coupon.discountValue) / 100
                    : coupon.discountValue;

                if (baseDiscount > basePrice) baseDiscount = basePrice;
                
                appliedCouponData = { code: coupon.code, discountValue: Math.floor(baseDiscount) };
                finalAmountToCharge -= appliedCouponData.discountValue;

                // 3. Automated Promotions Evaluation
                const activePromotions = await Promotion.find({
                    isActive: true,
                    conditionType: 'COUPON_APPLIED',
                    conditionValue: coupon.code
                });

                for (let promo of activePromotions) {
                    if (finalAmountToCharge >= promo.discountValue) {
                        finalAmountToCharge -= promo.discountValue;
                        appliedPromotionsData.push({
                            promotionName: promo.name,
                            discountValue: promo.discountValue
                        });
                    }
                }
            } else {
                return res.status(400).json({ message: "Invalid Coupon or Limit Reached" });
            }
        }

        // Safety floor
        if (finalAmountToCharge < 0) finalAmountToCharge = 0;

        // --- RAZORPAY CREATION ---
        const options = {
            amount: Math.round(finalAmountToCharge * 100), 
            currency: "INR",
            receipt: `mc_rcpt_${Date.now()}_${userId.toString().slice(-4)}`,
            notes: { type: "masterclass_booking", masterclass_title: masterclass.title }
        };

        const order = await razorpay.orders.create(options);

        // --- NEW AUDIT SCHEMA SAVING ---
        const newOrder = new Order({
            userId: userId,
            item: masterclass._id,
            itemModel: 'Masterclass',
            
            amount: finalAmountToCharge, // Legacy safety
            basePrice: basePrice,
            amountPaid: finalAmountToCharge,
            appliedCoupon: appliedCouponData.code ? appliedCouponData : undefined,
            appliedPromotions: appliedPromotionsData.length > 0 ? appliedPromotionsData : [],

            razorpayOrderId: order.id,
            status: 'pending',
            couponUsed: appliedCouponData.code 
        });

        await newOrder.save();

        res.json({
            success: true,
            key_id: process.env.RAZORPAY_KEY_ID,
            order_id: order.id,
            amount: finalAmountToCharge,
            title: masterclass.title,
            description: "Live Masterclass Seat"
        });

    } catch (error) {
        console.error("❌ Masterclass Payment Error:", error);
        res.status(500).json({ success: false, message: "Server Payment Error" });
    }
});

// ==========================================
// 5. VERIFY MASTERCLASS PAYMENT (SECURED)
// ==========================================
// 🔒 Added requireAuth
router.post('/verify-payment', requireAuth, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        const userId = req.user._id; // 🔒 Extracted securely from JWT cookie

        // 1. STRICT CRYPTO VERIFICATION (Runs every time, cannot be bypassed)
        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ success: false, message: "Invalid Payment Signature! Transaction rejected." });
        }

const order = await Order.findOne({ razorpayOrderId: razorpay_order_id });
        if (!order) return res.status(404).json({ message: "Order not found" });

        if (order.userId.toString() !== userId.toString()) {
            return res.status(403).json({ message: "Forbidden: Order does not belong to this user." });
        }

        if (order.status === 'paid') {
            return res.json({ success: true, message: "Order already processed" });
        }

        // =====================================================
        // 🚀 ATOMIC COUPON USAGE INCREMENT (SAFE EXECUTION)
        // =====================================================
        const appliedCode = order.appliedCoupon?.code || order.couponUsed;
        if (appliedCode) {
            await Coupon.findOneAndUpdate(
                { code: appliedCode },
                { $inc: { usedCount: 1 } }
            );
        }

        // Update order status to paid
        order.status = 'paid';
        order.razorpayPaymentId = razorpay_payment_id;
        order.razorpaySignature = razorpay_signature;
        order.fulfilledVia = 'frontend:verify-payment';
        await order.save();

        const user = await User.findById(order.userId);
        
        const alreadyEnrolled = user.enrolledCourses.some(
            enrollment => enrollment.item.toString() === order.item.toString()
        );

        if (!alreadyEnrolled) {
            user.enrolledCourses.push({
                item: order.item,
                itemModel: 'Masterclass',
                paymentStatus: 'full', 
                amountPaid: order.amount, 
                purchasedAt: new Date() 
            });
            await user.save();

            await Masterclass.findByIdAndUpdate(order.item, { 
                $inc: { enrolledCount: 1 } 
            });
        }

        res.json({ success: true, message: "Masterclass Booked Successfully!" });

    } catch (error) {
        console.error("❌ Verification Error:", error);
        res.status(500).json({ success: false, message: "Verification Failed" });
    }
});

// ==========================================
// 6. ADMIN: MANAGE MASTERCLASSES
// ==========================================

// Create Masterclass
router.post('/admin/create', adminOnly, async (req, res) => {
    try {
        const newItem = new Masterclass(req.body);
        await newItem.save();
        res.status(201).json({ message: "Created", masterclass: newItem });
    } catch (err) {
        if (err.code === 11000) return res.status(400).json({ message: "Title exists" });
        res.status(400).json({ message: err.message });
    }
});

// Update Masterclass
router.put('/admin/update/:id', adminOnly, async (req, res) => {
    try {
        const updated = await Masterclass.findByIdAndUpdate(
            req.params.id, 
            req.body, 
            { returnDocument: 'after', runValidators: true } 
        );
        res.json({ message: "Updated", masterclass: updated });
    } catch (err) { 
        res.status(400).json({ message: err.message }); 
    }
});

// Delete Masterclass
router.delete('/admin/delete/:id', adminOnly, async (req, res) => {
    try {
        await Masterclass.findByIdAndDelete(req.params.id);
        res.json({ message: "Deleted" });
    } catch (err) { 
        res.status(500).json({ message: "Server Error" }); 
    }
});

// ==========================================
// 📊 MASTERCLASS ENROLLMENT STATS (SECURED)
// ==========================================
// 🔒 Added adminOnly to prevent data leak
router.get('/admin/enrollment-stats', adminOnly, async (req, res) => {
    try {
        const stats = await User.aggregate([
            { $unwind: "$enrolledCourses" },
            // Use regex for match to be safe with case sensitivity
            { $match: { "enrolledCourses.itemModel": { $regex: /^masterclass$/i } } },
            {
                $lookup: {
                    from: "masterclasses", 
                    localField: "enrolledCourses.item",
                    foreignField: "_id",
                    as: "masterclassData" 
                }
            },
            { $unwind: "$masterclassData" },
            {
                $group: {
                    _id: "$masterclassData._id",
                    title: { $first: "$masterclassData.title" },
                    expertName: { $first: "$masterclassData.expert.name" },
                    startDate: { $first: "$masterclassData.schedule.startDate" },
                    enrolledCount: { $sum: 1 },
                    students: {
                        $push: {
                            name: "$name",
                            phone: "$phone",
                            email: "$email",
                            // This fallback ensures it grabs the right date field
                            enrolledAt: { $ifNull: ["$enrolledCourses.purchasedAt", "$enrolledCourses.enrolledAt", "$createdAt"] }
                        }
                    }
                }
            }
        ]);

        console.log("Found Stats:", JSON.stringify(stats, null, 2));
        res.json({ success: true, stats });
    } catch (err) {
        console.error("Aggregation Error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});



// ==========================================
// 7. ADMIN: MANUALLY ENROLL A USER
// ==========================================
router.post('/admin/enroll-user', adminOnly, async (req, res) => {
    try {
        const { userId, masterclassId } = req.body;

        // Validate IDs
        if (!userId || !masterclassId) {
            return res.status(400).json({ success: false, message: "userId and masterclassId are required" });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, message: "User not found" });

        const masterclass = await Masterclass.findById(masterclassId);
        if (!masterclass) return res.status(404).json({ success: false, message: "Masterclass not found" });

        // Check if already enrolled
        const alreadyEnrolled = user.enrolledCourses.some(
            enrollment => enrollment.item.toString() === masterclassId.toString()
        );

        if (alreadyEnrolled) {
            return res.status(400).json({ success: false, message: "User is already enrolled in this masterclass" });
        }

        // Enroll the user (amountPaid: 0 for admin-granted access)
        user.enrolledCourses.push({
            item: masterclass._id,
            itemModel: 'Masterclass',
            paymentStatus: 'full',
            amountPaid: 0,
            purchasedAt: new Date()
        });
        await user.save();

        // Increment enrolled count on the masterclass
        await Masterclass.findByIdAndUpdate(masterclassId, {
            $inc: { enrolledCount: 1 }
        });

        res.json({
            success: true,
            message: `✅ ${user.name || user.email} successfully enrolled in "${masterclass.title}"`
        });

    } catch (error) {
        console.error("❌ Admin Enroll Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

module.exports = router;