require('dotenv').config();

const crypto = require('crypto');
const cors = require('cors');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { OAuth2Client } = require('google-auth-library');
const ApiCredential = require('./models/ApiCredential');
const PromptHistory = require('./models/PromptHistory');
const User = require('./models/User');

const {
    PORT = 3987,
    MONGODB_URI,
    JWT_SECRET,
    API_KEY_ENCRYPTION_SECRET = JWT_SECRET,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_CALLBACK_URL,
    ALLOWED_ORIGINS = '*'
} = process.env;

const requiredEnv = {
    MONGODB_URI,
    JWT_SECRET,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_CALLBACK_URL
};

for (const [key, value] of Object.entries(requiredEnv)) {
    if (!value) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
}

const app = express();
const oauthClient = new OAuth2Client(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_CALLBACK_URL
);
const pendingSessions = new Map();

app.use(express.json());
app.use(cors({
    origin: ALLOWED_ORIGINS === '*'
        ? true
        : ALLOWED_ORIGINS.split(',').map(origin => origin.trim()),
    credentials: false
}));

app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'ontonim-ai-auth' });
});

app.get('/auth/google/url', (req, res) => {
    const state = normalizeState(req.query.state) || crypto.randomUUID();
    pendingSessions.set(state, {
        status: 'pending',
        createdAt: Date.now()
    });

    const authUrl = oauthClient.generateAuthUrl({
        access_type: 'offline',
        prompt: 'select_account',
        scope: ['openid', 'profile', 'email'],
        state
    });

    res.json({ authUrl, state });
});

