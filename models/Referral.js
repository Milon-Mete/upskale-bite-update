// models/Referral.js
const mongoose = require('mongoose');

const referralSchema = new mongoose.Schema({
  // The person who shared their link (The Earner)
  referrerId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  
  // The new person who clicked the link and signed up
  referredUserId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  
  // Tracks if the new user actually bought something
  status: { 
    type: String, 
    enum: ['pending', 'successful'], 
    default: 'pending' 
  },
  
  // How much money the referrer earned from this specific signup
  rewardEarned: { 
    type: Number, 
    default: 0 
  },

  // Optional: Track which course triggered the successful referral
  purchasedCourseId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  }
}, { timestamps: true });

module.exports = mongoose.models.Referral || mongoose.model('Referral', referralSchema);