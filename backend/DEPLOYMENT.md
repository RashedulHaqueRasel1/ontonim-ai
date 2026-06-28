# Backend Deployment

The VS Code extension needs the auth backend to be reachable all the time. Good hosting choices:

- Render Web Service
- Railway
- Fly.io
- DigitalOcean App Platform
- VPS with PM2 + Nginx

## Required Environment Variables

Set these in the hosting provider dashboard:

```env
PORT=3987
MONGODB_URI=your-mongodb-uri
JWT_SECRET=long-random-secret
API_KEY_ENCRYPTION_SECRET=another-long-random-secret
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_CALLBACK_URL=https://your-backend-domain.com/auth/google/callback
ALLOWED_ORIGINS=*
```

## Start Command

```bash
npm run backend:start
```

## Google Cloud Console

When deployed, add the production callback URL as an Authorized redirect URI:

```txt
https://your-backend-domain.com/auth/google/callback
```

Keep the local callback too if you still develop locally:

```txt
http://localhost:3987/auth/google/callback
```

## VS Code Extension Setting

After deployment, update `ontonimAi.backendUrl` in VS Code settings:

```txt
https://your-backend-domain.com
```

Do not include a trailing slash.
