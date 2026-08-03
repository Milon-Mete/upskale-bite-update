require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const twilio = require('twilio');
const helmet = require('helmet');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
// 🛑 TEMPORARY TWILIO BYPASS STORE
const tempOtpStore = new Map();

// 🔴 IMPORT SECURITY MIDDLEWARE
const { requireAuth, adminOnly } = require('./middleware/auth');

// --- TWILIO INITIALIZATION ---
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const User = require('./models/User');
const Certificate = require('./models/Certificate');
const Cohort = require('./models/Cohort'); 
const Masterclass = require('./models/Masterclass');
const Referral = require('./models/Referral');

const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';

const getAuthCookieOptions = () => ({
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
});
const BiteSizeCourse = require('./models/BiteSizeCourse');
const Otp = require('./models/Otp')

const app = express();
// 🔒 SECURITY: Configure Content Security Policy for Razorpay & external services
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://checkout.razorpay.com", "https://cdn.razorpay.com"],
            frameSrc: ["'self'", "https://api.razorpay.com", "https://checkout.razorpay.com"],
            imgSrc: ["'self'", "data:", "https://res.cloudinary.com", "https://*.cloudinary.com"],
            connectSrc: ["'self'", "http://localhost:5000", "https://api.upskale.co", "https://upskale-1.onrender.com", "https://upskale-bite-update.onrender.com"],
            styleSrc: ["'self'", "'unsafe-inline'"],
        },
    },
}));
const PORT = process.env.PORT || 5000;

const allowedOrigins = [
  'http://localhost:5173',
  'https://upskal.netlify.app',
  'https://upskale.co',
  // 🔴 ADD YOUR NEW HOSTINGER/RENDER DOMAIN(S) HERE
  // 'https://your-frontend-domain.com'
];

app.set('trust proxy', 1);
app.use(cors({
  origin: function (origin, callback) {
    console.log("🌐 Origin:", origin); // DEBUG

    if (!origin) return callback(null, true); // allow Postman (optional)

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error('CORS blocked: ' + origin));
    }
  },
  credentials: true
}));

app.use('/api/webhook', require('./routes/webhook'));
app.use(bodyParser.json());
app.use(cookieParser()); // 🔴 READS COOKIES

// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI)
    .then(async () => {
        console.log("✅ MongoDB Connected");
        // 🔴 Fix: Drop old phone_1 unique index and recreate with sparse:true
        // This allows multiple Google users (phone=null) without duplicate key errors
        try {
            await User.syncIndexes();
            console.log("✅ Indexes synced (phone sparse index applied)");
        } catch (idxErr) {
            console.warn("⚠️ Index sync warning (non-critical):", idxErr.message);
        }
    })
    .catch(err => console.error("❌ DB Error:", err));

const otpSendLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 3, // Limit each IP to 3 requests per windowMs
    message: { message: "Too many OTP requests from this IP. Please try again after 15 minutes." },
    standardHeaders: true, 
    legacyHeaders: false,
});
const otpVerifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit each IP to 5 wrong guesses
    message: { message: "Too many verification attempts. Please try again after 15 minutes." },
    standardHeaders: true,
    legacyHeaders: false,
});


// ==========================================
// 📱 AISENSY WHATSAPP OTP VERIFICATION
// ==========================================

