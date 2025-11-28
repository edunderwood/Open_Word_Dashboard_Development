/**
 * Authentication Routes - Using Supabase Auth
 */

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();

// Create Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Service role client for admin checks
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * POST /auth/login
 * Login with Supabase credentials
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // Authenticate with Supabase
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      console.log(`❌ Login failed for ${email}: ${error.message}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if user is an admin
    const { data: adminUser, error: adminError } = await supabaseAdmin
      .from('dashboard_admins')
      .select('*')
      .eq('user_id', data.user.id)
      .eq('is_active', true)
      .single();

    if (adminError || !adminUser) {
      console.log(`❌ User ${email} is not a dashboard admin`);
      return res.status(403).json({ error: 'Access denied. You are not authorized to access this dashboard.' });
    }

    // Set session
    req.session.authenticated = true;
    req.session.userId = data.user.id;
    req.session.email = email;
    req.session.role = adminUser.role;
    req.session.loginTime = new Date().toISOString();
    req.session.accessToken = data.session.access_token;

    console.log(`✅ Admin logged in: ${email} (${adminUser.role})`);

    res.json({
      success: true,
      message: 'Login successful',
      user: {
        email: email,
        role: adminUser.role,
      }
    });
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
      role: req.session.role,
      loginTime: req.session.loginTime
    });
  } else {
    res.json({ authenticated: false });
  }
});

/**
 * POST /auth/forgot-password
 * Send password reset email
 */
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${process.env.DASHBOARD_URL || 'https://open-word-dashboard-development.onrender.com'}/reset-password`,
    });

    if (error) {
      console.error('Password reset error:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, message: 'Password reset email sent' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to send reset email' });
  }
});

export default router;
