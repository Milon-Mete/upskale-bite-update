const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
    phone: { type: String, required: true },
    otp: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: 600 } // Auto-deletes after 600 seconds (10 mins)
});

module.exports = mongoose.model('Otp', otpSchema);