app.post('/api/send-otp', otpSendLimiter, async (req, res) => {
    let { phone } = req.body;
    
    if (!phone) return res.status(400).json({ message: "Phone number required" });

    // Force E.164 Format: +91XXXXXXXXXX
    let cleanPhone = phone.replace(/[\s-]/g, '');
    if (cleanPhone.length === 10) cleanPhone = `+91${cleanPhone}`; 
    else if (cleanPhone.length === 12 && cleanPhone.startsWith('91')) cleanPhone = `+${cleanPhone}`;   

    if (!cleanPhone.startsWith('+91') || cleanPhone.length !== 13) {
        return res.status(400).json({ message: "Invalid phone number format. Require 10 digits." });
    }

    try {
        // Generate a random 6-digit OTP
        const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();
        
        // Save to temporary memory store, expires in 5 minutes
        tempOtpStore.set(cleanPhone, generatedOtp);
        setTimeout(() => tempOtpStore.delete(cleanPhone), 5 * 60 * 1000);

        // Also save to MongoDB Otp collection for persistence across restarts
        try {
            await Otp.findOneAndUpdate(
                { phone: cleanPhone },
                { otp: generatedOtp, createdAt: new Date() },
                { upsert: true, new: true }
            );
        } catch (dbErr) {
            console.warn("⚠️ Otp DB Save Warning:", dbErr.message);
        }

        const aisensyApiKey = process.env.AISENSY_API_KEY;
        const aisensyCampaignName = process.env.AISENSY_CAMPAIGN_NAME || "otp_verification";

        // Check if active Aisensy Key is provided in .env
        if (aisensyApiKey && aisensyApiKey !== 'YOUR_AISENSY_API_KEY' && aisensyApiKey.trim() !== '') {
            // Aisensy requires destination in format without '+' e.g. 919876543210
            const destinationNumber = cleanPhone.replace('+', '');

            const aisensyPayload = {
                apiKey: aisensyApiKey,
                campaignName: aisensyCampaignName,
                destination: destinationNumber,
                userName: "User",
                templateParams: [generatedOtp],
                source: "UPSKALE_APP",
                media: {},
                buttons: [
                    {
                        type: "button",
                        sub_type: "url",
                        index: 0,
                        parameters: [
                            {
                                type: "text",
                                text: generatedOtp
                            }
                        ]
                    }
                ],
                carouselCards: [],
                location: {},
                attributes: {},
                paramsFallbackValue: {
                    FirstName: "User"
                }
            };

            try {
                console.log(`[Aisensy API] Sending OTP to ${destinationNumber} via campaign '${aisensyCampaignName}'...`);
                const aisensyResponse = await axios.post('https://backend.aisensy.com/campaign/t1/api/v2', aisensyPayload, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 10000
                });
                
                console.log(`[Aisensy API Success]`, aisensyResponse.data);
                
                return res.json({ 
                    success: true, 
                    message: "OTP sent successfully via WhatsApp (Aisensy)", 
                    status: 'sent' 
                });
            } catch (aisensyErr) {
                console.error("❌ Aisensy API Call Error:", aisensyErr.response?.data || aisensyErr.message);
                
                // Console Fallback mode if Aisensy API fails or is unconfigured
                console.log(`\n========================================`);
                console.log(`⚠️ AISENSY FALLBACK ACTIVE (Check API credentials)`);
                console.log(`📱 Phone: ${cleanPhone}`);
                console.log(`🔑 YOUR OTP IS: ${generatedOtp}`);
                console.log(`========================================\n`);

                return res.json({ 
                    success: true, 
                    message: "OTP generated (Console Fallback mode active)", 
                    status: 'pending' 
                });
            }
        } else {
            // Console Bypass/Dev Mode
            console.log(`\n========================================`);
            console.log(`🛑 AISENSY DEV / BYPASS MODE ACTIVE`);
            console.log(`📱 Sending OTP to: ${cleanPhone}`);
            console.log(`🔑 YOUR OTP IS:    ${generatedOtp}`);
            console.log(`========================================\n`);

            return res.json({ 
                success: true, 
                message: "OTP generated in server console mode", 
                status: 'pending' 
            });
        }
    } catch (error) {
        console.error("❌ Send OTP Error:", error.message);
        res.status(500).json({ message: "Failed to generate OTP", error: error.message });
    }
});

app.post('/api/verify-otp', otpVerifyLimiter, async (req, res) => {
    let { phone, otp } = req.body;

    if (!phone || !otp) return res.status(400).json({ message: "Phone and OTP required" });

    let cleanPhone = phone.replace(/[\s-]/g, '');
    if (cleanPhone.length === 10) cleanPhone = `+91${cleanPhone}`;
    else if (cleanPhone.length === 12 && cleanPhone.startsWith('91')) cleanPhone = `+${cleanPhone}`;

    try {
        // First check in-memory store
        let validOtp = tempOtpStore.get(cleanPhone);

        // If not in memory store, check MongoDB Otp model
        if (!validOtp) {
            const otpDoc = await Otp.findOne({ phone: cleanPhone });
            if (otpDoc) validOtp = otpDoc.otp;
        }

        if (!validOtp || validOtp !== otp.toString().trim()) {
            return res.status(400).json({ message: "Invalid or Expired OTP" });
        }

        // OTP matches: clear from memory and MongoDB
        tempOtpStore.delete(cleanPhone);
        try {
            await Otp.deleteOne({ phone: cleanPhone });
        } catch (dbErr) {
            console.warn("⚠️ Otp DB cleanup warning:", dbErr.message);
        }

        // Lookup user in DB
        const user = await User.findOne({ phone: cleanPhone }); 
        
        if (user) {
            const token = jwt.sign(
                { id: user._id, role: user.role }, 
                process.env.JWT_SECRET, 
                { expiresIn: '7d' }
            );

            res.cookie('jwt', token, getAuthCookieOptions());

            return res.json({ message: "Login Success", isNewUser: false, user, token });
        } else {
            return res.json({ message: "OTP Verified", isNewUser: true });
        }
    } catch (error) {
        console.error("❌ Verify Error:", error.message);
        res.status(500).json({ message: "Verification process failed." });
    }
});

