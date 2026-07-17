const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const mongoose = require('mongoose');

// Models
const BiteSizeCourse = require('../models/BiteSizeCourse');
const User = require('../models/User');
const Order = require('../models/Order');
const Certificate = require('../models/Certificate');

const { requireAuth, adminOnly } = require('../middleware/auth');

const engagementLimiter = require('express-rate-limit')({
    windowMs: 60 * 1000,
    max: 30,
    message: { success: false, message: "Too many requests. Please slow down." }
});

const sanitizeString = (str) => {
    if (!str) return '';
    return str.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;').replace(/\//g, '&#x2F;').trim();
};

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ─── Helpers ───
const findModuleInCourse = (course, chapterId, moduleId) => {
    const chapter = course.chapters.id(chapterId);
    if (!chapter) return null;
    const mod = chapter.modules.id(moduleId);
    if (!mod) return null;
    return { chapter, module: mod };
};

// Auto-assign the last module in the last chapter as the certificate module
const reassignCertificateModule = (course) => {
    // Clear all certificate flags
    for (const ch of course.chapters) {
        for (const mod of ch.modules) {
            mod.isCertificateModule = false;
        }
    }
    // Find the very last module across all chapters
    const lastChapter = course.chapters[course.chapters.length - 1];
    if (lastChapter && lastChapter.modules.length > 0) {
        const lastModule = lastChapter.modules[lastChapter.modules.length - 1];
        lastModule.isCertificateModule = true;
    }
};

// Auto-create a certificate quiz module if the last module isn't already a quiz with questions
const ensureCertificateQuiz = (course) => {
    if (!course.chapters || course.chapters.length === 0) return;

    const lastChapter = course.chapters[course.chapters.length - 1];
    const lastModule = lastChapter.modules[lastChapter.modules.length - 1];

    // Check if the last module is already a valid certificate quiz
    if (lastModule && lastModule.type === 'quiz' && lastModule.questions && lastModule.questions.length > 0) {
        // It's a quiz with questions — just tag it as certificate
        reassignCertificateModule(course);
        return;
    }

    // Auto-create a certificate quiz module as the last module
    const certQuiz = {
        type: 'quiz',
        order: lastChapter.modules.length,
        isCertificateModule: true,
        questions: [{
            questionText: 'Thank you for completing this course! Type "YES" below to confirm and receive your certificate.',
            options: ['YES', 'NO'],
            correctAnswer: 'YES'
        }]
    };

    lastChapter.modules.push(certQuiz);
    reassignCertificateModule(course);
};

// Flatten all modules across chapters and compute totalLikes
const processCourseForFrontend = (course) => {
    const obj = course.toObject();
    const allModules = [];
    for (const ch of (obj.chapters || [])) {
        for (const mod of (ch.modules || [])) {
            allModules.push({
                ...mod,
                chapterId: ch._id,
                chapterTitle: ch.title,
                totalLikes: (mod.baseLikes || 0) + (mod.likes?.length || 0),
                isCertificateModule: mod.isCertificateModule || false,
                // Hide correct answers from client
                questions: mod.questions ? mod.questions.map(q => ({
                    _id: q._id,
                    questionText: q.questionText,
                    options: q.options
                })) : undefined
            });
        }
    }
    obj.flattenedModules = allModules;
    return obj;
};

// =====================================================
// 1. PUBLIC ROUTES
// =====================================================

