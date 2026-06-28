const mongoose = require('mongoose');

const promptHistorySchema = new mongoose.Schema({
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
    prompt: {
        type: String,
        required: true
    },
    activeFile: {
        type: String,
        default: ''
    },
    mode: {
        type: String,
        default: 'agent'
    },
    provider: {
        type: String,
        default: ''
    },
    model: {
        type: String,
        default: ''
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('PromptHistory', promptHistorySchema);