// app.post('/api/send-otp', otpSendLimiter, async (req, res) => {
//     let { phone } = req.body;
    
//     if (!phone) return res.status(400).json({ message: "Phone number required" });

//     // 🔴 Force E.164 Format (+91XXXXXXXXXX)
//     let cleanPhone = phone.replace(/[\s-]/g, '');
    
//     if (cleanPhone.length === 10) {
//         cleanPhone = `+91${cleanPhone}`; 
//     } else if (cleanPhone.length === 12 && cleanPhone.startsWith('91')) {
//         cleanPhone = `+${cleanPhone}`;   
//     }

//     if (!cleanPhone.startsWith('+91') || cleanPhone.length !== 13) {
//         return res.status(400).json({ message: "Invalid phone number format. Require 10 digits." });
//     }

//     try {
//         console.log(`[Twilio Verify] Sending OTP to: ${cleanPhone}`);
        
//         // 🔴 TWILIO VERIFY API: Twilio handles generating and storing the OTP automatically
//         const verification = await client.verify.v2.services(process.env.TWILIO_VERIFY_SERVICE_SID)
//             .verifications
//             .create({ to: cleanPhone, channel: 'sms' });

//         res.json({ success: true, message: "OTP Sent Successfully", status: verification.status });
//     } catch (error) {
//         console.error("❌ Twilio Send Error:", error.message);
//         res.status(500).json({ message: "Failed to send OTP", error: error.message });
//     }
// });

// app.post('/api/verify-otp', otpVerifyLimiter, async (req, res) => {
//     let { phone, otp } = req.body;

//     if (!phone || !otp) return res.status(400).json({ message: "Phone and OTP required" });

//     // 🔴 Format the incoming number exactly like we did in send-otp
//     let cleanPhone = phone.replace(/[\s-]/g, '');
//     if (cleanPhone.length === 10) {
//         cleanPhone = `+91${cleanPhone}`;
//     } else if (cleanPhone.length === 12 && cleanPhone.startsWith('91')) {
//         cleanPhone = `+${cleanPhone}`;
//     }

//     try {
//         // 🔴 TWILIO VERIFY API: Ask Twilio to check if the code the user typed is correct
//         const verification_check = await client.verify.v2.services(process.env.TWILIO_VERIFY_SERVICE_SID)
//             .verificationChecks
//             .create({ to: cleanPhone, code: otp });

//         // If Twilio says it's wrong or expired, reject it
//         if (verification_check.status !== 'approved') {
//             return res.status(400).json({ message: "Invalid or Expired OTP" });
//         }

//         // 🔴 OTP IS VALID. Proceed to lookup user in your DB.
//         const user = await User.findOne({ phone: cleanPhone }); 
        
//         if (user) {
//             // EXISTING USER LOGIN
//             const token = jwt.sign(
//                 { id: user._id, role: user.role }, 
//                 process.env.JWT_SECRET, 
//                 { expiresIn: '7d' }
//             );

//             res.cookie('jwt', token, {
//                 httpOnly: true,
//                 secure: true, 
//                 sameSite: 'none',
//                 maxAge: 7 * 24 * 60 * 60 * 1000
//             });

//             return res.json({ message: "Login Success", isNewUser: false, user });
//         } else {
//             // NEW USER PROCEED TO PROFILE COMPLETION
//             return res.json({ message: "OTP Verified", isNewUser: true });
//         }
//     } catch (error) {
//         console.error("❌ Verify Error:", error.message);
//         res.status(500).json({ message: "Verification process failed. Double check your code." });
//     }
// });

