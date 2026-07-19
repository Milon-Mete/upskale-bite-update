const mongoose = require('mongoose');

// Question Schema (used inside quiz modules)
const questionSchema = new mongoose.Schema({
  questionText: { type: String, required: true },
  options: [{ type: String, required: true }],
  correctAnswer: { type: String, required: true }
});

// Module Schema - Can be Video or Quiz
const moduleSchema = new mongoose.Schema({
  type: { type: String, enum: ['video', 'quiz'], required: true },
  order: { type: Number, default: 0 },
  // Video fields
  title: { type: String },
  description: { type: String },
  thumbnail: { type: String },
  videoUrls: {
    bn: { type: String },
    en: { type: String },
    hi: { type: String }
  },
  views: { type: Number, default: 0 },
  baseLikes: { type: Number, default: 40 },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  // Quiz fields
  questions: [questionSchema]
});

// Chapter Schema (user calls this a "Module" — a grouping of chapters)
const chapterSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  order: { type: Number, default: 0 },
  modules: [moduleSchema],
  // Certificate flag — the last Module (chapter) in the course is the Certificate Module
  isCertificateModule: { type: Boolean, default: false }
});

// Pricing Schema
const pricingSchema = new mongoose.Schema({
  price: { type: Number, required: true },
  duration: { type: String, required: true },
  active: { type: Boolean, default: true }
}, { _id: false });

// Main BiteSize Course Schema
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
  trailerUrl: { type: String, default: "" },
  // CHAPTERS (replaces old content[] + quiz)
  chapters: [chapterSchema],
  // PRICING
  pricing: {
    trial: pricingSchema,
    standard: pricingSchema
  },
  // REVIEWS
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