router.get('/', async (req, res) => {
    try {
        const list = await BiteSizeCourse.find(
            { isLocked: false },
            '-chapters.modules.videoUrls -chapters.modules.correctAnswer'
        ).sort({ createdAt: -1 }).lean();
        res.json(list);
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

router.get('/:slug', async (req, res) => {
    try {
        const item = await BiteSizeCourse.findOne({ slug: req.params.slug })
            .select('-chapters.modules.videoUrls -chapters.modules.questions.correctAnswer')
            .lean();
        if (!item) return res.status(404).json({ message: "Course Not Found" });
        res.json(item);
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// =====================================================
// 2. SUBSCRIPTION CHECKOUT (unchanged)
// =====================================================

router.post('/create-checkout', requireAuth, async (req, res) => {
    try {
        const { planType } = req.body;
        const userId = req.user._id;
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: "User not found" });

        if (planType === 'trial' && user.biteSizeSubscription?.trialUsed === true) {
            return res.status(400).json({ message: "You have already used your Rs 1 trial limit. Please upgrade to a Monthly or Yearly plan." });
        }

        const planPrices = { trial: 1, monthly: 99, yearly: 599 };
        const amountToCharge = planPrices[planType];
        if (!amountToCharge) return res.status(400).json({ message: "Invalid Plan Type" });

        const order = await razorpay.orders.create({
            amount: Math.round(amountToCharge * 100),
            currency: "INR",
            receipt: 'sub_' + Date.now(),
            notes: { orderType: 'BiteSize Global Subscription' }
        });

        const newOrder = new Order({
            userId, itemModel: 'Subscription',
            basePrice: amountToCharge, amountPaid: amountToCharge,
            planType, paymentType: 'one-time',
            razorpayOrderId: order.id, status: 'pending'
        });
        await newOrder.save();

        res.json({ success: true, key_id: process.env.RAZORPAY_KEY_ID, order_id: order.id, amount: amountToCharge, description: 'BiteSize ' + planType.toUpperCase() + ' Access' });
    } catch (err) {
        console.error("Checkout Init Failed:", err);
        res.status(500).json({ message: "Payment Initialization Failed" });
    }
});

router.post('/verify-payment', requireAuth, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        const userId = req.user._id;

        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');
        if (expectedSignature !== razorpay_signature) return res.status(400).json({ success: false, message: "Invalid Payment Signature!" });

        const pendingOrder = await Order.findOne({ razorpayOrderId: razorpay_order_id });
        if (!pendingOrder || pendingOrder.status === 'paid') return res.status(400).json({ success: false, message: "Order not found or already processed" });
        if (pendingOrder.userId.toString() !== userId.toString()) return res.status(403).json({ message: "Forbidden" });

        pendingOrder.status = 'paid';
        pendingOrder.razorpayPaymentId = razorpay_payment_id;
        pendingOrder.razorpaySignature = razorpay_signature;
        pendingOrder.fulfilledVia = 'frontend:verify-payment';
        await pendingOrder.save();

        let daysToAdd = 0;
        if (pendingOrder.planType === 'trial') daysToAdd = 3;
        if (pendingOrder.planType === 'monthly') daysToAdd = 30;
        if (pendingOrder.planType === 'yearly') daysToAdd = 365;

        const user = await User.findById(userId);
        let currentExpiration = user.biteSizeSubscription?.expiresAt;
        let baseDate = (currentExpiration && new Date(currentExpiration) > new Date()) ? new Date(currentExpiration) : new Date();
        const newExpirationDate = new Date(baseDate.getTime() + (daysToAdd * 24 * 60 * 60 * 1000));
        const isTrialNow = pendingOrder.planType === 'trial';
        const wasTrialUsedBefore = user.biteSizeSubscription?.trialUsed || false;

        user.biteSizeSubscription = { status: 'active', planType: pendingOrder.planType, expiresAt: newExpirationDate, trialUsed: isTrialNow ? true : wasTrialUsedBefore };
        await user.save();

        res.json({ success: true, message: "Payment verified, subscription activated!" });
    } catch (err) {
        console.error("Verification Error:", err);
        res.status(500).json({ message: "Verification Error" });
    }
});

// =====================================================
// 3. PROTECTED CONTENT (SECURED)
// =====================================================

router.get('/content/:id', requireAuth, async (req, res) => {
    try {
        const courseId = req.params.id;
        const userId = req.user._id;
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: "User not found" });

        if (user.role !== 'admin') {
            let hasAccess = false;
            const isSubscribed = user.biteSizeSubscription?.status === 'active' && new Date(user.biteSizeSubscription?.expiresAt) > new Date();
            if (isSubscribed) hasAccess = true;
            else {
                const ownsSpecificCourse = user.enrolledCourses?.some(c => c.item.toString() === courseId && c.itemModel === 'BiteSizeCourse');
                if (ownsSpecificCourse) hasAccess = true;
            }
            if (!hasAccess) return res.status(403).json({ message: "Forbidden. Subscription required.", requiresSubscription: true });
        }

        const courseData = await BiteSizeCourse.findById(courseId);
        if (!courseData) return res.status(404).json({ message: "Course not found" });

        // Ensure certificate quiz exists as last module
        ensureCertificateQuiz(courseData);
        await courseData.save();

        const finalData = processCourseForFrontend(courseData);
        res.json(finalData);
    } catch (err) {
        console.error("Fetch Content Error:", err);
        res.status(500).json({ message: "Server Error" });
    }
});