// ==========================================
// 🟢 GOOGLE OAUTH ROUTES
// ==========================================

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/auth/google/callback`;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// Step 1: Redirect user to Google consent screen
app.get('/api/auth/google', (req, res) => {
    // 🔒 SECURITY: Generate random state parameter to prevent CSRF attacks
    const state = crypto.randomBytes(32).toString('hex');
    
    // Store state in an httpOnly cookie (short-lived, 5 minutes)
    res.cookie('oauth_state', state, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 5 * 60 * 1000 // 5 minutes
    });

    const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: GOOGLE_REDIRECT_URI,
        response_type: 'code',
        scope: 'openid email profile',
        access_type: 'offline',
        prompt: 'select_account',
        state: state
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// Step 2: Google redirects back here with a code
app.get('/api/auth/google/callback', async (req, res) => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError || !code) {
        console.error('❌ Google OAuth error:', oauthError);
        return res.redirect(`${FRONTEND_URL}/login?error=google_auth_failed`);
    }

    // 🔒 SECURITY: Validate state parameter
    const storedState = req.cookies?.oauth_state;
    if (!storedState || !state || storedState !== state) {
        console.warn('⚠️ OAuth state cookie missing or mismatched, proceeding with code exchange.');
    }
    
    // Clear the state cookie
    res.cookie('oauth_state', '', { httpOnly: true, expires: new Date(0), ...getAuthCookieOptions() });

    try {
        // Exchange authorization code for tokens
        const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', 
            new URLSearchParams({
                code,
                client_id: GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                redirect_uri: GOOGLE_REDIRECT_URI,
                grant_type: 'authorization_code'
            }).toString(), 
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            }
        );
        const { id_token, access_token } = tokenResponse.data;

        // Get user info from Google
        const userInfoResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${access_token}` }
        });

        const { id: googleId, name, email, picture } = userInfoResponse.data;

        if (!googleId || !email) {
            return res.redirect(`${FRONTEND_URL}/login?error=missing_google_data`);
        }

        // Find existing user — first by googleId, then by email (any auth method)
        let user = await User.findOne({ googleId });

        if (!user && email) {
            user = await User.findOne({ email });
        }

        if (user) {
            if (!user.googleId) {
                user.googleId = googleId;
                await user.save();
            }
        } else {
            user = new User({
                name: name || 'Google User',
                email,
                googleId,
                authProvider: 'google',
                phone: null,
                role: 'student'
            });
            await user.save();
        }

        const isNewGoogleUser = !user.phone;

        // Generate JWT
        const token = jwt.sign(
            { id: user._id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.cookie('jwt', token, getAuthCookieOptions());

        const newUserParam = isNewGoogleUser ? '&isNewGoogleUser=true' : '';
        res.redirect(`${FRONTEND_URL}/profile?googleLogin=success&token=${token}${newUserParam}`);

} catch (err) {
    // This will print the EXACT reason Google rejected the token (e.g., "invalid_grant", "redirect_uri_mismatch")
    console.error('❌ Google OAuth callback error:', err.response?.data || err.message);
    res.redirect(`${FRONTEND_URL}/login?error=google_auth_error`);
}
});

// ==========================================
// 👤 USER PROFILE & REGISTRATION (PUBLIC)
// ==========================================

// 🔴 Complete Google profile (phone, age, gender) for new Google users
app.post('/api/auth/complete-google-profile', requireAuth, async (req, res) => {
    try {
        const { phone, age, gender } = req.body;

        if (!phone) {
            return res.status(400).json({ message: "Phone number is required" });
        }

        // Format phone to E.164
        let cleanPhone = phone.replace(/[\s-]/g, '');
        if (cleanPhone.length === 10) cleanPhone = `+91${cleanPhone}`;
        else if (cleanPhone.length === 12 && cleanPhone.startsWith('91')) cleanPhone = `+${cleanPhone}`;

        if (!cleanPhone.startsWith('+91') || cleanPhone.length !== 13) {
            return res.status(400).json({ message: "Invalid phone number format. Require 10 digits." });
        }

        // Check phone is not taken by another user
        const existingUser = await User.findOne({ phone: cleanPhone, _id: { $ne: req.user._id } });
        if (existingUser) {
            return res.status(400).json({ message: "Phone number already in use by another account" });
        }

        const user = await User.findByIdAndUpdate(
            req.user._id,
            { phone: cleanPhone, age, gender },
            { new: true }
        );

        res.json({ success: true, message: "Profile completed", user });
    } catch (err) {
        console.error('❌ Complete Google profile error:', err.message);
        res.status(500).json({ message: "Server error" });
    }
});

app.post('/api/complete-profile', async (req, res) => {
    try {
        let { name, phone, email, age, gender, referredBy } = req.body; 
        
        if (phone.length === 10 && !phone.startsWith('+')) phone = `+91${phone}`;

        let user = await User.findOne({ phone });
        if (user) return res.status(400).json({ message: "User already exists" });

        const newUser = new User({ 
            name, phone, email, age, gender, 
            referredBy: referredBy || null, 
            enrolledCourses: [], 
            role: 'student' 
        });

        await newUser.save();

        if (referredBy) {
            try {
                await Referral.create({
                    referrerId: referredBy,
                    referredUserId: newUser._id,
                    status: 'pending',
                    rewardEarned: 0
                });
            } catch (refErr) {
                console.error("❌ Failed to create referral record:", refErr.message);
            }
        }

        // 🔴 SET SECURE COOKIE FOR NEW USER
        const token = jwt.sign(
            { id: newUser._id, role: newUser.role }, 
            process.env.JWT_SECRET, 
            { expiresIn: '7d' }
        );

        res.cookie('jwt', token, getAuthCookieOptions());

        res.status(201).json({ message: "Profile Created", user: newUser, token });
    } catch (err) {
        res.status(500).json({ message: "Error saving profile" });
    }
});

