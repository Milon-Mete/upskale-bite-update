const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');

// Models
const BiteSizeCourse = require('../models/BiteSizeCourse');
const User = require('../models/User');
const Order = require('../models/Order');
const Certificate = require('../models/Certificate'); 

// 🔴 SECURE MIDDLEWARE IMPORTED
const { requireAuth, adminOnly } = require('../middleware/auth'); 

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// =====================================================
// 1. PUBLIC ROUTES (Slider & Course Page)
// =====================================================

router.get('/', async (req, res) => {
    try {
        const list = await BiteSizeCourse.find(
            { isLocked: false },
            '-content -quiz' // Hide premium content and quiz details from public list
        ).sort({ createdAt: -1 });
        
        res.json(list);
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

router.get('/:slug', async (req, res) => {
    try {
        const item = await BiteSizeCourse.findOne({ slug: req.params.slug })
            // 🔴 ANTI-CHEAT FIXED: Hide both old `videoUrl` AND new multi-language `videoUrls`
            .select('-content.videoUrl -content.videoUrls -quiz.questions.correctAnswer'); 

        if (!item) return res.status(404).json({ message: "Course Not Found" });

        res.json(item);
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// =====================================================
// 2. DIRECT CHECKOUT (SECURED)
// =====================================================

// 🔴 NEW SUBSCRIPTION CHECKOUT
// =====================================================
// 2. SUBSCRIPTION CHECKOUT (SECURED)
// =====================================================

router.post('/create-checkout', requireAuth, async (req, res) => {
    try {
        const { planType } = req.body; // Expects: 'trial', 'monthly', or 'yearly'
        const userId = req.user._id; 

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: "User not found" });

        // 🔴 ANTI-ABUSE: Block the ₹1 trial if they have already used it in their lifetime
        if (planType === 'trial' && user.biteSizeSubscription?.trialUsed === true) {
    return res.status(400).json({ // ✅ FIXED
        message: "You have already used your ₹1 trial limit. Please upgrade to a Monthly or Yearly plan." 
    });
}

        // 🔴 HARDCODED PRICING: Never trust the frontend to send the price.
        const planPrices = {
            trial: 1,      // 1 INR
            monthly: 99,   // 99 INR
            yearly: 599    // 599 INR
        };

        const amountToCharge = planPrices[planType];
        if (!amountToCharge) return res.status(400).json({ message: "Invalid Plan Type" });

        // Create Order in Razorpay
        const order = await razorpay.orders.create({
            amount: Math.round(amountToCharge * 100), 
            currency: "INR",
            receipt: `sub_${Date.now()}`,
            notes: { orderType: 'BiteSize Global Subscription' }
        });

        // Save Pending Order in your Database
const newOrder = new Order({
    userId,
    itemModel: 'Subscription',
    basePrice: amountToCharge,   // ✅
    amountPaid: amountToCharge,  // ✅ was missing — you wrote 'amount' by mistake
    planType: planType,
    paymentType: 'one-time',
    razorpayOrderId: order.id,
    status: 'pending'
});
        await newOrder.save();

        res.json({
            success: true,
            key_id: process.env.RAZORPAY_KEY_ID,
            order_id: order.id,
            amount: amountToCharge,
            description: `BiteSize ${planType.toUpperCase()} Access`
        });

    } catch (err) {
        console.error("Checkout Init Failed:", err);
        res.status(500).json({ message: "Payment Initialization Failed" });
    }
});

router.post('/verify-payment', requireAuth, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        const userId = req.user._id; 

        // 1. Verify Razorpay Signature (Security Check)
        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ success: false, message: "Invalid Payment Signature!" });
        }

        // 2. Validate Order Exists and belongs to this user
        const pendingOrder = await Order.findOne({ razorpayOrderId: razorpay_order_id });
        if (!pendingOrder || pendingOrder.status === 'paid') {
            return res.status(400).json({ success: false, message: "Order not found or already processed" });
        }

        if (pendingOrder.userId.toString() !== userId.toString()) {
            return res.status(403).json({ message: "Forbidden: Order does not belong to this user." });
        }

        // 3. Mark Order as Paid
        pendingOrder.status = 'paid';
        pendingOrder.razorpayPaymentId = razorpay_payment_id;
        pendingOrder.razorpaySignature = razorpay_signature;
        pendingOrder.fulfilledVia = 'frontend:verify-payment';
        await pendingOrder.save();

        // 4. Time-Math: Figure out how many days they just bought
        let daysToAdd = 0;
        if (pendingOrder.planType === 'trial') daysToAdd = 3;
        if (pendingOrder.planType === 'monthly') daysToAdd = 30;
        if (pendingOrder.planType === 'yearly') daysToAdd = 365;

        const user = await User.findById(userId);
        
        // 5. Calculate New Expiration Date
        // If they already have an active subscription, add this new time to the END of it.
        // Otherwise, start the clock from right now.
        let currentExpiration = user.biteSizeSubscription?.expiresAt;
        let baseDate = (currentExpiration && new Date(currentExpiration) > new Date()) 
            ? new Date(currentExpiration) 
            : new Date();

        const newExpirationDate = new Date(baseDate.getTime() + (daysToAdd * 24 * 60 * 60 * 1000));

        // 6. Update the User Profile
        const isTrialNow = pendingOrder.planType === 'trial';
        const wasTrialUsedBefore = user.biteSizeSubscription?.trialUsed || false;

        user.biteSizeSubscription = {
            status: 'active',
            planType: pendingOrder.planType,
            expiresAt: newExpirationDate,
            // 🔴 If they just bought the trial, burn the ticket (set to true).
            trialUsed: isTrialNow ? true : wasTrialUsedBefore 
        };
        
        await user.save();

        // Note: We removed the 'enrolledCount' increment logic because they are buying a global pass, not a specific course.

        res.json({ success: true, message: "Payment verified, subscription activated!" });

    } catch (err) {
        console.error("Verification Error:", err);
        res.status(500).json({ message: "Verification Error" });
    }
});