// ─── Like a Module ───
router.post('/content/:courseId/chapter/:chapterId/module/:moduleId/like', requireAuth, engagementLimiter, async (req, res) => {
    try {
        const { courseId, chapterId, moduleId } = req.params;
        const userId = req.user._id;

        const course = await BiteSizeCourse.findById(courseId);
        if (!course) return res.status(404).json({ message: "Course not found" });

        const result = findModuleInCourse(course, chapterId, moduleId);
        if (!result) return res.status(404).json({ message: "Module not found" });

        const mod = result.module;
        const hasLiked = mod.likes.includes(userId);
        if (hasLiked) mod.likes.pull(userId);
        else mod.likes.push(userId);

        await course.save();

        const currentTotal = (mod.baseLikes || 0) + (mod.likes?.length || 0);
        res.json({ success: true, liked: !hasLiked, totalLikes: currentTotal });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// ─── Record a View ───
router.post('/content/:courseId/chapter/:chapterId/module/:moduleId/view', requireAuth, engagementLimiter, async (req, res) => {
    try {
        const { courseId, chapterId, moduleId } = req.params;

        await BiteSizeCourse.updateOne(
            { _id: courseId, "chapters._id": chapterId, "chapters.modules._id": moduleId, "chapters.modules.type": "video" },
            { $inc: { "chapters.$[c].modules.$[m].views": 1 } },
            {
                arrayFilters: [
                    { "c._id": new mongoose.Types.ObjectId(chapterId) },
                    { "m._id": new mongoose.Types.ObjectId(moduleId), "m.type": "video" }
                ]
            }
        );

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// =====================================================
// 4. QUIZ ANSWER & CERTIFICATE
// =====================================================

router.post('/content/:courseId/chapter/:chapterId/module/:moduleId/answer', requireAuth, async (req, res) => {
    try {
        const { courseId, chapterId, moduleId } = req.params;
        const { questionId, selectedOption } = req.body;

        const course = await BiteSizeCourse.findById(courseId);
        if (!course) return res.status(404).json({ message: "Course not found" });

        const result = findModuleInCourse(course, chapterId, moduleId);
        if (!result || result.module.type !== 'quiz') return res.status(404).json({ message: "Quiz module not found" });

        const question = result.module.questions.id(questionId);
        if (!question) return res.status(404).json({ message: "Question not found" });

        const isCorrect = selectedOption && selectedOption.trim() === question.correctAnswer.trim();
        res.json({ success: true, correct: !!isCorrect, correctAnswer: isCorrect ? undefined : question.correctAnswer });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// ─── Complete Course (when all quizzes passed) ───
router.post('/complete-course/:id', requireAuth, async (req, res) => {
    try {
        const courseId = req.params.id;
        const userId = req.user._id;
        const { customName } = req.body;
        const sanitizedName = sanitizeString(customName || req.user.name);

        const user = await User.findById(userId);
        const course = await BiteSizeCourse.findById(courseId);
        if (!course) return res.status(404).json({ message: "Course not found" });

        const existingCert = await Certificate.findOne({ user: userId, course: courseId });
        if (existingCert) {
            return res.json({ success: true, certificateUrl: existingCert.certificateUrl, message: "Certificate already issued" });
        }

        const uniqueCertId = 'CERT-BS-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
        const certificateLink = '/bitesize-certificate/' + uniqueCertId;

        const newCert = new Certificate({
            certificateId: uniqueCertId, user: userId,
            studentName: sanitizedName, phone: user.phone || "N/A",
            course: courseId, itemModel: 'BiteSizeCourse',
            courseName: course.title.toUpperCase() + ' ' + course.highlight,
            planType: 'standard', score: 100,
            issuedDate: new Date(), certificateUrl: certificateLink
        });
        await newCert.save();

        const updateResult = await User.updateOne(
            { _id: userId, "enrolledCourses.item": courseId },
            { $set: { "enrolledCourses.$.certificateUrl": certificateLink, "enrolledCourses.$.score": 100, "enrolledCourses.$.issuedDate": new Date(), "enrolledCourses.$.progress": 100 } }
        );

        if (updateResult.modifiedCount === 0) {
            await User.updateOne({ _id: userId }, { $push: { enrolledCourses: { item: courseId, itemModel: 'BiteSizeCourse', planType: 'subscription', paymentStatus: 'full', amountPaid: 0, purchasedAt: new Date(), progress: 100, certificateUrl: certificateLink, issuedDate: new Date(), score: 100 } } });
        }

        res.json({ success: true, certificateUrl: certificateLink });
    } catch (err) {
        console.error("Complete Course Error:", err);
        res.status(500).json({ message: "Server Error" });
    }
});

// =====================================================
// 5. ADMIN ROUTES
// =====================================================

const generateRandomLikes = () => Math.floor(Math.random() * (450 - 120 + 1) + 120);

router.get('/admin/all', adminOnly, async (req, res) => {
    try {
        const list = await BiteSizeCourse.find({}).sort({ createdAt: -1 }).lean();
        res.json(list);
    } catch (err) {
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

router.post('/admin/create', adminOnly, async (req, res) => {
    try {
        const payload = req.body;
        delete payload.content;
        delete payload.quiz;
        const newItem = new BiteSizeCourse(payload);
        await newItem.save();
        res.status(201).json({ message: "Created", course: newItem });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.put('/admin/update/:id', adminOnly, async (req, res) => {
    try {
        const payload = req.body;
        delete payload.content;
        delete payload.quiz;
        delete payload.chapters;
        const updated = await BiteSizeCourse.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
        res.json({ message: "Updated", course: updated });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.delete('/admin/delete/:id', adminOnly, async (req, res) => {
    try {
        await BiteSizeCourse.findByIdAndDelete(req.params.id);
        res.json({ message: "Deleted" });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// ─── Admin: Chapter CRUD ───

router.post('/admin/:courseId/chapter', adminOnly, async (req, res) => {
    try {
        const { courseId } = req.params;
        const { title, description } = req.body;
        if (!title) return res.status(400).json({ message: "Chapter title required" });

        const course = await BiteSizeCourse.findById(courseId);
        if (!course) return res.status(404).json({ message: "Course not found" });

        const order = course.chapters.length;
        course.chapters.push({ title, description, order, modules: [] });
        // Ensure certificate quiz exists as last module
        ensureCertificateQuiz(course);
        await course.save();

        res.status(201).json({ message: "Chapter added", course });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.put('/admin/:courseId/chapter/:chapterId', adminOnly, async (req, res) => {
    try {
        const { courseId, chapterId } = req.params;
        const { title, description } = req.body;

        const course = await BiteSizeCourse.findById(courseId);
        if (!course) return res.status(404).json({ message: "Course not found" });

        const chapter = course.chapters.id(chapterId);
        if (!chapter) return res.status(404).json({ message: "Chapter not found" });

        if (title) chapter.title = title;
        if (description !== undefined) chapter.description = description;
        await course.save();

        res.json({ message: "Chapter updated", course });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.delete('/admin/:courseId/chapter/:chapterId', adminOnly, async (req, res) => {
    try {
        const { courseId, chapterId } = req.params;

        const course = await BiteSizeCourse.findById(courseId);
        if (!course) return res.status(404).json({ message: "Course not found" });

        course.chapters.pull({ _id: chapterId });
        // Fix ordering
        course.chapters.forEach((ch, i) => ch.order = i);
        // Ensure certificate quiz exists as last module
        ensureCertificateQuiz(course);
        await course.save();

        res.json({ message: "Chapter deleted", course });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// ─── Admin: Module CRUD ───

router.post('/admin/:courseId/chapter/:chapterId/module', adminOnly, async (req, res) => {
    try {
        const { courseId, chapterId } = req.params;
        const { type, title, description, thumbnail, videoUrls, questions } = req.body;
        if (!type || !['video', 'quiz'].includes(type)) return res.status(400).json({ message: "Module type required (video or quiz)" });

        const course = await BiteSizeCourse.findById(courseId);
        if (!course) return res.status(404).json({ message: "Course not found" });

        const chapter = course.chapters.id(chapterId);
        if (!chapter) return res.status(404).json({ message: "Chapter not found" });

        let newModule = { type, order: chapter.modules.length };

        if (type === 'video') {
            newModule.title = title || '';
            newModule.description = description || '';
            newModule.thumbnail = thumbnail || '';
            newModule.videoUrls = videoUrls || { bn: '', en: '', hi: '' };
            newModule.baseLikes = generateRandomLikes();
            newModule.views = 0;
            newModule.likes = [];
        } else if (type === 'quiz') {
            newModule.questions = (questions || []).map((q, i) => ({
                questionText: q.questionText || 'Question ' + (i + 1),
                options: q.options || ['', '', '', ''],
                correctAnswer: q.correctAnswer || ''
            }));
        }

        chapter.modules.push(newModule);
        // Auto-create/assign certificate quiz as the last module
        ensureCertificateQuiz(course);
        await course.save();

        res.status(201).json({ message: "Module added", course });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.delete('/admin/:courseId/chapter/:chapterId/module/:moduleId', adminOnly, async (req, res) => {
    try {
        const { courseId, chapterId, moduleId } = req.params;

        const course = await BiteSizeCourse.findById(courseId);
        if (!course) return res.status(404).json({ message: "Course not found" });

        const chapter = course.chapters.id(chapterId);
        if (!chapter) return res.status(404).json({ message: "Chapter not found" });

        chapter.modules.pull({ _id: moduleId });
        chapter.modules.forEach((m, i) => m.order = i);
        // Re-create/assign certificate quiz as the last module
        ensureCertificateQuiz(course);
        await course.save();

        res.json({ message: "Module deleted", course });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// ─── Admin: Subscription Stats ───
router.get('/admin/subscription-stats', adminOnly, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const skip = (page - 1) * limit;

        const totalSubscribed = await User.countDocuments({ "biteSizeSubscription.planType": { $in: ['trial', 'monthly', 'yearly'] } });
        const users = await User.find({ "biteSizeSubscription.planType": { $in: ['trial', 'monthly', 'yearly'] } })
            .select('name phone biteSizeSubscription').sort({ createdAt: -1 }).skip(skip).limit(limit).lean();

        let stats = {
            yearly: { _id: 'yearly', title: "Yearly Subscriptions", enrolledCount: 0, activeCount: 0, students: [] },
            monthly: { _id: 'monthly', title: "Monthly Subscriptions", enrolledCount: 0, activeCount: 0, students: [] },
            trial: { _id: 'trial', title: "Rs 1 Trial Users", enrolledCount: 0, activeCount: 0, students: [] }
        };

        const now = new Date();
        users.forEach(user => {
            const sub = user.biteSizeSubscription;
            if (!sub || sub.planType === 'none') return;
            const isActive = sub.status === 'active' && new Date(sub.expiresAt) > now;
            const group = stats[sub.planType];
            if (group) {
                group.enrolledCount += 1;
                if (isActive) group.activeCount += 1;
                group.students.push({ name: user.name, phone: user.phone, status: isActive ? 'Active' : 'Expired', expiresAt: sub.expiresAt, trialUsed: sub.trialUsed });
            }
        });

        const statsArray = [stats.yearly, stats.monthly, stats.trial].filter(g => g.enrolledCount > 0);
        statsArray.forEach(group => {
            group.students.sort((a, b) => {
                if (a.status === b.status) return new Date(b.expiresAt) - new Date(a.expiresAt);
                return a.status === 'Active' ? -1 : 1;
            });
        });

        res.json({ success: true, stats: statsArray, pagination: { total: totalSubscribed, currentPage: page, totalPages: Math.ceil(totalSubscribed / limit), hasMore: page * limit < totalSubscribed } });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

module.exports = router;
