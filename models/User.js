// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  email: { type: String, default: null },
  age: { type: Number, default: null },
  gender: { type: String, default: null },
  referredBy: { type: String, default: null }, // Keeps the original referrer's ID or Phone
  role: { type: String, enum: ['student', 'admin', 'instructor'], default: 'student' },

  // --- ENROLLMENTS ARRAY (Legacy Courses & Ghost Records) ---
  // ... (keep your existing top-level fields: name, phone, etc.)

  enrolledCourses: [
    {
      item: { 
        type: mongoose.Schema.Types.ObjectId, 
        required: true, 
        refPath: 'enrolledCourses.itemModel' 
      },
      itemModel: { 
        type: String, 
        required: true, 
        enum: ['Course', 'Masterclass', 'Cohort', 'BiteSizeCourse'] 
      },
      planType: { 
        type: String, 
        // Synchronized array
        enum: ['recorded', 'live', 'trial', 'standard', 'subscription', 'monthly', 'yearly'], 
        default: 'recorded' 
      },
      paymentStatus: { 
        type: String, 
        // Synchronized array
        enum: ['full', 'installment', 'one-time', 'partial'], 
        default: 'full' 
      },
      amountPaid: { type: Number, default: 0 },
      purchasedAt: { type: Date, default: Date.now },
      progress: { type: Number, default: 0 },
      completedLessons: [{ type: String }],
      certificateUrl: { type: String, default: null },
      issuedDate: { type: String, default: null },
      score: { type: Number, default: null }
    }
  ],

  biteSizeSubscription: {
    status: { type: String, enum: ['inactive', 'active'], default: 'inactive' },
    planType: { type: String, enum: ['none', 'trial', 'monthly', 'yearly'], default: 'none' },
    expiresAt: { type: Date, default: null },
    trialUsed: { type: Boolean, default: false }
  },

// ... (keep the rest of your schema)

  // --- REFERRAL SYSTEM ---
  walletBalance: { type: Number, default: 0 }, // Tracks total money earned

  // --- STREAK TRACKING ---
  lastActiveDate: { type: Date, default: null },
  currentStreak: { type: Number, default: 0 },
  longestStreak: { type: Number, default: 0 },
  
  // --- COMPLETION BADGES ---
  completedCourses: [{ 
    courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'BiteSizeCourse' },
    completedAt: { type: Date, default: Date.now },
    badgeUrl: { type: String, default: '' }
  }]

}, { timestamps: true });

// 🔍 Performance indexes for subscription queries
userSchema.index({ "biteSizeSubscription.planType": 1 });
userSchema.index({ "biteSizeSubscription.expiresAt": 1 });
userSchema.index({ "biteSizeSubscription.status": 1, "biteSizeSubscription.expiresAt": 1 });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);