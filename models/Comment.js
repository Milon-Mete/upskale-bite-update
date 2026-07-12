const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'BiteSizeCourse', required: true },
  contentId: { type: mongoose.Schema.Types.ObjectId, required: true },
  text: { type: String, required: true, maxlength: 1000 },
  
  // For nested replies (optional)
  parentComment: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', default: null },
  
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });

commentSchema.index({ courseId: 1, contentId: 1, createdAt: -1 });

module.exports = mongoose.models.Comment || mongoose.model('Comment', commentSchema);