/**
 * Costs Routes
 * Endpoints for fetching costs and revenue analytics
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCostsAnalytics } from '../services/costs-analytics.js';

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
 * GET /costs - Get costs page
 */
router.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../../views/costs.html'));
});

/**
 * GET /costs/summary - Get costs and revenue summary
 */
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const analytics = await getCostsAnalytics();
    res.json(analytics);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
