const express = require('express');
const router = express.Router();
const Promotion = require('../models/Promotion');
const { adminOnly } = require('../middleware/auth'); 

// ==========================================
// ADMIN: MANAGE PROMOTIONS (RULES ENGINE)
// ==========================================

// 1. Create a new automated rule
router.post('/admin/create', adminOnly, async (req, res) => {
    try {
        const newPromotion = new Promotion({
            name: req.body.name, 
            conditionType: req.body.conditionType, 
            conditionValue: req.body.conditionValue.toUpperCase(), 
            discountValue: req.body.discountValue, 
            uiMessage: req.body.uiMessage 
        });
        await newPromotion.save();
        res.status(201).json({ message: "Promotion Rule Created", promotion: newPromotion });
    } catch (err) {
        res.status(500).json({ message: err.message }); 
    }
});

// 2. Get all rules
router.get('/admin/all', adminOnly, async (req, res) => {
    try {
        const promotions = await Promotion.find({}).sort({ createdAt: -1 });
        res.json(promotions);
    } catch (err) { 
        res.status(500).json({ message: err.message }); 
    }
});

// 3. Delete a rule
router.delete('/admin/delete/:id', adminOnly, async (req, res) => {
    try {
        await Promotion.findByIdAndDelete(req.params.id);
        res.json({ message: "Promotion Deleted" });
    } catch (err) { 
        res.status(500).json({ message: err.message }); 
    }
});

module.exports = router;