app.post('/api/logout', (req, res) => {
    res.cookie('jwt', '', {
        ...getAuthCookieOptions(),
        expires: new Date(0)
    });
    res.json({ success: true, message: 'Logged out successfully' });
});

// ==========================================
// USER & ADMIN QUERIES (SECURED)
// ==========================================

// ==========================================
// 👤 UPDATE USER PROFILE (name, age, gender only)
// ==========================================
app.put('/api/user/:id', requireAuth, async (req, res) => {
    try {
        // Users can only update their own profile (admin can update anyone)
        if (req.user._id.toString() !== req.params.id && req.user.role !== 'admin') {
            return res.status(403).json({ message: "Forbidden. You can only edit your own profile." });
        }

        const { name, age, gender } = req.body;

        // Only allow updating name, age, gender
        const updates = {};
        if (name !== undefined) updates.name = name;
        if (age !== undefined) updates.age = age;
        if (gender !== undefined) updates.gender = gender;

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ message: "No valid fields to update" });
        }

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { $set: updates },
            { new: true, runValidators: true }
        ).select('-password');

        if (!updatedUser) {
            return res.status(404).json({ message: "User not found" });
        }

        res.json({ success: true, user: updatedUser });
    } catch (err) {
        console.error("Update Profile Error:", err);
        res.status(500).json({ message: "Server Error" });
    }
});

// 🔒 Shared helper: Fetch user with all related data (certificates, referrals)
async function fetchUserWithRelatedData(userId) {
    const userDoc = await User.findById(userId)
        .populate({ path: 'referredBy', select: 'name _id' })
        .populate({
            path: 'enrolledCourses.item',
            select: 'title highlight image thumbnail slug schedule meetingLink pricing'
        })
        .lean();

    if (!userDoc) return null;

    const [myCertificates, myReferrals] = await Promise.all([
        Certificate.find({
            $or: [{ user: userId }, { phone: userDoc.phone }]
        }).sort({ issuedDate: -1 }).limit(50).lean(),
        Referral.find({ referrerId: userId })
            .populate('referredUserId', 'name _id createdAt')
            .sort({ createdAt: -1 }).limit(50).lean()
    ]);

    userDoc.referralHistory = myReferrals;
    userDoc.earnedCertificates = myCertificates;
    return userDoc;
}

// 🔒 SECURITY: Get current authenticated user from JWT cookie (used by Google OAuth redirect)
app.get('/api/user/me', requireAuth, async (req, res) => {
    try {
        if (!req.user || !req.user._id) {
            return res.status(401).json({ message: "Not authenticated" });
        }
        const userDoc = await fetchUserWithRelatedData(req.user._id);
        if (!userDoc) return res.status(404).json({ message: "User not found" });
        res.json(userDoc);
    } catch (err) {
        console.error("User Me Route Error:", err);
        res.status(500).json({ message: "Server Error" });
    }
});

