const mongoose = require('mongoose');

const apiCredentialSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    email: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
        index: true
    },
    provider: {
        type: String,
        required: true,
        enum: ['openrouter', 'openai', 'betopia', 'groq'],
        index: true
    },
    selectedModel: {
        type: String,
        required: true
    },
    encryptedApiKey: {
        type: String,
        default: ''
    },
    keyPreview: {
        type: String,
        default: ''
    },
    lastUpdatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

apiCredentialSchema.index({ userId: 1, provider: 1 }, { unique: true });

module.exports = mongoose.model('ApiCredential', apiCredentialSchema);