// =====================================================
// 4. PROTECTED CONTENT & ENGAGEMENT ROUTES (SECURED)
// =====================================================

// Fetch the actual videos
router.get('/content/:id', requireAuth, async (req, res) => {
    try {
        const courseId = req.params.id;
        const userId = req.user._id; 

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: "User not found" });

        // Admins bypass ownership checks
        if (user.role !== 'admin') {
            let hasAccess = false;
            const isSubscribed = user.biteSizeSubscription?.status === 'active' && 
                                 new Date(user.biteSizeSubscription?.expiresAt) > new Date();

            if (isSubscribed) {
                hasAccess = true;
            } else {
                const ownsSpecificCourse = user.enrolledCourses?.some(
                    c => c.item.toString() === courseId && c.itemModel === 'BiteSizeCourse'
                );
                if (ownsSpecificCourse) hasAccess = true;
            }

            if (!hasAccess) {
                return res.status(403).json({ message: "Forbidden. Subscription required.", requiresSubscription: true });
            }
        }

        const courseData = await BiteSizeCourse.findById(courseId).select('-quiz.questions.correctAnswer'); 
        if (!courseData) return res.status(404).json({ message: "Course not found" });

        // 🔴 THE FIX: Calculate totalLikes for the frontend player
        const processedContent = courseData.content.map(video => {
            const videoObj = video.toObject();
            videoObj.totalLikes = (videoObj.baseLikes || 0) + (videoObj.likes?.length || 0);
            return videoObj;
        });

        const finalData = courseData.toObject();
        finalData.content = processedContent;

        res.json(finalData);
        
    } catch (err) {
        console.error("Fetch Content Error:", err);
        res.status(500).json({ message: "Server Error" });
    }
});