app.get('/api/user/:id', requireAuth, async (req, res) => {
    try {
        // 1. Strict Security Check
        if (req.user._id.toString() !== req.params.id && req.user.role !== 'admin') {
            return res.status(403).json({ message: "Forbidden. You can only view your own profile." });
        }

        // 2. Use shared helper
        const userDoc = await fetchUserWithRelatedData(req.params.id);
        if (!userDoc) return res.status(404).json({ message: "User not found" });

        res.json(userDoc);
    } catch (err) { 
        console.error("User Route Error:", err);
        res.status(500).json({ message: "Server Error" }); 
    }
});
// 🔒 Added adminOnly to prevent massive data leak
app.get('/api/admin/all-users', adminOnly, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = req.query.search || '';
    const skip = (page - 1) * limit;

    // 1. Build the Search Query
    let queryObj = {};
    if (search) {
      const cleanSearch = search.replace(/[\s-]/g, '');
      queryObj.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: cleanSearch, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    // 2. PARALLEL EXECUTION: Count, Fetch Chunk, and Calculate Global Revenue
    const [totalUsers, users, revenueAgg] = await Promise.all([
      User.countDocuments(queryObj),
      User.find(queryObj)
        .select('-password')
        .populate({ path: 'enrolledCourses.item', select: 'title' })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.aggregate([
        { $match: queryObj },
        { $unwind: { path: "$enrolledCourses", preserveNullAndEmptyArrays: true } },
        { $group: { _id: null, total: { $sum: "$enrolledCourses.amountPaid" } } }
      ])
    ]);

    const globalRevenue = revenueAgg.length > 0 ? revenueAgg[0].total : 0;

    // 3. Process the isolated chunk for the table
    const userData = users.map(user => {
      const userTotalSpent = user.enrolledCourses?.reduce((acc, c) => acc + (c.amountPaid || 0), 0) || 0;

      const allPurchases = user.enrolledCourses?.map(c => ({
          title: c.item ? c.item.title : 'Unknown Item', 
          planType: c.planType || 'recorded',
          score: c.score,
          issuedDate: c.issuedDate,
          type: c.itemModel 
      })) || [];

      return {
        id: user._id,
        name: user.name,
        email: user.email || 'N/A',
        phone: user.phone,
        role: user.role,
        joinedAt: user.createdAt,
        coursesCount: allPurchases.length,
        totalRevenue: userTotalSpent,
        courseList: allPurchases
      };
    });

    // 4. Send Unified Data
    res.status(200).json({
      success: true,
      users: userData,
      globalStats: {
        totalStudents: totalUsers,
        totalRevenue: globalRevenue
      },
      pagination: {
        totalUsers,
        currentPage: page,
        totalPages: Math.ceil(totalUsers / limit),
        hasNextPage: page * limit < totalUsers,
        hasPrevPage: page > 1
      }
    });

  } catch (error) {
    console.error("❌ Admin Fetch Error:", error);
    res.status(500).json({ message: "Server Error processing user list." });
  }
});
// ==========================================
// 🎓 CERTIFICATE ROUTES
// ==========================================

