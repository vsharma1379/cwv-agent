const express = require('express');
const { google } = require('googleapis');
const router = express.Router();

const getOAuth2Client = () =>
  new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI || 'http://localhost:3001/api/auth/callback'
  );

// Step 1: Redirect user to Google consent screen
router.get('/google', (req, res) => {
  const oauth2Client = getOAuth2Client();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/webmasters.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  });
  res.redirect(authUrl);
});

// Step 2: Google redirects back here with a code
router.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Missing auth code' });

  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    // Get user info
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const params = new URLSearchParams({
      access_token: tokens.access_token,
      ...(tokens.refresh_token && { refresh_token: tokens.refresh_token }),
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture || '',
    });
    res.redirect(`${frontendUrl}?${params.toString()}`);
  } catch (err) {
    console.error('Auth callback error:', err.message);
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}?error=auth_failed`);
  }
});

// POST /api/auth/refresh — exchange a refresh_token for a new access_token
router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'Missing refresh_token' });
  try {
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({ refresh_token });
    const { credentials } = await oauth2Client.refreshAccessToken();
    if (!credentials.access_token) return res.status(401).json({ error: 'Could not refresh token' });
    res.json({ access_token: credentials.access_token });
  } catch (err) {
    console.error('Token refresh error:', err.message);
    res.status(401).json({ error: 'Token refresh failed' });
  }
});

module.exports = router;
