const mongoose = require('mongoose');

const videoProgressSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'BiteSizeCourse', required: true },
  contentId: { type: mongoose.Schema.Types.ObjectId, required: true },
  
  // Progress tracking
  watchedSeconds: { type: Number, default: 0 },
  totalDuration: { type: Number, default: 0 },
  completed: { type: Boolean, default: false },
  
  // Last position for resume
  lastPosition: { type: Number, default: 0 },
  
  lastWatchedAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Compound index for efficient lookups
videoProgressSchema.index({ user: 1, courseId: 1, contentId: 1 }, { unique: true });

module.exports = mongoose.models.VideoProgress || mongoose.model('VideoProgress', videoProgressSchema);