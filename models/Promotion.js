const mongoose = require('mongoose');

const PromotionSchema = new mongoose.Schema({
  name: { type: String, required: true }, // e.g., 'Masterclass Surprise'
  conditionType: { type: String, required: true }, // e.g., 'COUPON_APPLIED'
  conditionValue: { type: String, required: true }, // e.g., 'TCCIAN100'
  discountValue: { type: Number, required: true }, // e.g., 9
  uiMessage: { type: String, required: true }, // e.g., 'Masterclass Student'
  isActive: { type: Boolean, default: true }
});

module.exports = mongoose.model('Promotion', PromotionSchema);