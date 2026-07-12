const mongoose = require('mongoose');

// 1. Pricing Structure
const pricingSchema = new mongoose.Schema({
  price: { type: Number, required: true },
  duration: { type: String, required: true }, // e.g., "Month", "3 Days"
  active: { type: Boolean, default: true }
}, { _id: false });

// 2. Quiz Question Structure (For the 10-question certificate system)
const questionSchema = new mongoose.Schema({
  questionText: { type: String, required: true },
  options: [{ type: String, required: true }], // Array of 4 possible answers
  correctAnswer: { type: String, required: true } // Must match one of the options exactly
});

// 3. Main Bite-Sized Course Schema
const biteSizeCourseSchema = new mongoose.Schema({
  title: { type: String, required: true },
  highlight: { type: String, required: true }, 
  tag: { type: String, required: true }, 
  highlightColor: { type: String, default: "text-emerald-400" },
  glowColor: { type: String, default: "md:group-hover:shadow-emerald-500/20" },
  image: { type: String, required: true }, 
  iconName: { type: String, required: true }, 
  slug: { type: String, required: true, unique: true },
  isLocked: { type: Boolean, default: false },
  
  // 🔴 THE FREE PREVIEW TRAILER
  trailerUrl: { type: String, default: "" }, 
  
  // 🔴 MULTI-LANGUAGE CONTENT ARRAY 
  content: [{
    title: { type: String, required: true },
    description: { type: String },
    thumbnail: { type: String }, 
    
    // The Multi-Language Video Object
    videoUrls: {
        bn: { type: String, required: true }, // Bengali is mandatory/default
        en: { type: String, default: "" },    // English
        hi: { type: String, default: "" }     // Hindi
    },
    
    // Keeping this temporarily so old data doesn't instantly crash your app
    videoUrl: { type: String }, 

    order: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
    baseLikes: { type: Number, default: 40 },
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
  }],
  
  pricing: {
    trial: pricingSchema,
    standard: pricingSchema
  },

  // CERTIFICATE QUIZ SYSTEM
  quiz: {
    enabled: { type: Boolean, default: false },
    passingScore: { type: Number, default: 70 }, 
    questions: [questionSchema] 
  },

  // --- USER REVIEWS & RATINGS ---
  reviews: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now }
  }],
  averageRating: { type: Number, default: 0 },
  totalReviews: { type: Number, default: 0 }

}, { timestamps: true });

module.exports = mongoose.model('BiteSizeCourse', biteSizeCourseSchema);