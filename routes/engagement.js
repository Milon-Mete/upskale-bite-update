const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const VideoProgress = require('../models/VideoProgress');
const Comment = require('../models/Comment');
const BiteSizeCourse = require('../models/BiteSizeCourse');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');

const engagementLimiter = require('express-rate-limit')({
    windowMs: 60 * 1000,
    max: 60,
    message: { success: false, message: "Too many requests. Please slow down." },
    standardHeaders: true,
    legacyHeaders: false,
});

// =====================================================
// 📊 VIDEO MODULE PROGRESS TRACKING
// =====================================================

// Save video module progress
router.post('/progress/save', requireAuth, engagementLimiter, async (req, res) => {
    try {
        const { courseId, chapterId, moduleId, moduleType, watchedSeconds, totalDuration, lastPosition } = req.body;
        const userId = req.user._id;

        if (!courseId || !chapterId || !moduleId) {
            return res.status(400).json({ message: "courseId, chapterId, and moduleId are required" });
        }

        let progress = await VideoProgress.findOne({ user: userId, courseId, chapterId, moduleId });

        if (progress) {
            progress.watchedSeconds = Math.max(progress.watchedSeconds, watchedSeconds || 0);
            progress.totalDuration = totalDuration || progress.totalDuration;
            progress.lastPosition = lastPosition !== undefined ? lastPosition : progress.lastPosition;
            progress.moduleType = moduleType || 'video';
            progress.lastWatchedAt = new Date();

            if (progress.totalDuration > 0 && (progress.watchedSeconds / progress.totalDuration) >= 0.9) {
                progress.completed = true;
            }

            await progress.save();
        } else {
            progress = new VideoProgress({
                user: userId,
                courseId,
                chapterId,
                moduleId,
                moduleType: moduleType || 'video',
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

// Mark module as complete
router.post('/progress/complete', requireAuth, async (req, res) => {
    try {
        const { courseId, chapterId, moduleId, moduleType } = req.body;
        const userId = req.user._id;

        const progress = await VideoProgress.findOneAndUpdate(
            { user: userId, courseId, chapterId, moduleId },
            {
                $set: {
                    completed: true,
                    moduleType: moduleType || 'video',
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

// =====================================================
// 📊 QUIZ MODULE PROGRESS TRACKING
// =====================================================

// Track a single quiz question answer attempt
router.post('/progress/quiz-answer', requireAuth, async (req, res) => {
    try {
        const { courseId, chapterId, moduleId, questionId, correct } = req.body;
        const userId = req.user._id;

        if (!courseId || !chapterId || !moduleId || !questionId) {
            return res.status(400).json({ message: "Missing required fields: courseId, chapterId, moduleId, questionId" });
        }

        // Validate and convert IDs to ObjectId
        const cId = new mongoose.Types.ObjectId(courseId);
        const chId = new mongoose.Types.ObjectId(chapterId);
        const mId = new mongoose.Types.ObjectId(moduleId);
        const qId = new mongoose.Types.ObjectId(questionId);

        let progress = await VideoProgress.findOne({ user: userId, courseId: cId, chapterId: chId, moduleId: mId });

        if (!progress) {
            progress = new VideoProgress({
                user: userId,
                courseId: cId,
                chapterId: chId,
                moduleId: mId,
                moduleType: 'quiz',
                answeredQuestions: []
            });
        }

        progress.moduleType = 'quiz';

        // Ensure answeredQuestions is initialized
        if (!progress.answeredQuestions) {
            progress.answeredQuestions = [];
        }

        // Update or add the question answer
        const existingIndex = progress.answeredQuestions.findIndex(
            aq => aq.questionId && aq.questionId.toString() === questionId
        );

        if (existingIndex >= 0) {
            progress.answeredQuestions[existingIndex].correct = correct;
        } else {
            progress.answeredQuestions.push({ questionId: qId, correct });
        }

        // Check if all questions in the module are answered correctly
        const course = await BiteSizeCourse.findById(courseId);
        if (course && course.chapters && course.chapters.length > 0) {
            const chapter = course.chapters.id(chapterId);
            if (chapter && chapter.modules && chapter.modules.length > 0) {
                const quizModule = chapter.modules.id(moduleId);
                if (quizModule && quizModule.type === 'quiz' && quizModule.questions) {
                    const totalQuestions = quizModule.questions.length;
                    const correctAnswers = (progress.answeredQuestions || []).filter(aq => aq.correct).length;
                    
                    progress.watchedSeconds = correctAnswers;
                    progress.totalDuration = totalQuestions;
                    
                    if (correctAnswers >= totalQuestions && totalQuestions > 0) {
                        progress.completed = true;
                    }
                }
            }
        }

        progress.lastWatchedAt = new Date();
        await progress.save();

        res.json({ success: true, progress });
    } catch (err) {
        console.error("Quiz Progress Error:", err);
        res.status(500).json({ message: "Server Error: " + err.message });
    }
});

// =====================================================
// 📊 GENERAL PROGRESS QUERIES
// =====================================================

// Get progress for a course (all modules)
router.get('/progress/:courseId', requireAuth, async (req, res) => {
    try {
        const userId = req.user._id;
        const courseId = req.params.courseId;

        const progress = await VideoProgress.find({ user: userId, courseId });

        // Calculate course-level stats
        const course = await BiteSizeCourse.findById(courseId).lean();
        let totalModules = 0;
        let videoModules = 0;
        let quizModules = 0;

        if (course && course.chapters) {
            course.chapters.forEach(ch => {
                if (ch.modules) {
                    ch.modules.forEach(m => {
                        totalModules++;
                        if (m.type === 'video') videoModules++;
                        if (m.type === 'quiz') quizModules++;
                    });
                }
            });
        }

        const completedCount = progress.filter(p => p.completed).length;
        const courseProgress = totalModules > 0 ? Math.round((completedCount / totalModules) * 100) : 0;

        res.json({
            success: true,
            progress,
            stats: {
                completedModules: completedCount,
                totalModules,
                videoModules,
                quizModules,
                courseProgress
            }
        });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// Get Continue Watching courses
router.get('/progress/recent/continue', requireAuth, async (req, res) => {
    try {
        const userId = req.user._id;

        let recentProgress = await VideoProgress.aggregate([
            { $match: { user: new mongoose.Types.ObjectId(userId) } },
            { $sort: { lastWatchedAt: -1 } },
            // ── Stage 1: Group by course + chapter for per-chapter stats ──
            {
                $group: {
                    _id: { courseId: "$courseId", chapterId: "$chapterId" },
                    lastWatchedAt: { $first: "$lastWatchedAt" },
                    lastModuleId: { $first: "$moduleId" },
                    lastChapterId: { $first: "$chapterId" },
                    lastPosition: { $first: "$lastPosition" },
                    completedModulesInChapter: { $sum: { $cond: ["$completed", 1, 0] } },
                    totalModulesInChapter: { $sum: 1 },
                    completedVideosCount: { $sum: { $cond: [{ $and: ["$completed", { $eq: [{ $ifNull: ["$moduleType", "video"] }, "video"] }] }, 1, 0] } }
                }
            },
            // ── Stage 2: Flag chapters where ALL modules are completed ──
            {
                $addFields: {
                    chapterCompleted: {
                        $and: [
                            { $gt: ["$totalModulesInChapter", 0] },
                            { $eq: ["$completedModulesInChapter", "$totalModulesInChapter"] }
                        ]
                    }
                }
            },
            { $sort: { lastWatchedAt: -1 } },
            // ── Stage 3: Group by courseId to aggregate chapters & modules ──
            {
                $group: {
                    _id: "$_id.courseId",
                    lastWatchedAt: { $first: "$lastWatchedAt" },
                    lastModuleId: { $first: "$lastModuleId" },
                    lastChapterId: { $first: "$lastChapterId" },
                    lastPosition: { $first: "$lastPosition" },
                    completedModules: { $sum: "$completedModulesInChapter" },
                    totalModulesCount: { $sum: "$totalModulesInChapter" },
                    completedChapters: { $sum: { $cond: ["$chapterCompleted", 1, 0] } },
                    completedVideos: { $sum: "$completedVideosCount" }
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
            // ── Compute totals from course data (using only proven safe expressions) ──
            {
                $addFields: {
                    totalModules: {
                        $reduce: {
                            input: "$course.chapters",
                            initialValue: 0,
                            in: { $add: ["$$value", { $size: { $ifNull: ["$$this.modules", []] } }] }
                        }
                    },
                    totalChapters: { $size: { $ifNull: ["$course.chapters", []] } }
                }
            },
            {
                $project: {
                    _id: 1,
                    courseTitle: "$course.title",
                    courseSlug: "$course.slug",
                    courseImage: "$course.image",
                    courseHighlight: "$course.highlight",
                    lastWatchedAt: 1,
                    lastModuleId: 1,
                    lastChapterId: 1,
                    lastPosition: 1,
                    completedModules: 1,
                    totalModules: 1,
                    totalChapters: 1,
                    completedChapters: 1,
                    completedVideos: 1,
                    progressPercent: {
                        $let: {
                            vars: {
                                total: {
                                    $reduce: {
                                        input: "$course.chapters",
                                        initialValue: 0,
                                        in: { $add: ["$$value", { $size: { $ifNull: ["$$this.modules", []] } }] }
                                    }
                                }
                            },
                            in: {
                                $cond: {
                                    if: { $gt: ["$$total", 0] },
                                    then: { $round: [{ $multiply: [{ $divide: ["$completedModules", "$$total"] }, 100] }, 0] },
                                    else: 0
                                }
                            }
                        }
                    }
                }
            }
        ]);

        // ── Enrich with video-only counts (computed in JS for reliability) ──
        const courseIds = recentProgress.map(c => c._id);
        const courses = await BiteSizeCourse.find({ _id: { $in: courseIds } }).lean();
        const courseMap = {};
        courses.forEach(c => { courseMap[c._id.toString()] = c; });

        recentProgress = recentProgress.map(course => {
            const fullCourse = courseMap[course._id.toString()];
            let totalVideos = 0;
            let completedVideos = course.completedVideos || 0;

            if (fullCourse && fullCourse.chapters) {
                fullCourse.chapters.forEach(ch => {
                    if (ch.modules) {
                        ch.modules.forEach(m => {
                            if (m.type === 'video') totalVideos++;
                        });
                    }
                });
            }

            return {
                ...course,
                totalVideos,
                completedVideos
            };
        });

        res.json({ success: true, courses: recentProgress });
    } catch (err) {
        console.error("Continue Watching Error:", err);
        res.status(500).json({ message: "Server Error" });
    }
});

// =====================================================
// 📝 FEEDBACK (Admin-only View, Student Submit)
// =====================================================

// Submit feedback (any authenticated user)
router.post('/feedback/add', requireAuth, async (req, res) => {
    try {
        const { courseId, text } = req.body;

        if (!text || !text.trim()) {
            return res.status(400).json({ message: "Feedback text is required" });
        }
        if (!courseId) {
            return res.status(400).json({ message: "Course ID is required" });
        }

        const feedback = new Comment({
            user: req.user._id,
            courseId,
            text: text.trim(),
            isFeedback: true,
            parentComment: null
        });

        await feedback.save();

        const populated = await Comment.populate(feedback, { path: 'user', select: 'name' });

        res.status(201).json({ success: true, feedback: populated });
    } catch (err) {
        console.error("Feedback Submit Error:", err);
        res.status(500).json({ message: "Server Error" });
    }
});

// Get all feedback (admin only)
router.get('/feedback/:courseId', requireAuth, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ message: "Forbidden: Admins only." });
        }

        const { courseId } = req.params;

        const feedback = await Comment.find({ courseId, isFeedback: true })
            .populate('user', 'name')
            .sort({ createdAt: -1 })
            .limit(100)
            .lean();

        res.json({ success: true, feedback });
    } catch (err) {
        console.error("Feedback Fetch Error:", err);
        res.status(500).json({ message: "Server Error" });
    }
});

// Get all feedback across all courses (admin only)
router.get('/feedback/admin/all', requireAuth, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ message: "Forbidden: Admins only." });
        }

        const feedback = await Comment.find({ isFeedback: true })
            .populate('user', 'name')
            .populate('courseId', 'title slug image')
            .sort({ createdAt: -1 })
            .limit(200)
            .lean();

        // Group feedback by course
        const grouped = {};
        feedback.forEach(fb => {
            const courseId = fb.courseId?._id?.toString() || 'unknown';
            if (!grouped[courseId]) {
                grouped[courseId] = {
                    course: fb.courseId || { title: 'Unknown Course', _id: courseId },
                    feedback: []
                };
            }
            grouped[courseId].feedback.push(fb);
        });

        const result = Object.values(grouped).sort((a, b) => b.feedback.length - a.feedback.length);

        res.json({ success: true, courses: result, totalFeedback: feedback.length });
    } catch (err) {
        console.error("Feedback Admin Fetch Error:", err);
        res.status(500).json({ message: "Server Error" });
    }
});

// Delete feedback (admin only)
router.delete('/feedback/:feedbackId', requireAuth, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ message: "Forbidden: Admins only." });
        }

        const feedback = await Comment.findById(req.params.feedbackId);
        if (!feedback) return res.status(404).json({ message: "Feedback not found" });

        await Comment.deleteOne({ _id: feedback._id });

        res.json({ success: true, message: "Feedback deleted" });
    } catch (err) {
        console.error("Feedback Delete Error:", err);
        res.status(500).json({ message: "Server Error" });
    }
});

// =====================================================
// 🔥 DAILY STREAK TRACKING
// =====================================================

router.post('/streak/log', requireAuth, async (req, res) => {
    try {
        const userId = req.user._id;
        const user = await User.findById(userId);

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const lastActive = user.lastActiveDate ? new Date(user.lastActiveDate) : null;

        if (!lastActive || lastActive.getTime() !== today.getTime()) {
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);

            if (lastActive && lastActive.getTime() === yesterday.getTime()) {
                user.currentStreak += 1;
            } else {
                user.currentStreak = 1;
            }

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

router.get('/streak', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('currentStreak longestStreak lastActiveDate');

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
// 💬 COMMENTS (Updated for module-level)
// =====================================================

router.get('/comments/:courseId/:moduleId', requireAuth, async (req, res) => {
    try {
        const { courseId, moduleId } = req.params;

        const comments = await Comment.find({ courseId, contentId: moduleId, parentComment: null })
            .populate('user', 'name')
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();

        const commentsWithReplies = await Promise.all(comments.map(async (comment) => {
            const replyCount = await Comment.countDocuments({ parentComment: comment._id });
            return { ...comment, replyCount };
        }));

        res.json({ success: true, comments: commentsWithReplies });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

router.post('/comments/add', requireAuth, async (req, res) => {
    try {
        const { courseId, moduleId, text, parentComment } = req.body;

        if (!text || !text.trim()) {
            return res.status(400).json({ message: "Comment text is required" });
        }

        const comment = new Comment({
            user: req.user._id,
            courseId,
            contentId: moduleId,
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
// ⭐ RATINGS & REVIEWS (Unchanged)
// =====================================================

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

        const existingIndex = course.reviews.findIndex(
            r => r.user && r.user.toString() === userId.toString()
        );

        if (existingIndex >= 0) {
            course.reviews[existingIndex].rating = rating;
            course.reviews[existingIndex].comment = comment || '';
            course.reviews[existingIndex].createdAt = new Date();
        } else {
            course.reviews.push({
                user: userId,
                rating,
                comment: comment || '',
                createdAt: new Date()
            });
        }

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

router.get('/reviews/:courseId', async (req, res) => {
    try {
        const course = await BiteSizeCourse.findById(req.params.courseId)
            .select('reviews averageRating totalReviews')
            .populate('reviews.user', 'name')
            .lean();

        if (!course) return res.status(404).json({ message: "Course not found" });

        const sortedReviews = (course.reviews || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        res.json({
            success: true,
            reviews: sortedReviews,
            averageRating: course.averageRating,
            totalReviews: course.totalReviews
        });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// =====================================================
// 🏆 COURSE COMPLETION BADGES (Updated for chapters/modules)
// =====================================================

router.post('/check-completion/:courseId', requireAuth, async (req, res) => {
    try {
        const courseId = req.params.courseId;
        const userId = req.user._id;

        const course = await BiteSizeCourse.findById(courseId).lean();
        if (!course) return res.status(404).json({ message: "Course not found" });

        // Count total modules (both video and quiz)
        let totalModules = 0;
        if (course.chapters) {
            course.chapters.forEach(ch => {
                if (ch.modules) totalModules += ch.modules.length;
            });
        }

        const completedModules = await VideoProgress.countDocuments({
            user: userId,
            courseId,
            completed: true
        });

        if (completedModules >= totalModules && totalModules > 0) {
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
                totalModules,
                completedModules
            });
        }

        res.json({
            success: true,
            completed: false,
            totalModules,
            completedModules,
            remainingModules: totalModules - completedModules
        });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

router.get('/badges', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user._id)
            .select('completedCourses')
            .populate('completedCourses.courseId', 'title image')
            .lean();

        res.json({
            success: true,
            badges: (user?.completedCourses || []).filter(b => b.courseId)
        });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

module.exports = router;
