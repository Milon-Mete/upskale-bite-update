const mongoose = require('mongoose');

const certificateSchema = new mongoose.Schema({
  certificateId: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  studentName: { type: String, required: true },
  phone: { type: String },
  
  // ✅ UPDATED: Dynamic reference to support Courses, Cohorts, and Masterclasses
  course: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: 'itemModel' },
  itemModel: { type: String, required: true, enum: ['Course', 'Cohort', 'Masterclass','BiteSizeCourse'], default: 'Course' },
  
  courseName: { type: String, required: true },
  planType: { type: String, default: 'recorded' },
  score: { type: Number, default: null },
  issuedDate: { type: String, required: true },
  certificateUrl: { type: String, required: true }
}, { timestamps: true });

module.exports = mongoose.models.Certificate || mongoose.model('Certificate', certificateSchema);