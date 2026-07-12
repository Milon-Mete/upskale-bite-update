const express = require('express');
const router = express.Router();
const Coupon = require('../models/Coupon');
const Promotion = require('../models/Promotion');
const { adminOnly } = require('../middleware/auth'); // <--- Import Security

// ==========================================
// 1. PUBLIC: VERIFY COUPON (For Cart Page)
// ==========================================
router.post('/verify', async (req, res) => {
    try {
        const { code, orderAmount } = req.body;
        
        // 1. Verify standard coupon
        const coupon = await Coupon.findOne({ code: code.toUpperCase(), isActive: true });
        if (!coupon) return res.status(404).json({ message: "Invalid Coupon" });
        // ... (Include your existing expiration and limit checks here) ...

        let baseDiscount = coupon.discountType === 'percentage' 
            ? (orderAmount * coupon.discountValue) / 100 
            : coupon.discountValue;

        // 2. Run the Promotions Engine
        let totalDiscount = baseDiscount;
        let appliedPromotions = [];

        const activePromotions = await Promotion.find({
            isActive: true,
            conditionType: 'COUPON_APPLIED',
            conditionValue: coupon.code
        });

        for (let promo of activePromotions) {
            totalDiscount += promo.discountValue;
            appliedPromotions.push({
                discountValue: promo.discountValue,
                message: promo.uiMessage
            });
        }

        if (totalDiscount > orderAmount) totalDiscount = orderAmount;

        // 3. Send the decoupled response
        res.json({ 
            success: true, 
            code: coupon.code,
            baseDiscount: Math.floor(baseDiscount),
            totalDiscount: Math.floor(totalDiscount), 
            appliedPromotions: appliedPromotions 
        });

    } catch (err) { res.status(500).json({ message: "Server Error" }); }
});

// ==========================================
// 2. ADMIN: MANAGE COUPONS
// ==========================================

// Get All Coupons
router.get('/admin/all', adminOnly, async (req, res) => {
    try {
        const coupons = await Coupon.find({}).sort({ createdAt: -1 });
        res.json(coupons);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// Create Coupon
router.post('/admin/create', adminOnly, async (req, res) => {
    try {
        const newCoupon = new Coupon({
            ...req.body,
            code: req.body.code.toUpperCase() // Force Uppercase
        });
        await newCoupon.save();
        res.json({ message: "Created", coupon: newCoupon });
    } catch (err) {
        if(err.code === 11000) return res.status(400).json({ message: "Code already exists" });
        res.status(500).json({ message: err.message }); 
    }
});

// Delete Coupon
router.delete('/admin/delete/:id', adminOnly, async (req, res) => {
    try {
        await Coupon.findByIdAndDelete(req.params.id);
        res.json({ message: "Deleted" });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;