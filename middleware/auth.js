// middleware/auth.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const BiteSizeCourse = require('../models/BiteSizeCourse');

// 1. Authenticate any logged-in user
const requireAuth = async (req, res, next) => {
    try {
        // Read the token from the HttpOnly cookie
        const token = req.cookies.jwt;

        if (!token) {
            return res.status(401).json({ message: "Unauthorized: No token provided." });
        }

        // Verify the token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Find the user and attach to the request object
        const user = await User.findById(decoded.id).select('-password'); // Exclude password if you have one
        if (!user) {
            return res.status(401).json({ message: "Unauthorized: User not found." });
        }

        req.user = user;
        next();
    } catch (error) {
        console.error("Auth Error:", error.message);
        res.status(401).json({ message: "Unauthorized: Invalid or expired token." });
    }
};

// 2. Authenticate only Admins
const adminOnly = async (req, res, next) => {
    try {
        const token = req.cookies.jwt;

        if (!token) {
            return res.status(401).json({ message: "Unauthorized: No token provided." });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id);

        if (!user) {
            return res.status(401).json({ message: "Unauthorized: User not found." });
        }

        if (user.role !== 'admin') {
            return res.status(403).json({ message: "Forbidden: Admins only." });
        }

        req.user = user;
        next();
    } catch (error) {
        console.error("Admin Auth Error:", error.message);
        res.status(401).json({ message: "Unauthorized: Invalid or expired token." });
    }
};

// 3. Verify Course or Subscription Access
const checkCourseAccess = async (req, res, next) => {
  try {
    const user = req.user; 
    const requestedCourseId = req.params.courseId; 
    const requestedModelType = req.body.modelType || req.query.modelType; 

    // Subscription Check
    if (requestedModelType === 'BiteSizeCourse') {
      const sub = user.biteSizeSubscription;
      if (sub && sub.status === 'active' && sub.expiresAt && new Date(sub.expiresAt) > new Date()) {
        return next(); 
      }
    }

    // Legacy Purchase Check
    const exactEnrollment = user.enrolledCourses.find(
      (enrollment) => enrollment.item.toString() === requestedCourseId
    );

    if (exactEnrollment && ['full', 'installment', 'one-time', 'partial'].includes(exactEnrollment.paymentStatus)) {
      return next(); 
    }

    return res.status(403).json({ 
      success: false, 
      message: "Access denied. Please purchase the course or active subscription." 
    });

  } catch (error) {
    console.error("Access Control Error:", error);
    res.status(500).json({ message: "Internal server error during access verification." });
  }
};

// EXPORT ALL THREE (Replace your old module.exports with this)
module.exports = { requireAuth, adminOnly, checkCourseAccess };
