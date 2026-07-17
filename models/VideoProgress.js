const mongoose = require('mongoose');

const videoProgressSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'BiteSizeCourse', required: true },
  
  // NEW: Chapter + Module hierarchy
  chapterId: { type: mongoose.Schema.Types.ObjectId, required: true },
  moduleId: { type: mongoose.Schema.Types.ObjectId, required: true },
  moduleType: { type: String, enum: ['video', 'quiz'], default: 'video' },
  
  // Progress tracking
  watchedSeconds: { type: Number, default: 0 },
  totalDuration: { type: Number, default: 0 },
  completed: { type: Boolean, default: false },
  
  // Last position for resume
  lastPosition: { type: Number, default: 0 },
  
  // Track quiz questions answered correctly (for quiz modules)
  answeredQuestions: [{ 
    questionId: { type: mongoose.Schema.Types.ObjectId },
    correct: { type: Boolean }
  }],
  
  lastWatchedAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Compound index for efficient lookups
videoProgressSchema.index({ user: 1, courseId: 1, chapterId: 1, moduleId: 1 });

const VideoProgress = mongoose.models.VideoProgress || mongoose.model('VideoProgress', videoProgressSchema);

// 🔴 Drop old contentId index that conflicts with new schema
// This index was from the previous schema version and causes E11000 duplicate key errors
VideoProgress.init().then(() => {
    VideoProgress.collection.dropIndex('user_1_courseId_1_contentId_1')
        .then(() => console.log('✅ Dropped old videoprogress index: user_1_courseId_1_contentId_1'))
        .catch(() => {/* Index already removed, that's fine */});
}).catch(() => {});

module.exports = VideoProgress;