app.get('/auth/google/callback', async (req, res, next) => {
    try {
        const state = normalizeState(req.query.state);
        const code = typeof req.query.code === 'string' ? req.query.code : '';

        if (!state || !code) {
            res.status(400).send(renderHtml('Login failed', 'Missing Google OAuth state or code.'));
            return;
        }

        const { tokens } = await oauthClient.getToken(code);
        oauthClient.setCredentials(tokens);

        const ticket = await oauthClient.verifyIdToken({
            idToken: tokens.id_token,
            audience: GOOGLE_CLIENT_ID
        });
        const payload = ticket.getPayload();

        if (!payload || !payload.sub || !payload.email) {
            res.status(401).send(renderHtml('Login failed', 'Google did not return a verified email profile.'));
            return;
        }

        const user = await User.findOneAndUpdate(
            { googleId: payload.sub },
            {
                $set: {
                    googleId: payload.sub,
                    name: payload.name || payload.email,
                    email: payload.email,
                    image: payload.picture || '',
                    lastLoginAt: new Date()
                }
            },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        ).lean();

        const safeUser = {
            id: String(user._id),
            name: user.name,
            email: user.email,
            image: user.image
        };
        const token = jwt.sign(
            {
                sub: safeUser.id,
                email: safeUser.email,
                name: safeUser.name
            },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        pendingSessions.set(state, {
            status: 'complete',
            user: safeUser,
            token,
            createdAt: Date.now()
        });

        res.send(renderHtml('Login complete', 'You can return to VS Code now.', safeUser));
    } catch (error) {
        next(error);
    }
});

app.get('/auth/session/:state', (req, res) => {
    const state = normalizeState(req.params.state);
    const session = pendingSessions.get(state);

    if (!session) {
        res.status(404).json({ status: 'missing' });
        return;
    }

    res.json(session);

    if (session.status === 'complete') {
        setTimeout(() => pendingSessions.delete(state), 60000);
    }
});

app.post('/api/credentials', requireAuth, async (req, res, next) => {
    try {
        const provider = normalizeProvider(req.body.provider);
        const selectedModel = normalizeText(req.body.selectedModel, 160);
        const apiKey = normalizeText(req.body.apiKey, 4000);

        if (!provider || !selectedModel) {
            res.status(400).json({ error: 'provider and selectedModel are required.' });
            return;
        }

        const update = {
            email: req.user.email,
            provider,
            selectedModel,
            lastUpdatedAt: new Date()
        };

        if (apiKey) {
            update.encryptedApiKey = encryptSecret(apiKey);
            update.keyPreview = createKeyPreview(apiKey);
        }

        const credential = await ApiCredential.findOneAndUpdate(
            { userId: req.user._id, provider },
            {
                $set: update,
                $setOnInsert: { userId: req.user._id }
            },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        ).lean();

        res.json({
            ok: true,
            credential: {
                id: String(credential._id),
                email: credential.email,
                provider: credential.provider,
                selectedModel: credential.selectedModel,
                keyPreview: credential.keyPreview
            }
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/history', requireAuth, async (req, res, next) => {
    try {
        const prompt = normalizeText(req.body.prompt, 12000);
        if (!prompt) {
            res.status(400).json({ error: 'prompt is required.' });
            return;
        }

        const item = await PromptHistory.create({
            userId: req.user._id,
            email: req.user.email,
            prompt,
            activeFile: normalizeText(req.body.activeFile, 500),
            mode: normalizeText(req.body.mode, 40) || 'agent',
            provider: normalizeText(req.body.provider, 40),
            model: normalizeText(req.body.model, 160)
        });

        res.status(201).json({
            ok: true,
            history: {
                id: String(item._id),
                email: item.email,
                createdAt: item.createdAt
            }
        });
    } catch (error) {
        next(error);
    }
});

app.use((err, req, res, next) => {
    void next;
    console.error(err);
    res.status(500).json({
        error: 'Internal server error',
        message: err.message
    });
});

function normalizeState(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
}

async function requireAuth(req, res, next) {
    try {
        const authHeader = req.headers.authorization || '';
        const [scheme, token] = authHeader.split(' ');
        if (scheme !== 'Bearer' || !token) {
            res.status(401).json({ error: 'Missing bearer token.' });
            return;
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await User.findById(decoded.sub);
        if (!user) {
            res.status(401).json({ error: 'User not found.' });
            return;
        }

        req.user = user;
        next();
    } catch {
        res.status(401).json({ error: 'Invalid or expired token.' });
    }
}

function normalizeProvider(value) {
    const provider = normalizeText(value, 40);
    return ['openrouter', 'openai', 'betopia', 'groq'].includes(provider) ? provider : '';
}

function normalizeText(value, limit) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, limit);
}

function encryptSecret(value) {
    const iv = crypto.randomBytes(12);
    const key = crypto.createHash('sha256').update(API_KEY_ENCRYPTION_SECRET).digest();
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function createKeyPreview(value) {
    if (!value) return '';
    if (value.length <= 8) return '••••';
    return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

function renderHtml(title, message, user = null) {
    const avatar = user && user.image
        ? `<img class="avatar" src="${escapeHtml(user.image)}" alt="">`
        : '<div class="avatar fallback">O</div>';
    const account = user
        ? `<div class="account">${avatar}<div><strong>${escapeHtml(user.name)}</strong><span>${escapeHtml(user.email)}</span></div></div>`
        : '';

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(139, 92, 246, 0.28), transparent 34%),
        radial-gradient(circle at bottom right, rgba(59, 130, 246, 0.22), transparent 32%),
        #0f172a;
      color: #e5e7eb;
      padding: 22px;
    }
    main {
      width: min(440px, 100%);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 18px;
      background: rgba(15, 23, 42, 0.78);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.36);
      padding: 28px;
      text-align: center;
      backdrop-filter: blur(16px);
    }
    .logo {
      width: 44px;
      height: 44px;
      display: inline-grid;
      place-items: center;
      border-radius: 14px;
      background: linear-gradient(135deg, #8b5cf6, #3b82f6);
      color: white;
      font-weight: 900;
      box-shadow: 0 0 26px rgba(139, 92, 246, 0.38);
      margin-bottom: 16px;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      border: 1px solid rgba(34, 197, 94, 0.2);
      background: rgba(34, 197, 94, 0.08);
      color: #86efac;
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 12px;
      font-weight: 800;
      margin-bottom: 12px;
    }
    h1 { margin: 0 0 10px; font-size: 26px; letter-spacing: 0; }
    p { margin: 0; color: #94a3b8; line-height: 1.6; }
    .account {
      margin-top: 18px;
      display: flex;
      align-items: center;
      gap: 11px;
      padding: 11px;
      border-radius: 13px;
      background: rgba(255, 255, 255, 0.045);
      border: 1px solid rgba(255, 255, 255, 0.08);
      text-align: left;
    }
    .account strong,
    .account span {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .account strong { color: #f8fafc; font-size: 14px; }
    .account span { color: #94a3b8; font-size: 12px; margin-top: 2px; }
    .avatar {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      object-fit: cover;
      flex: 0 0 auto;
    }
    .avatar.fallback {
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, #8b5cf6, #3b82f6);
      color: white;
      font-weight: 900;
    }
    .hint { margin-top: 18px; font-size: 12px; color: #64748b; }
  </style>
</head>
<body>
  <main>
    <div class="logo">O</div>
    <div class="status">Google connected</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    ${account}
    <div class="hint">This window can be closed safely.</div>
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function start() {
    await mongoose.connect(MONGODB_URI);
    app.listen(Number(PORT), () => {
        console.log(`Ontonim AI auth backend running on http://localhost:${PORT}`);
        console.log(`Google OAuth redirect URI must be registered as: ${GOOGLE_CALLBACK_URL}`);
    });
}

start().catch(error => {
    console.error(error);
    process.exit(1);
});
