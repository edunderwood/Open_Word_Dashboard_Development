/**
 * Analytics Routes
 * Endpoints for fetching analytics from external services
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDeepgramAnalytics } from '../services/deepgram-analytics.js';
import { getRenderAnalytics } from '../services/render-analytics.js';
import { getGoogleAnalytics } from '../services/google-analytics.js';
import { getVercelAnalytics } from '../services/vercel-analytics.js';
import { getSupabaseAnalytics } from '../services/supabase-analytics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

/**
 * Middleware to check authentication
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/login');
}

/**
 * GET /analytics - Get analytics page
 */
router.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../../views/analytics.html'));
});

/**
 * GET /analytics/deepgram - Get Deepgram usage analytics
 */
router.get('/deepgram', requireAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const analytics = await getDeepgramAnalytics(days);
    res.json(analytics);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /analytics/render - Get Render.com service analytics
 */
router.get('/render', requireAuth, async (req, res) => {
  try {
    const analytics = await getRenderAnalytics();
    res.json(analytics);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /analytics/google - Get Google Cloud Translation analytics
 */
router.get('/google', requireAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const analytics = await getGoogleAnalytics(days);
    res.json(analytics);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /analytics/vercel - Get Vercel deployment analytics
 */
router.get('/vercel', requireAuth, async (req, res) => {
  try {
    const analytics = await getVercelAnalytics();
    res.json(analytics);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /analytics/supabase - Get Supabase database analytics
 */
router.get('/supabase', requireAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const analytics = await getSupabaseAnalytics(days);
    res.json(analytics);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /analytics/all - Get all analytics in one call
 */
router.get('/all', requireAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;

    // Fetch all analytics in parallel
    const [deepgram, render, google, vercel] = await Promise.all([
      getDeepgramAnalytics(days).catch(e => ({ success: false, error: e.message })),
      getRenderAnalytics().catch(e => ({ success: false, error: e.message })),
      getGoogleAnalytics(days).catch(e => ({ success: false, error: e.message })),
      getVercelAnalytics().catch(e => ({ success: false, error: e.message })),
    ]);

    res.json({
      success: true,
      data: {
        deepgram,
        render,
        google,
        vercel,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
