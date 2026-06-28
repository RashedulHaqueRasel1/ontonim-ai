const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    googleId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    name: {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
        index: true
    },
    image: {
        type: String,
        default: ''
    },
    lastLoginAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('User', userSchema);
