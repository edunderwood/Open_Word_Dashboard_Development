/**
 * Authentication Routes
 */

import express from 'express';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();

// Admin credentials (in production, store hashed password in env)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'david@firmustech.com';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;

// If no hash set, create default (change this in production!)
const DEFAULT_PASSWORD = 'admin123'; // Change this!

/**
 * POST /auth/login
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // Check email
    if (email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check password
    let isValid = false;

    if (ADMIN_PASSWORD_HASH) {
      // Use bcrypt to compare
      isValid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
    } else {
      // Fallback to default password (for initial setup)
      isValid = password === DEFAULT_PASSWORD;
      if (isValid) {
        console.log('⚠️ Using default password - please set ADMIN_PASSWORD_HASH in .env');
        console.log('   Generate hash with: node -e "const bcrypt = require(\'bcryptjs\'); console.log(bcrypt.hashSync(\'yourpassword\', 10))"');
      }
    }

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Set session
    req.session.authenticated = true;
    req.session.email = email;
    req.session.loginTime = new Date().toISOString();

    console.log(`✅ Admin logged in: ${email}`);

    res.json({ success: true, message: 'Login successful' });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /auth/logout
 */
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ success: true });
  });
});

/**
 * GET /auth/status
 */
router.get('/status', (req, res) => {
  if (req.session && req.session.authenticated) {
    res.json({
      authenticated: true,
      email: req.session.email,
      loginTime: req.session.loginTime
    });
  } else {
    res.json({ authenticated: false });
  }
});

/**
 * POST /auth/change-password
 */
router.post('/change-password', async (req, res) => {
  if (!req.session || !req.session.authenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' });
  }

  // Verify current password
  let isValid = false;
  if (ADMIN_PASSWORD_HASH) {
    isValid = await bcrypt.compare(currentPassword, ADMIN_PASSWORD_HASH);
  } else {
    isValid = currentPassword === DEFAULT_PASSWORD;
  }

  if (!isValid) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  // Generate new hash
  const newHash = await bcrypt.hash(newPassword, 10);

  res.json({
    success: true,
    message: 'Password hash generated. Add this to your .env file:',
    hash: newHash,
    envLine: `ADMIN_PASSWORD_HASH=${newHash}`
  });
});

export default router;
