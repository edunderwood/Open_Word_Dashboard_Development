/**
 * Logs & Metrics Routes
 *
 * Provides server metrics, logging control, and debug options
 * for the OpenWord admin dashboard
 */

import express from 'express';

const router = express.Router();

// Store log settings (in production, consider using a database)
let logSettings = {
  debugTranslation: false,
  extraDebugging: false,
  verboseMetrics: true,
  alertThreshold: 3 // Consecutive failures before alerting
};

// Store recent logs (circular buffer)
const recentLogs = [];
const MAX_LOGS = 500;

/**
 * GET /api/logs/metrics
 * Fetch metrics from the OpenWord server
 */
router.get('/metrics', async (req, res) => {
  try {
    const serverUrl = process.env.OPENWORD_SERVER_URL || 'https://openword.onrender.com';
    const response = await fetch(`${serverUrl}/metrics`);

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    const metrics = await response.json();

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        server: serverUrl,
        ...metrics
      }
    });
  } catch (error) {
    console.error('Error fetching metrics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch server metrics',
      message: error.message
    });
  }
});

/**
 * GET /api/logs/settings
 * Get current log settings
 */
router.get('/settings', (req, res) => {
  res.json({
    success: true,
    data: logSettings
  });
});

/**
 * POST /api/logs/settings
 * Update log settings
 */
router.post('/settings', (req, res) => {
  try {
    const { debugTranslation, extraDebugging, verboseMetrics, alertThreshold } = req.body;

    // Update settings
    if (typeof debugTranslation === 'boolean') logSettings.debugTranslation = debugTranslation;
    if (typeof extraDebugging === 'boolean') logSettings.extraDebugging = extraDebugging;
    if (typeof verboseMetrics === 'boolean') logSettings.verboseMetrics = verboseMetrics;
    if (typeof alertThreshold === 'number') logSettings.alertThreshold = alertThreshold;

    console.log('📝 Log settings updated:', logSettings);

    res.json({
      success: true,
      message: 'Settings updated',
      data: logSettings
    });
  } catch (error) {
    console.error('Error updating log settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update settings'
    });
  }
});

/**
 * GET /api/logs/recent
 * Get recent dashboard logs
 */
router.get('/recent', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const logs = recentLogs.slice(0, limit);

  res.json({
    success: true,
    count: logs.length,
    data: logs
  });
});

/**
 * POST /api/logs/entry
 * Add a log entry (for internal use)
 */
router.post('/entry', (req, res) => {
  try {
    const { level, message, category, details } = req.body;

    const entry = {
      timestamp: new Date().toISOString(),
      level: level || 'info',
      category: category || 'general',
      message,
      details
    };

    recentLogs.unshift(entry);
    if (recentLogs.length > MAX_LOGS) {
      recentLogs.length = MAX_LOGS;
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/logs/clear
 * Clear all recent logs
 */
router.delete('/clear', (req, res) => {
  recentLogs.length = 0;
  console.log('📝 Logs cleared');
  res.json({ success: true, message: 'Logs cleared' });
});

/**
 * GET /api/logs/export
 * Export logs as JSON
 */
router.get('/export', (req, res) => {
  const filename = `openword-logs-${new Date().toISOString().split('T')[0]}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.json({
    exportedAt: new Date().toISOString(),
    settings: logSettings,
    logs: recentLogs
  });
});

/**
 * Add log entry programmatically
 */
export function addLogEntry(level, category, message, details = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    category,
    message,
    details
  };

  recentLogs.unshift(entry);
  if (recentLogs.length > MAX_LOGS) {
    recentLogs.length = MAX_LOGS;
  }

  return entry;
}

/**
 * Get current log settings
 */
export function getLogSettings() {
  return { ...logSettings };
}

export default router;
