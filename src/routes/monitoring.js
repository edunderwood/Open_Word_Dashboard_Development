/**
 * Monitoring Status Routes
 */

import express from 'express';
import { runAllChecks } from '../services/monitor.js';
import { sendAlert, sendCriticalAlert, sendWarningAlert } from '../services/email.js';

const router = express.Router();

// Store monitoring results
let lastCheckResults = null;
let checkHistory = [];
const MAX_HISTORY = 100;

/**
 * GET /api/monitoring/status
 * Get current monitoring status
 */
router.get('/status', async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        lastCheck: lastCheckResults,
        historyCount: checkHistory.length,
      },
    });
  } catch (error) {
    console.error('Error fetching monitoring status:', error);
    res.status(500).json({ error: 'Failed to fetch monitoring status' });
  }
});

/**
 * GET /api/monitoring/history
 * Get monitoring check history
 */
router.get('/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const history = checkHistory.slice(0, limit);

    res.json({
      success: true,
      data: history,
    });
  } catch (error) {
    console.error('Error fetching monitoring history:', error);
    res.status(500).json({ error: 'Failed to fetch monitoring history' });
  }
});

/**
 * POST /api/monitoring/run
 * Manually trigger a monitoring check
 */
router.post('/run', async (req, res) => {
  try {
    console.log('🔍 Manual monitoring check triggered');
    const results = await runAllChecks();

    // Store results
    lastCheckResults = results;
    checkHistory.unshift(results);
    if (checkHistory.length > MAX_HISTORY) {
      checkHistory = checkHistory.slice(0, MAX_HISTORY);
    }

    res.json({
      success: true,
      message: 'Monitoring check completed',
      data: results,
    });
  } catch (error) {
    console.error('Error running monitoring check:', error);
    res.status(500).json({ error: 'Failed to run monitoring check' });
  }
});

/**
 * GET /api/monitoring/health
 * Quick health check endpoint
 */
router.get('/health', async (req, res) => {
  try {
    const isHealthy = lastCheckResults
      ? lastCheckResults.server?.healthy && lastCheckResults.database?.healthy
      : null;

    res.json({
      success: true,
      data: {
        healthy: isHealthy,
        lastCheck: lastCheckResults?.timestamp || null,
        issues: getActiveIssues(),
      },
    });
  } catch (error) {
    console.error('Error checking health:', error);
    res.status(500).json({ error: 'Failed to check health' });
  }
});

/**
 * GET /api/monitoring/issues
 * Get list of active issues
 */
router.get('/issues', async (req, res) => {
  try {
    const issues = getActiveIssues();

    res.json({
      success: true,
      data: issues,
    });
  } catch (error) {
    console.error('Error fetching issues:', error);
    res.status(500).json({ error: 'Failed to fetch issues' });
  }
});

/**
 * Helper function to extract active issues from last check
 */
function getActiveIssues() {
  if (!lastCheckResults) return [];

  const issues = [];

  if (lastCheckResults.server && !lastCheckResults.server.healthy) {
    issues.push({
      type: 'critical',
      category: 'server',
      message: `Server is down: ${lastCheckResults.server.error}`,
      timestamp: lastCheckResults.timestamp,
    });
  }

  if (lastCheckResults.database && !lastCheckResults.database.healthy) {
    issues.push({
      type: 'critical',
      category: 'database',
      message: `Database connection failed: ${lastCheckResults.database.error}`,
      timestamp: lastCheckResults.timestamp,
    });
  }

  if (lastCheckResults.paymentIssues && lastCheckResults.paymentIssues.count > 0) {
    issues.push({
      type: 'warning',
      category: 'payments',
      message: `${lastCheckResults.paymentIssues.count} customer(s) with payment issues`,
      timestamp: lastCheckResults.timestamp,
      details: lastCheckResults.paymentIssues.customers,
    });
  }

  if (lastCheckResults.usageAnomalies && lastCheckResults.usageAnomalies.highUsageOrgs?.length > 0) {
    issues.push({
      type: 'warning',
      category: 'usage',
      message: `${lastCheckResults.usageAnomalies.highUsageOrgs.length} organisation(s) with unusually high usage`,
      timestamp: lastCheckResults.timestamp,
      details: lastCheckResults.usageAnomalies.highUsageOrgs,
    });
  }

  return issues;
}

/**
 * POST /api/monitoring/test-email
 * Send a test email to verify email configuration
 */
router.post('/test-email', async (req, res) => {
  try {
    const { type = 'info' } = req.body;

    console.log(`📧 Test email requested (type: ${type})`);

    let result;
    const timestamp = new Date().toISOString();

    switch (type) {
      case 'critical':
        result = await sendCriticalAlert(
          'Test Critical Alert',
          `This is a test critical alert sent at ${timestamp}.\n\nIf you received this email, your critical alert system is working correctly.`
        );
        break;
      case 'warning':
        result = await sendWarningAlert(
          'Test Warning Alert',
          `This is a test warning alert sent at ${timestamp}.\n\nIf you received this email, your warning alert system is working correctly.`
        );
        break;
      default:
        result = await sendAlert(
          'Test Email Notification',
          `This is a test email from OpenWord Dashboard sent at ${timestamp}.\n\nIf you received this email, your email notification system is configured correctly.`
        );
    }

    if (result.success) {
      console.log(`✅ Test email sent successfully (type: ${type})`);
      res.json({
        success: true,
        message: `Test ${type} email sent successfully`,
        timestamp
      });
    } else {
      console.error(`❌ Test email failed:`, result.error);
      res.status(500).json({
        success: false,
        error: result.error || 'Failed to send test email'
      });
    }
  } catch (error) {
    console.error('Error sending test email:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to send test email'
    });
  }
});

/**
 * GET /api/monitoring/email-config
 * Check email configuration status (without exposing credentials)
 */
router.get('/email-config', async (req, res) => {
  try {
    const config = {
      smtpHost: process.env.SMTP_HOST ? '✓ Configured' : '✗ Missing',
      smtpPort: process.env.SMTP_PORT ? '✓ Configured' : '✗ Missing (using default 587)',
      smtpUser: process.env.SMTP_USER ? '✓ Configured' : '✗ Missing',
      smtpPass: process.env.SMTP_PASS ? '✓ Configured' : '✗ Missing',
      alertRecipient: process.env.ALERT_EMAIL || process.env.ADMIN_EMAIL || 'Not configured',
      fromAddress: process.env.SMTP_FROM || process.env.SMTP_USER || 'Not configured'
    };

    const isConfigured = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS;

    res.json({
      success: true,
      configured: isConfigured,
      config
    });
  } catch (error) {
    console.error('Error checking email config:', error);
    res.status(500).json({ error: 'Failed to check email configuration' });
  }
});

/**
 * Update stored results (called by monitor service)
 */
export function updateMonitoringResults(results) {
  lastCheckResults = results;
  checkHistory.unshift(results);
  if (checkHistory.length > MAX_HISTORY) {
    checkHistory = checkHistory.slice(0, MAX_HISTORY);
  }
}

export default router;
