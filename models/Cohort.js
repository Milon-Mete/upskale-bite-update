const mongoose = require('mongoose');

const cohortSchema = new mongoose.Schema({
  title: { type: String, required: true },
  slug: { type: String, unique: true },
  
  // FIXED: "cohort" is not a valid mongoose type definition. 
  // Set it as a String with a default value, or an enum if you want to restrict it.
  category: { type: String, default: 'Cohort' },

  pricing: {
    recorded: { 
      original: { type: Number, required: true },
      discount: { type: Number, required: true } 
    }, 
    live: { 
      original: { type: Number, required: true },
      discount: { type: Number, required: true } 
    }, 
    // FIXED: Adjusted brackets to properly include installment inside pricing
    installment: {
      enabled: { type: Boolean, default: false }, 
      pricePart1: { type: Number, default: 0 }, // First Payment
      pricePart2: { type: Number, default: 0 }, // Second Payment
      totalParts: { type: Number, default: 2 }  // Fixed at 2 parts
    }
  },

  thumbnail: { type: String, required: true },
  demoVideoUrl: { type: String },
  description: { type: String },
  tags: [String],
  level: { type: String, enum: ['Beginner', 'Intermediate', 'Advanced'], default: 'Beginner' },
  language: { type: String, default: 'English' },
  liveStartDate: { type: Date },
  enrolledCount: { type: Number, default: 0 },
  isPublished: { type: Boolean, default: false },
  averageRating: { type: Number, default: 0 },
  reviews: [{ studentName: String, rating: Number, comment: String }],
  
  // NEW: Added course outline structure
  course: [{
    Title: { type: String, required: true },
    topic: [{ type: String, required: true }]
  }],

  // NEW: Added "What you will learn" section
  whatulearn: [{
    text: { type: String, required: true },
    desc: { type: String, required: true },
    imageurl: { type: String, required: true }
  }],

  content: [
    {
      chapterTitle: String,
      lessons: [
        {
          title: String,
          videoId: String,
          duration: String,
          isFreePreview: { type: Boolean, default: false },
          resources: [{ title: String, url: String }]
        }
      ]
    }
  ]
}, { timestamps: true });

// Auto-Slug Logic
cohortSchema.pre('save', async function () {
  if (this.isModified('title') || this.isNew) {
    if (this.title) {
      this.slug = this.title.toLowerCase().trim()
        .replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '')
        + '-' + Date.now();
    }
  }
});

// ✅ FIX: Use this check to prevent "Cannot overwrite model once compiled" error
module.exports = mongoose.models.Cohort ||
  mongoose.model('Cohort', cohortSchema);