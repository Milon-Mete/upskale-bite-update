const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const VideoProgress = require('../models/VideoProgress');
const Comment = require('../models/Comment');
const BiteSizeCourse = require('../models/BiteSizeCourse');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');

// =====================================================
// 📊 VIDEO PROGRESS TRACKING
// =====================================================

// Save video progress
router.post('/progress/save', requireAuth, async (req, res) => {
    try {
        const { courseId, contentId, watchedSeconds, totalDuration, lastPosition } = req.body;
        const userId = req.user._id;

        let progress = await VideoProgress.findOne({ user: userId, courseId, contentId });

        if (progress) {
            progress.watchedSeconds = Math.max(progress.watchedSeconds, watchedSeconds || 0);
            progress.totalDuration = totalDuration || progress.totalDuration;
            progress.lastPosition = lastPosition !== undefined ? lastPosition : progress.lastPosition;
            progress.lastWatchedAt = new Date();
            
            // Mark completed if watched >= 90% of duration
            if (progress.totalDuration > 0 && (progress.watchedSeconds / progress.totalDuration) >= 0.9) {
                progress.completed = true;
            }
            
            await progress.save();
        } else {
            progress = new VideoProgress({
                user: userId,
                courseId,
                contentId,
                watchedSeconds: watchedSeconds || 0,
                totalDuration: totalDuration || 0,
                lastPosition: lastPosition || 0,
                completed: watchedSeconds > 0 && totalDuration > 0 && (watchedSeconds / totalDuration) >= 0.9
            });
            await progress.save();
        }

        res.json({ success: true, progress });
    } catch (err) {
        console.error("Progress Save Error:", err);
        res.status(500).json({ message: "Server Error" });
    }
});