// Toggle Like
router.post('/content/:courseId/like/:contentId', requireAuth, async (req, res) => {
    try {
        const { courseId, contentId } = req.params;
        const userId = req.user._id;

        const course = await BiteSizeCourse.findById(courseId);
        if (!course) return res.status(404).json({ message: "Course not found" });

        const video = course.content.id(contentId);
        if (!video) return res.status(404).json({ message: "Video not found" });

        const hasLiked = video.likes.includes(userId);
        
        if (hasLiked) {
            video.likes.pull(userId);
        } else {
            video.likes.push(userId);
        }

        await course.save();

        // 🔴 Return the boosted total back to the frontend so it doesn't flicker
        const currentTotal = (video.baseLikes || 0) + (video.likes?.length || 0);
        res.json({ success: true, liked: !hasLiked, totalLikes: currentTotal });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// Record a view for analytics
router.post('/content/:courseId/view/:contentId', requireAuth, async (req, res) => {
    try {
        const { courseId, contentId } = req.params;

        await BiteSizeCourse.updateOne(
            { _id: courseId, "content._id": contentId },
            { $inc: { "content.$.views": 1 } }
        );

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// =====================================================
// 5. AUTOMATED QUIZ & CERTIFICATE ISSUANCE (SECURED)
// =====================================================

router.post('/submit-quiz/:id', requireAuth, async (req, res) => {
    try {
        const courseId = req.params.id;
        const userId = req.user._id;
        const { answers, customName } = req.body; 

        console.log("\n=== QUIZ SUBMISSION DEBUG ===");
        console.log("1. Raw Answers from React:", answers);

        const user = await User.findById(userId);
        const course = await BiteSizeCourse.findById(courseId);

        if (!course || !course.quiz.enabled) {
            return res.status(400).json({ message: "Quiz is not active for this course." });
        }

        let correctCount = 0;
        const totalQuestions = course.quiz.questions.length;

        if (totalQuestions === 0) return res.status(400).json({ message: "No questions found." });

        course.quiz.questions.forEach((q, index) => {
            const questionIdStr = q._id.toString();
            const userAnswer = answers[questionIdStr];
            const actualAnswer = q.correctAnswer;

            console.log(`\nQ${index + 1}: ID = ${questionIdStr}`);
            console.log(` -> User picked : "${userAnswer}"`);
            console.log(` -> Correct is  : "${actualAnswer}"`);

            if (userAnswer && userAnswer.trim() === actualAnswer.trim()) {
                console.log(` -> RESULT: ✅ MATCH!`);
                correctCount++;
            } else {
                console.log(` -> RESULT: ❌ WRONG!`);
            }
        });

        const scorePercentage = Math.round((correctCount / totalQuestions) * 100);
        console.log(`\nFinal Score: ${correctCount}/${totalQuestions} (${scorePercentage}%)`);
        console.log("=============================\n");

        const passed = scorePercentage >= course.quiz.passingScore;

        if (!passed) {
            return res.json({ 
                success: true, 
                passed: false, 
                score: scorePercentage, 
                message: `You scored ${scorePercentage}%. You need ${course.quiz.passingScore}% to pass.` 
            });
        }

        const existingCert = await Certificate.findOne({ user: userId, course: courseId });
        if (existingCert) {
            return res.json({ success: true, passed: true, score: scorePercentage, certificateUrl: existingCert.certificateUrl });
        }

        const uniqueCertId = `CERT-BS-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const certificateLink = `/bitesize-certificate/${uniqueCertId}`;

        const newCert = new Certificate({
            certificateId: uniqueCertId,
            user: userId,
            studentName: customName || req.user.name,
            phone: user.phone || "N/A",
            course: courseId,
            itemModel: 'BiteSizeCourse',
            courseName: `${course.title.toUpperCase()} ${course.highlight}`,
            planType: 'standard', 
            score: scorePercentage,
            issuedDate: new Date(),
            certificateUrl: certificateLink
        });
        await newCert.save();

        // 🔴 THE FIX: Handle both Legacy Buyers and New Subscription Users
        const updateResult = await User.updateOne(
            { _id: userId, "enrolledCourses.item": courseId },
            {
                $set: {
                    "enrolledCourses.$.certificateUrl": certificateLink,
                    "enrolledCourses.$.score": scorePercentage,
                    "enrolledCourses.$.issuedDate": new Date(),
                    "enrolledCourses.$.progress": 100
                }
            }
        );

        // If it didn't update anything, they are a Subscription user. 
        // Push a new record so it shows up as "Completed" on their Profile Dashboard.
        if (updateResult.modifiedCount === 0) {
            await User.updateOne(
                { _id: userId },
                {
                    $push: {
                        enrolledCourses: {
                            item: courseId,
                            itemModel: 'BiteSizeCourse',
                            planType: 'subscription', // Marks that they got this via sub
                            paymentStatus: 'full',
                            amountPaid: 0,
                            purchasedAt: new Date(),
                            progress: 100,
                            certificateUrl: certificateLink,
                            issuedDate: new Date(),
                            score: scorePercentage
                        }
                    }
                }
            );
        }

        res.json({ 
            success: true, passed: true, score: scorePercentage, certificateUrl: certificateLink
        });

    } catch (err) {
        console.error("Quiz Submission Error:", err);
        res.status(500).json({ message: "Server Error during quiz grading." });
    }
});

// =====================================================
// 6. ADMIN ROUTES (SECURED)
// =====================================================

const generateRandomLikes = () => Math.floor(Math.random() * (450 - 120 + 1) + 120);

router.get('/admin/all', adminOnly, async (req, res) => {
    try {
        const list = await BiteSizeCourse.find({}).sort({ createdAt: -1 });
        res.json(list);
    } catch (err) {
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

router.post('/admin/create', adminOnly, async (req, res) => {
    try {
        let payload = req.body;
        
        // 🔴 THE FIX: Auto-inject random baseLikes for new videos if not provided
        if (payload.content && Array.isArray(payload.content)) {
            payload.content = payload.content.map(video => ({
                ...video,
                baseLikes: video.baseLikes || generateRandomLikes()
            }));
        }

        const newItem = new BiteSizeCourse(payload);
        await newItem.save();
        res.status(201).json({ message: "Created", course: newItem });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.put('/admin/update/:id', adminOnly, async (req, res) => {
    try {
        let payload = req.body;

        // 🔴 THE FIX: Auto-inject random baseLikes for any newly added videos during an update
        if (payload.content && Array.isArray(payload.content)) {
            payload.content = payload.content.map(video => ({
                ...video,
                baseLikes: video.baseLikes || generateRandomLikes()
            }));
        }

        const updated = await BiteSizeCourse.findByIdAndUpdate(
            req.params.id, 
            payload, 
            { new: true, runValidators: true } 
        );
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

// 🔒 ADMIN: Get Subscription Analytics
router.get('/admin/subscription-stats', adminOnly, async (req, res) => {
    try {
        // Find anyone who has ever had a subscription
        const users = await User.find({ 
            "biteSizeSubscription.planType": { $in: ['trial', 'monthly', 'yearly'] } 
        }).lean();

        // Setup our analytical buckets
        let stats = {
            yearly: { _id: 'yearly', title: "Yearly Subscriptions", enrolledCount: 0, activeCount: 0, students: [] },
            monthly: { _id: 'monthly', title: "Monthly Subscriptions", enrolledCount: 0, activeCount: 0, students: [] },
            trial: { _id: 'trial', title: "₹1 Trial Users", enrolledCount: 0, activeCount: 0, students: [] }
        };

        const now = new Date();

        users.forEach(user => {
            const sub = user.biteSizeSubscription;
            if (!sub || sub.planType === 'none') return;

            // Calculate exact real-time status
            const isActive = sub.status === 'active' && new Date(sub.expiresAt) > now;
            const group = stats[sub.planType];

            if (group) {
                group.enrolledCount += 1;
                if (isActive) group.activeCount += 1;
                
                group.students.push({
                    name: user.name,
                    phone: user.phone,
                    status: isActive ? 'Active' : 'Expired',
                    expiresAt: sub.expiresAt,
                    trialUsed: sub.trialUsed
                });
            }
        });

        // Convert the object into an array and remove empty buckets
        const statsArray = [stats.yearly, stats.monthly, stats.trial].filter(g => g.enrolledCount > 0);
        
        // Sort students inside each bucket (Active first, then by furthest expiration date)
        statsArray.forEach(group => {
            group.students.sort((a, b) => {
                if (a.status === b.status) return new Date(b.expiresAt) - new Date(a.expiresAt);
                return a.status === 'Active' ? -1 : 1;
            });
        });

        res.json({ success: true, stats: statsArray });

    } catch (err) {
        console.error("Subscription Stats Error:", err);
        res.status(500).json({ success: false, message: "Server Error processing stats." });
    }
});

module.exports = router;