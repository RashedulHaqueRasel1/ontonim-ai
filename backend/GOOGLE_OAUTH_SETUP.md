# Google OAuth Setup

If Google shows `Error 400: redirect_uri_mismatch`, the redirect URI sent by the backend is not registered in Google Cloud Console.

## Required Google Cloud Settings

Create or edit an OAuth Client:

- Application type: `Web application`
- Authorized redirect URI:

```txt
http://localhost:3987/auth/google/callback
```

This must match `GOOGLE_CALLBACK_URL` in `.env` exactly, including:

- protocol: `http`
- host: `localhost`
- port: `3987`
- path: `/auth/google/callback`
- no trailing slash

## Local `.env`

```env
PORT=3987
GOOGLE_CALLBACK_URL=http://localhost:3987/auth/google/callback
API_KEY_ENCRYPTION_SECRET=replace-with-another-long-random-secret
```

After changing Google Cloud Console, restart the backend:

```bash
npm run backend:dev
```