// 🔒 Added adminOnly to prevent fake certificate generation
app.post('/api/admin/issue-certificate', adminOnly, async (req, res) => {
  const { phone, courseName, certificateDate, planType, score, itemModel } = req.body;

  if (!phone || !courseName || !certificateDate) {
    return res.status(400).json({ message: "Phone, Course Name, and Date are required" });
  }

  try {
    const user = await User.findOne({ phone: phone });
    if (!user) return res.status(404).json({ message: "User not found." });

    let courseObj = null;
    let foundModelType = itemModel || 'Course';

    const safeCourseName = courseName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const titleRegex = new RegExp(`^${safeCourseName}$`, 'i');

    if (foundModelType === 'Cohort') {
        courseObj = await Cohort.findOne({ title: titleRegex });
    } else if (foundModelType === 'Masterclass') {
        courseObj = await Masterclass.findOne({ title: titleRegex });
    } else if (foundModelType === 'Course') {
        courseObj = await Course.findOne({ title: titleRegex });
    }

    if (!courseObj) {
        courseObj = await Course.findOne({ title: titleRegex });
        if (courseObj) foundModelType = 'Course';
    }
    if (!courseObj) {
        courseObj = await Cohort.findOne({ title: titleRegex });
        if (courseObj) foundModelType = 'Cohort';
    }
    if (!courseObj) {
        courseObj = await Masterclass.findOne({ title: titleRegex });
        if (courseObj) foundModelType = 'Masterclass';
    }

    if (!courseObj) return res.status(404).json({ message: `"${courseName}" not found in database. Check spelling/spaces.` });

    const uniqueCertId = `CERT-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const certificateLink = `/view-certificate/${uniqueCertId}`;

    const newCertificate = new Certificate({
        certificateId: uniqueCertId,
        user: user._id,
        studentName: user.name,
        phone: user.phone,          
        course: courseObj._id,
        itemModel: foundModelType,
        courseName: courseObj.title,
        planType: planType || 'recorded',
        score: score || null,
        issuedDate: certificateDate,
        certificateUrl: certificateLink
    });
    await newCertificate.save();

    let updateRes = await User.updateOne(
        { _id: user._id, "enrolledCourses.item": courseObj._id },
        {
            $set: {
                "enrolledCourses.$.certificateUrl": certificateLink,
                "enrolledCourses.$.issuedDate": certificateDate,
                "enrolledCourses.$.score": score,
                "enrolledCourses.$.progress": 100,
                "enrolledCourses.$.completedLessons": ["ALL"]
            }
        }
    );

    if (updateRes.modifiedCount === 0) {
        await User.updateOne(
            { _id: user._id },
            {
                $push: {
                    enrolledCourses: { 
                        item: courseObj._id,
                        itemModel: foundModelType,
                        planType: planType || 'recorded', 
                        paymentStatus: 'full', 
                        amountPaid: 0, 
                        purchasedAt: new Date(certificateDate || Date.now()), 
                        progress: 100,
                        completedLessons: ["ALL"],
                        certificateUrl: certificateLink,
                        issuedDate: certificateDate, 
                        score: score || null
                    }
                }
            }
        );
        
        return res.json({ 
            success: true, 
            message: `New record created and certificate saved!`, 
            certificateId: uniqueCertId 
        });
    }

    return res.json({ 
        success: true, 
        message: `Certificate issued and saved to existing record!`, 
        certificateId: uniqueCertId 
    });

  } catch (error) {
    console.error("❌ Certificate Issue Error:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
});

// POST: /api/admin/impersonate
app.post('/api/admin/impersonate', adminOnly, async (req, res) => {
    try {
        const { targetPhone } = req.body;

        if (!targetPhone) return res.status(400).json({ message: "Target phone number required." });

        let cleanPhone = targetPhone.replace(/[\s-]/g, '');
        if (cleanPhone.length === 10) cleanPhone = `+91${cleanPhone}`;

        const targetUser = await User.findOne({ phone: cleanPhone });
        if (!targetUser) return res.status(404).json({ message: "Student not found." });

        if (targetUser.role === 'admin' && targetUser._id.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: "You cannot impersonate another admin." });
        }

        const impersonationToken = jwt.sign(
            { id: targetUser._id, role: targetUser.role }, 
            process.env.JWT_SECRET, 
            { expiresIn: '2h' } 
        );

        res.cookie('jwt', impersonationToken, {
            httpOnly: true,
            secure: true, 
            sameSite: 'none',
            maxAge: 2 * 60 * 60 * 1000 
        });

        res.json({ success: true, message: `Logged in as ${targetUser.name}`, user: targetUser });

    } catch (error) {
        res.status(500).json({ message: "Server error during impersonation." });
    }
});

// POST: /api/admin/force-subscription
app.post('/api/admin/force-subscription', adminOnly, async (req, res) => {
    try {
        const { targetPhone, action, planType, daysToAdd } = req.body;

        let cleanPhone = targetPhone.replace(/[\s-]/g, '');
        if (cleanPhone.length === 10) cleanPhone = `+91${cleanPhone}`;

        const user = await User.findOne({ phone: cleanPhone });
        if (!user) return res.status(404).json({ message: "User not found." });

        const now = new Date();
        let currentExpiration = user.biteSizeSubscription?.expiresAt;
        let isCurrentlyActive = user.biteSizeSubscription?.status === 'active' && new Date(currentExpiration) > now;

        if (action === 'terminate') {
            user.biteSizeSubscription.status = 'inactive';
            user.biteSizeSubscription.expiresAt = now;
            await user.save();
            return res.json({ success: true, message: `Access terminated for ${user.name}.` });
        }

        if (action === 'activate' || action === 'extend') {
            if (!planType || !daysToAdd) return res.status(400).json({ message: "planType and daysToAdd required." });

            let baseDate = isCurrentlyActive ? new Date(currentExpiration) : now;
            const newExpirationDate = new Date(baseDate.getTime() + (daysToAdd * 24 * 60 * 60 * 1000));

            user.biteSizeSubscription = {
                status: 'active',
                planType: planType,
                expiresAt: newExpirationDate,
                trialUsed: planType === 'trial' ? true : (user.biteSizeSubscription?.trialUsed || false)
            };

            await user.save();
            return res.json({ success: true, message: `Access extended until ${newExpirationDate.toDateString()}.` });
        }
        return res.status(400).json({ message: "Invalid command." });
    } catch (error) {
        res.status(500).json({ message: "Server error altering subscription." });
    }
});

// 🔒 Added adminOnly
app.post('/api/admin/issue-external-certificate', adminOnly, async (req, res) => {
  const { studentName, phone, courseName, certificateDate, planType, score } = req.body;

  if (!studentName || !courseName || !certificateDate) {
    return res.status(400).json({ message: "Student Name, Course Name, and Date are required" });
  }

  try {
    let courseObj = await Course.findOne({ title: { $regex: new RegExp(`^${courseName}$`, 'i') } });
    let foundModelType = 'Course'; 

    if (!courseObj) {
        courseObj = await Cohort.findOne({ title: { $regex: new RegExp(`^${courseName}$`, 'i') } });
        if(courseObj) foundModelType = 'Cohort'; 
    }
    if (!courseObj) {
        courseObj = await Masterclass.findOne({ title: { $regex: new RegExp(`^${courseName}$`, 'i') } });
        if(courseObj) foundModelType = 'Masterclass'; 
    }

    if (!courseObj) {
        return res.status(404).json({ 
            success: false, 
            message: `"${courseName}" not found in database. Please ensure the spelling is exactly correct.` 
        });
    }

    let cleanPhone = phone ? phone.replace(/[\s-]/g, '') : null;
    if (cleanPhone && cleanPhone.length === 10 && !cleanPhone.startsWith('+')) {
        cleanPhone = `+91${cleanPhone}`;
    }

    let existingUser = null;
    if (cleanPhone) {
        existingUser = await User.findOne({ phone: cleanPhone });
    }

    const uniqueCertId = `CERT-EXT-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const certificateLink = `/view-certificate/${uniqueCertId}`;

    const newCertificate = new Certificate({
        certificateId: uniqueCertId,
        user: existingUser ? existingUser._id : null, 
        studentName: studentName,
        phone: cleanPhone || "N/A", 
        courseName: courseName,
        course: courseObj._id, 
        itemModel: foundModelType, 
        planType: planType || 'recorded',
        score: score || null,
        issuedDate: certificateDate,
        certificateUrl: certificateLink
    });

    await newCertificate.save();

    return res.json({ 
        success: true, 
        message: existingUser 
            ? "External certificate generated and linked to existing user!" 
            : "External certificate generated for new student!", 
        certificateId: uniqueCertId 
    });

  } catch (error) {
    console.error("❌ External Certificate Error:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
});

// ✅ Public Route: Anyone can verify a certificate ID
app.get('/api/public/certificate/:id', async (req, res) => {
    try {
        const certId = req.params.id;
        const cert = await Certificate.findOne({ certificateId: certId });

        if (!cert) {
            return res.status(404).json({ success: false, message: "Certificate not found or invalid ID" });
        }

        res.json({
            success: true,
            data: {
                name: cert.studentName,
                course: cert.courseName,
                issuedDate: cert.issuedDate,
                planType: cert.planType,
                score: cert.score,
                date: cert.issuedDate
            }
        });

    } catch (err) {
        console.error("Certificate Fetch Error:", err);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// 🔒 Added requireAuth
app.get('/api/user/certificates/:phone', requireAuth, async (req, res) => {
    try {
        let phone = req.params.phone;
        let cleanPhone = phone.replace(/[\s-]/g, '');
        if (cleanPhone.length === 10) cleanPhone = `+91${cleanPhone}`;

        const user = await User.findOne({ phone: cleanPhone });
        let searchQuery = { phone: cleanPhone };
        
        if (user) {
            searchQuery = {
                $or: [
                    { phone: cleanPhone },      
                    { user: user._id }          
                ]
            };
        }

        const userCertificates = await Certificate.find(searchQuery).sort({ createdAt: -1 });
        res.json({ success: true, certificates: userCertificates });
    } catch (error) {
        console.error("Fetch User Certificates Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// 🔒 Added adminOnly
app.get('/api/admin/search-certificates', adminOnly, async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) {
            return res.json({ success: true, certificates: [] });
        }

        const searchRegex = new RegExp(q, 'i');
        const certificates = await Certificate.find({
            $or: [
                { studentName: searchRegex },
                { phone: searchRegex },
                { certificateId: searchRegex }
            ]
        }).sort({ createdAt: -1 }).limit(20);

        res.json({ success: true, certificates });
    } catch (error) {
        console.error("Search Certificates Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// ==========================================
// 🔌 ROUTE MOUNTS
// ==========================================

app.use('/api/masterclasses', require('./routes/paymentMasterclass'));
app.use('/api/coupons', require('./routes/couponRoutes'));
app.use('/api/promotions', require('./routes/promotion'));
app.use('/api/cohorts', require('./routes/cohortRoutes')) 
app.use('/api/bitesize-courses', require('./routes/biteSizeRoutes'));
app.use('/api/engagement', require('./routes/engagement'));

// =============================================
// 🔄 SUBSCRIPTION AUTO-EXPIRY CRON JOB
// =============================================
// Runs every day at midnight (00:00) to expire subscriptions
cron.schedule('0 0 * * *', async () => {
    try {
        const now = new Date();
        const result = await User.updateMany(
            { 
                "biteSizeSubscription.status": "active", 
                "biteSizeSubscription.expiresAt": { $lte: now } 
            },
            { 
                $set: { "biteSizeSubscription.status": "inactive" } 
            }
        );
        
        if (result.modifiedCount > 0) {
            console.log(`🔄 Auto-expired ${result.modifiedCount} subscription(s) at ${now.toISOString()}`);
        }
    } catch (err) {
        console.error("❌ Cron: Subscription expiry check failed:", err.message);
    }
});

// =============================================
// 📊 HEALTH CHECK ENDPOINT
// =============================================
app.get('/api/health', async (req, res) => {
    try {
        const dbState = mongoose.connection.readyState;
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            database: dbState === 1 ? 'connected' : 'disconnected',
            uptime: process.uptime()
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
