const mongoose = require('mongoose');

const masterclassSchema = new mongoose.Schema({
  title: { type: String, required: true },
  slug: { type: String, unique: true },
  
  // Hero Section
  tagline: { type: String }, 
  bannerImage: { type: String, required: true }, 
  
  // Expert Details
  expert: {
    name: { type: String, required: true },
    designation: { type: String },
    image: { type: String },
    bio: { type: String } 
  },

  // Timing
  schedule: {
    startDate: { type: Date, required: true },
    startTime: { type: String, required: true }, 
    endTime: { type: String, required: true }    
  },

  // Pricing
  price: {
    original: { type: Number, required: true },
    discounted: { type: Number, required: true }
  },

  // Content
  whatYouWillLearn: { type: [String], default: [] },
  whoIsThisFor: [String],
  
  faqs: [{ question: String, answer: String }],
  reviews: [{ studentName: String, rating: Number, comment: String }],

  meetingLink: { type: String },
  totalSeats: { type: Number, default: 50 },
  enrolledCount: { type: Number, default: 0 },

  // --- NEW: MANUAL STATUS CONTROL ---
  // Use this if you need to hide a class BEFORE the date (e.g. cancelled)
  manualStatus: { 
    type: String, 
    enum: ['published', 'cancelled', 'draft'], 
    default: 'published' 
  }

}, { 
  timestamps: true,
  toJSON: { virtuals: true }, // Enable virtuals in JSON
  toObject: { virtuals: true } 
});

// --- NEW: AUTOMATIC EXPIRATION LOGIC ---
masterclassSchema.virtual('isExpired').get(function () {
  const today = new Date();
  const classDate = new Date(this.schedule.startDate);
  
  // Set class expiration to the END of the scheduled day (23:59:59)
  classDate.setHours(23, 59, 59, 999); 
  
  return today > classDate;
});

// Auto-Slug Logic
masterclassSchema.pre('save', async function() {
  if (this.isModified('title') || this.isNew) {
    let baseSlug = this.title.toLowerCase().trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
      
    this.slug = baseSlug || `masterclass-${Date.now()}`;
  }
});

module.exports = mongoose.model('Masterclass', masterclassSchema);