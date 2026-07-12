const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  
  // Product Details
  item: { type: mongoose.Schema.Types.ObjectId, refPath: 'itemModel' },
  itemModel: { 
    type: String, 
    required: true, 
    enum: ['Course', 'Masterclass', 'Cohort', 'BiteSizeCourse', 'Subscription'] 
  },
  planType: { 
    type: String, 
    enum: ['recorded', 'live', 'trial', 'standard', 'subscription', 'monthly', 'yearly'], 
    default: 'recorded' 
  },

  // --- FINANCIAL AUDIT TRAIL (NEW) ---
  basePrice: { type: Number, required: true }, // The price BEFORE any discounts
  amountPaid: { type: Number, required: true }, // The FINAL price sent to Razorpay
  
  // User-Initiated Coupon
  appliedCoupon: {
    code: { type: String, default: null }, // e.g., 'TCCIAN100'
    discountValue: { type: Number, default: 0 } // e.g., 100
  },

  // System-Initiated Promotions (The Rules Engine)
  appliedPromotions: [{
    promotionName: { type: String }, // e.g., 'Masterclass Surprise'
    discountValue: { type: Number } // e.g., 9
  }],
  // -----------------------------------

  paymentType: { 
    type: String, 
    enum: ['full', 'installment', 'one-time', 'partial'], 
    default: 'full' 
  },
  fulfilledVia: {
        type: String,
        default: null
        // Values: 'webhook:payment.captured', 'webhook:order.paid',
        //         'frontend:verify-payment', null (pending)
    },
    failureReason: {
        type: String,
        default: null
        // Stores Razorpay error code + description on payment.failed
    },

  // Gateway Details
  razorpayOrderId: { type: String, required: true },
  razorpayPaymentId: { type: String },
  razorpaySignature: { type: String },
  status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' }
  
}, { timestamps: true });

module.exports = mongoose.models.Order || mongoose.model('Order', orderSchema);