// Mark video as complete
router.post('/progress/complete', requireAuth, async (req, res) => {
    try {
        const { courseId, contentId } = req.body;
        const userId = req.user._id;

        const progress = await VideoProgress.findOneAndUpdate(
            { user: userId, courseId, contentId },
            { 
                $set: { 
                    completed: true, 
                    lastWatchedAt: new Date(),
                    watchedSeconds: 999999 
                } 
            },
            { upsert: true, new: true }
        );

        res.json({ success: true, progress });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// Get progress for a course (all videos)
router.get('/progress/:courseId', requireAuth, async (req, res) => {
    try {
        const userId = req.user._id;
        const courseId = req.params.courseId;

        const progress = await VideoProgress.find({ user: userId, courseId });
        
        // Calculate course-level stats
        const totalVideos = await BiteSizeCourse.aggregate([
            { $match: { _id: new mongoose.Types.ObjectId(courseId) } },
            { $project: { totalVideos: { $size: "$content" } } }
        ]);

        const completedCount = progress.filter(p => p.completed).length;
        const totalCount = totalVideos[0]?.totalVideos || 0;
        const courseProgress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

        res.json({
            success: true,
            progress,
            stats: {
                completedVideos: completedCount,
                totalVideos: totalCount,
                courseProgress
            }
        });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// Get progress for most recently watched course (for Continue Watching)
router.get('/progress/recent/continue', requireAuth, async (req, res) => {
    try {
        const userId = req.user._id;

        const recentProgress = await VideoProgress.aggregate([
            { $match: { user: new mongoose.Types.ObjectId(userId) } },
            { $sort: { lastWatchedAt: -1 } },
            {
                $group: {
                    _id: "$courseId",
                    lastWatchedAt: { $first: "$lastWatchedAt" },
                    lastContentId: { $first: "$contentId" },
                    lastPosition: { $first: "$lastPosition" },
                    completedVideos: { $sum: { $cond: ["$completed", 1, 0] } },
                    totalVideosCount: { $sum: 1 }
                }
            },
            { $sort: { lastWatchedAt: -1 } },
            { $limit: 5 },
            {
                $lookup: {
                    from: "bitesizecourses",
                    localField: "_id",
                    foreignField: "_id",
                    as: "course"
                }
            },
            { $unwind: "$course" },
            {
                $project: {
                    _id: 1,
                    courseTitle: "$course.title",
                    courseSlug: "$course.slug",
                    courseImage: "$course.image",
                    courseHighlight: "$course.highlight",
                    lastWatchedAt: 1,
                    lastContentId: 1,
                    lastPosition: 1,
                    completedVideos: 1,
                    totalVideos: { $size: "$course.content" },
                    progressPercent: {
                        $round: [
                            { $multiply: [{ $divide: ["$completedVideos", { $size: "$course.content" }] }, 100] },
                            0
                        ]
                    }
                }
            }
        ]);

        res.json({ success: true, courses: recentProgress });
    } catch (err) {
        console.error("Continue Watching Error:", err);
        res.status(500).json({ message: "Server Error" });
    }
});

// =====================================================
// 🔥 DAILY STREAK TRACKING
// =====================================================

// Log daily activity (called when user watches a video)
router.post('/streak/log', requireAuth, async (req, res) => {
    try {
        const userId = req.user._id;
        const user = await User.findById(userId);
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const lastActive = user.lastActiveDate ? new Date(user.lastActiveDate) : null;
        
        if (!lastActive || lastActive.getTime() !== today.getTime()) {
            // First activity today
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            
            if (lastActive && lastActive.getTime() === yesterday.getTime()) {
                // Consecutive day — increment streak
                user.currentStreak += 1;
            } else {
                // Streak broken or first time
                user.currentStreak = 1;
            }
            
            // Update longest streak
            if (user.currentStreak > user.longestStreak) {
                user.longestStreak = user.currentStreak;
            }
            
            user.lastActiveDate = today;
            await user.save();
        }
        
        res.json({
            success: true,
            streak: user.currentStreak,
            longestStreak: user.longestStreak
        });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// Get user's streak info
router.get('/streak', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('currentStreak longestStreak lastActiveDate');
        
        // Check if streak is still alive (within 2 days)
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const lastActive = user.lastActiveDate ? new Date(user.lastActiveDate) : null;
        
        let streakAlive = false;
        if (lastActive) {
            const diffDays = Math.floor((today - lastActive) / (1000 * 60 * 60 * 24));
            streakAlive = diffDays <= 1;
        }

        res.json({
            success: true,
            currentStreak: user.currentStreak,
            longestStreak: user.longestStreak,
            lastActiveDate: user.lastActiveDate,
            streakAlive
        });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// =====================================================
// 💬 COMMENTS
// =====================================================

// Get comments for a video
router.get('/comments/:courseId/:contentId', requireAuth, async (req, res) => {
    try {
        const { courseId, contentId } = req.params;
        
        const comments = await Comment.find({ courseId, contentId, parentComment: null })
            .populate('user', 'name')
            .sort({ createdAt: -1 })
            .limit(50);

        // Get reply counts for each comment
        const commentsWithReplies = await Promise.all(comments.map(async (comment) => {
            const replyCount = await Comment.countDocuments({ parentComment: comment._id });
            return {
                ...comment.toObject(),
                replyCount
            };
        }));

        res.json({ success: true, comments: commentsWithReplies });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// Add a comment
router.post('/comments/add', requireAuth, async (req, res) => {
    try {
        const { courseId, contentId, text, parentComment } = req.body;
        
        if (!text || !text.trim()) {
            return res.status(400).json({ message: "Comment text is required" });
        }

        const comment = new Comment({
            user: req.user._id,
            courseId,
            contentId,
            text: text.trim(),
            parentComment: parentComment || null
        });
        
        await comment.save();
        
        const populated = await Comment.populate(comment, { path: 'user', select: 'name' });

        res.status(201).json({ success: true, comment: populated });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// Delete a comment (own comment or admin)
router.delete('/comments/:commentId', requireAuth, async (req, res) => {
    try {
        const comment = await Comment.findById(req.params.commentId);
        if (!comment) return res.status(404).json({ message: "Comment not found" });
        
        if (comment.user.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
            return res.status(403).json({ message: "Not authorized" });
        }
        
        await Comment.deleteMany({ $or: [
            { _id: comment._id },
            { parentComment: comment._id }
        ]});
        
        res.json({ success: true, message: "Comment deleted" });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// =====================================================
// ⭐ RATINGS & REVIEWS
// =====================================================

// Submit a rating + review for a course
router.post('/review/:courseId', requireAuth, async (req, res) => {
    try {
        const { rating, comment } = req.body;
        const courseId = req.params.courseId;
        const userId = req.user._id;

        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ message: "Rating must be between 1 and 5" });
        }

        const course = await BiteSizeCourse.findById(courseId);
        if (!course) return res.status(404).json({ message: "Course not found" });

        // Check if user already reviewed
        const existingIndex = course.reviews.findIndex(
            r => r.user && r.user.toString() === userId.toString()
        );

        if (existingIndex >= 0) {
            // Update existing review
            course.reviews[existingIndex].rating = rating;
            course.reviews[existingIndex].comment = comment || '';
            course.reviews[existingIndex].createdAt = new Date();
        } else {
            // Add new review
            course.reviews.push({
                user: userId,
                rating,
                comment: comment || '',
                createdAt: new Date()
            });
        }

        // Recalculate average rating
        const totalRating = course.reviews.reduce((sum, r) => sum + r.rating, 0);
        course.averageRating = Math.round((totalRating / course.reviews.length) * 10) / 10;
        course.totalReviews = course.reviews.length;

        await course.save();

        res.json({
            success: true,
            averageRating: course.averageRating,
            totalReviews: course.totalReviews
        });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// Get reviews for a course
router.get('/reviews/:courseId', async (req, res) => {
    try {
        const course = await BiteSizeCourse.findById(req.params.courseId)
            .select('reviews averageRating totalReviews')
            .populate('reviews.user', 'name');

        if (!course) return res.status(404).json({ message: "Course not found" });

        res.json({
            success: true,
            reviews: course.reviews.sort((a, b) => b.createdAt - a.createdAt),
            averageRating: course.averageRating,
            totalReviews: course.totalReviews
        });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// =====================================================
// 🏆 COURSE COMPLETION BADGES
// =====================================================

// Check & assign completion badge
router.post('/check-completion/:courseId', requireAuth, async (req, res) => {
    try {
        const courseId = req.params.courseId;
        const userId = req.user._id;

        const course = await BiteSizeCourse.findById(courseId);
        if (!course) return res.status(404).json({ message: "Course not found" });

        const totalVideos = course.content.length;
        const completedVideos = await VideoProgress.countDocuments({
            user: userId,
            courseId,
            completed: true
        });

        // Check if all videos are completed
        if (completedVideos >= totalVideos && totalVideos > 0) {
            // Check if already completed
            const user = await User.findById(userId);
            const alreadyCompleted = user.completedCourses.some(
                c => c.courseId && c.courseId.toString() === courseId
            );

            if (!alreadyCompleted) {
                user.completedCourses.push({
                    courseId,
                    completedAt: new Date(),
                    badgeUrl: `https://api.dicebear.com/7.x/identicons/svg?seed=${course.title}&background=008a45`
                });
                await user.save();
            }

            return res.json({
                success: true,
                completed: true,
                totalVideos,
                completedVideos
            });
        }

        res.json({
            success: true,
            completed: false,
            totalVideos,
            completedVideos,
            remainingVideos: totalVideos - completedVideos
        });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// Get user's completion badges
router.get('/badges', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user._id)
            .select('completedCourses')
            .populate('completedCourses.courseId', 'title image');

        res.json({
            success: true,
            badges: user.completedCourses || []
        });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

module.exports = router;