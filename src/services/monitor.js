/**
 * System Monitoring Service
 *
 * Runs background checks and sends alerts for critical issues
 */

import cron from 'node-cron';
import supabase from './supabase.js';
import stripe from './stripe.js';
import { sendCriticalAlert, sendWarningAlert } from './email.js';
import dotenv from 'dotenv';

dotenv.config();

const OPENWORD_SERVER_URL = process.env.OPENWORD_SERVER_URL || 'https://openword.onrender.com';
const MONITOR_INTERVAL = parseInt(process.env.MONITOR_INTERVAL_MINUTES || '5');

// Performance thresholds (in milliseconds)
const PERFORMANCE_WARNING_THRESHOLD = 3000; // 3 seconds
const PERFORMANCE_CRITICAL_THRESHOLD = 8000; // 8 seconds

// Store for tracking issues
const issueTracker = {
  serverDown: false,
  lastServerCheck: null,
  consecutiveFailures: 0,
  consecutiveSlowResponses: 0,
  lastResponseTime: null,
  lastAlertSent: {},
};

/**
 * Check if OpenWord main server is healthy
 */
async function checkServerHealth() {
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    // Try multiple endpoints - /health first, then root
    let response = await fetch(`${OPENWORD_SERVER_URL}/health`, {
      signal: controller.signal,
    }).catch(() => null);

    // If /health fails, try root endpoint
    if (!response || !response.ok) {
      response = await fetch(OPENWORD_SERVER_URL, {
        signal: controller.signal,
      });
    }

    clearTimeout(timeout);
    const responseTime = Date.now() - startTime;
    issueTracker.lastResponseTime = responseTime;

    if (response.ok) {
      if (issueTracker.serverDown) {
        // Server recovered
        await sendWarningAlert(
          'Server Recovered',
          `<p>OpenWord server is back online after ${issueTracker.consecutiveFailures} failed checks.</p>
           <p>URL: ${OPENWORD_SERVER_URL}</p>
           <p>Response time: ${responseTime}ms</p>`
        );
      }
      issueTracker.serverDown = false;
      issueTracker.consecutiveFailures = 0;
      issueTracker.lastServerCheck = new Date();

      return { healthy: true, status: response.status, responseTime };
    } else {
      throw new Error(`Server returned ${response.status}`);
    }
  } catch (error) {
    const responseTime = Date.now() - startTime;
    issueTracker.consecutiveFailures++;
    issueTracker.lastServerCheck = new Date();
    issueTracker.lastResponseTime = responseTime;

    // Send critical alert after 3 consecutive failures
    if (issueTracker.consecutiveFailures >= 3 && !issueTracker.serverDown) {
      issueTracker.serverDown = true;
      await sendCriticalAlert(
        'Server Down',
        `<p>OpenWord server is not responding!</p>
         <p>URL: ${OPENWORD_SERVER_URL}</p>
         <p>Error: ${error.message}</p>
         <p>Failed checks: ${issueTracker.consecutiveFailures}</p>`
      );
    }

    return { healthy: false, error: error.message, responseTime };
  }
}

/**
 * Check server performance (response times)
 */
async function checkServerPerformance() {
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15 second timeout for performance check

    // Test the health endpoint
    const response = await fetch(`${OPENWORD_SERVER_URL}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const responseTime = Date.now() - startTime;

    // Check if response time is concerning
    let performanceStatus = 'good';

    if (responseTime >= PERFORMANCE_CRITICAL_THRESHOLD) {
      performanceStatus = 'critical';
      issueTracker.consecutiveSlowResponses++;

      // Alert after 2 consecutive critical slow responses
      if (issueTracker.consecutiveSlowResponses >= 2) {
        const shouldAlert = !issueTracker.lastAlertSent.performanceCritical ||
          (Date.now() - issueTracker.lastAlertSent.performanceCritical) > 30 * 60 * 1000; // 30 minutes

        if (shouldAlert) {
          await sendCriticalAlert(
            'Critical Performance Issue',
            `<p>OpenWord server is responding extremely slowly!</p>
             <p>Response time: <strong>${(responseTime / 1000).toFixed(2)} seconds</strong></p>
             <p>Threshold: ${(PERFORMANCE_CRITICAL_THRESHOLD / 1000).toFixed(1)} seconds</p>
             <p>Consecutive slow responses: ${issueTracker.consecutiveSlowResponses}</p>
             <p>URL: ${OPENWORD_SERVER_URL}</p>
             <p style="color: #dc3545;">This may affect user experience. Consider checking server resources and logs.</p>`
          );
          issueTracker.lastAlertSent.performanceCritical = Date.now();
        }
      }
    } else if (responseTime >= PERFORMANCE_WARNING_THRESHOLD) {
      performanceStatus = 'warning';
      issueTracker.consecutiveSlowResponses++;

      // Alert after 3 consecutive warning-level slow responses
      if (issueTracker.consecutiveSlowResponses >= 3) {
        const shouldAlert = !issueTracker.lastAlertSent.performanceWarning ||
          (Date.now() - issueTracker.lastAlertSent.performanceWarning) > 60 * 60 * 1000; // 1 hour

        if (shouldAlert) {
          await sendWarningAlert(
            'Server Performance Degraded',
            `<p>OpenWord server response times are elevated.</p>
             <p>Response time: <strong>${(responseTime / 1000).toFixed(2)} seconds</strong></p>
             <p>Warning threshold: ${(PERFORMANCE_WARNING_THRESHOLD / 1000).toFixed(1)} seconds</p>
             <p>Consecutive slow responses: ${issueTracker.consecutiveSlowResponses}</p>
             <p>URL: ${OPENWORD_SERVER_URL}</p>
             <p>This may indicate the server is under heavy load or experiencing issues.</p>`
          );
          issueTracker.lastAlertSent.performanceWarning = Date.now();
        }
      }
    } else {
      // Performance is good - reset counter
      if (issueTracker.consecutiveSlowResponses > 0) {
        console.log(`✅ Server performance recovered (was ${issueTracker.consecutiveSlowResponses} consecutive slow responses)`);
      }
      issueTracker.consecutiveSlowResponses = 0;
    }

    return {
      responseTime,
      status: performanceStatus,
      threshold: {
        warning: PERFORMANCE_WARNING_THRESHOLD,
        critical: PERFORMANCE_CRITICAL_THRESHOLD
      },
      consecutiveSlowResponses: issueTracker.consecutiveSlowResponses
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;

    // Timeout or other error - treat as critical performance issue
    issueTracker.consecutiveSlowResponses++;

    return {
      responseTime,
      status: 'error',
      error: error.message,
      consecutiveSlowResponses: issueTracker.consecutiveSlowResponses
    };
  }
}

/**
 * Check for customers with payment issues
 */
async function checkPaymentIssues() {
  try {
    const { data: orgs, error } = await supabase
      .from('organisations')
      .select('id, name, stripe_customer_id, subscription_status')
      .in('subscription_status', ['past_due', 'unpaid']);

    if (error) throw error;

    if (orgs && orgs.length > 0) {
      const shouldAlert = !issueTracker.lastAlertSent.paymentIssues ||
        (Date.now() - issueTracker.lastAlertSent.paymentIssues) > 24 * 60 * 60 * 1000; // 24 hours

      if (shouldAlert) {
        await sendWarningAlert(
          'Payment Issues Detected',
          `<p>${orgs.length} customer(s) have payment issues:</p>
           <ul>
             ${orgs.map(o => `<li>${o.name} - Status: ${o.subscription_status}</li>`).join('')}
           </ul>`
        );
        issueTracker.lastAlertSent.paymentIssues = Date.now();
      }
    }

    return { count: orgs?.length || 0, customers: orgs || [] };
  } catch (error) {
    console.error('Error checking payment issues:', error);
    return { error: error.message };
  }
}

/**
 * Check for unusual usage patterns
 */
async function checkUsageAnomalies() {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Get usage in last 24 hours
    const { data: recentUsage, error } = await supabase
      .from('translation_usage')
      .select('organisation_id, character_count')
      .gte('created_at', oneDayAgo);

    if (error) throw error;

    // Aggregate by organisation
    const usageByOrg = {};
    for (const record of recentUsage || []) {
      if (!usageByOrg[record.organisation_id]) {
        usageByOrg[record.organisation_id] = 0;
      }
      usageByOrg[record.organisation_id] += record.character_count || 0;
    }

    // Flag organisations with unusually high usage (> 10 million characters in 24h)
    const highUsageOrgs = Object.entries(usageByOrg)
      .filter(([_, count]) => count > 10000000)
      .map(([orgId, count]) => ({ orgId, count }));

    if (highUsageOrgs.length > 0) {
      const shouldAlert = !issueTracker.lastAlertSent.highUsage ||
        (Date.now() - issueTracker.lastAlertSent.highUsage) > 6 * 60 * 60 * 1000; // 6 hours

      if (shouldAlert) {
        // Get org names
        const { data: orgs } = await supabase
          .from('organisations')
          .select('id, name')
          .in('id', highUsageOrgs.map(o => o.orgId));

        const orgNames = {};
        orgs?.forEach(o => orgNames[o.id] = o.name);

        await sendWarningAlert(
          'High Usage Detected',
          `<p>The following organisations have unusually high usage in the last 24 hours:</p>
           <ul>
             ${highUsageOrgs.map(o => `<li>${orgNames[o.orgId] || o.orgId}: ${(o.count / 1000000).toFixed(2)}M characters</li>`).join('')}
           </ul>`
        );
        issueTracker.lastAlertSent.highUsage = Date.now();
      }
    }

    return { highUsageOrgs };
  } catch (error) {
    console.error('Error checking usage anomalies:', error);
    return { error: error.message };
  }
}

/**
 * Check database connectivity
 */
async function checkDatabaseHealth() {
  try {
    const { data, error } = await supabase
      .from('organisations')
      .select('id')
      .limit(1);

    if (error) throw error;
    return { healthy: true };
  } catch (error) {
    if (!issueTracker.lastAlertSent.database ||
        (Date.now() - issueTracker.lastAlertSent.database) > 30 * 60 * 1000) { // 30 minutes
      await sendCriticalAlert(
        'Database Connection Issue',
        `<p>Unable to connect to Supabase database!</p>
         <p>Error: ${error.message}</p>`
      );
      issueTracker.lastAlertSent.database = Date.now();
    }
    return { healthy: false, error: error.message };
  }
}

/**
 * Check for pending charity review requests
 */
async function checkPendingCharityReviews() {
  try {
    const { data: pendingReviews, error } = await supabase
      .from('organisations')
      .select('id, name, charity_number, charity_region, charity_review_reason, charity_review_requested_at, contact_name')
      .eq('charity_review_requested', true)
      .eq('charity_verified', false)
      .order('charity_review_requested_at', { ascending: true });

    if (error) throw error;

    const count = pendingReviews?.length || 0;

    if (count > 0) {
      // Check if we've already alerted about these specific reviews
      const reviewIds = pendingReviews.map(r => r.id).sort().join(',');
      const lastAlertedIds = issueTracker.lastAlertSent.charityReviewIds || '';

      // Alert if there are new reviews we haven't alerted about
      if (reviewIds !== lastAlertedIds) {
        await sendWarningAlert(
          `${count} Charity Review Request${count > 1 ? 's' : ''} Pending`,
          `<p>The following organisations have requested manual charity verification:</p>
           <ul>
             ${pendingReviews.map(r => `
               <li>
                 <strong>${r.name}</strong><br>
                 Charity Number: ${r.charity_number || 'Not provided'}<br>
                 Region: ${r.charity_region || 'Unknown'}<br>
                 Contact: ${r.contact_name || 'Unknown'}<br>
                 Requested: ${new Date(r.charity_review_requested_at).toLocaleString()}<br>
                 ${r.charity_review_reason ? `Reason: ${r.charity_review_reason}` : ''}
               </li>
             `).join('')}
           </ul>
           <p><a href="${process.env.DASHBOARD_URL || 'https://openword-dashboard.onrender.com'}/charity-registers">
             Review in Dashboard
           </a></p>`
        );
        issueTracker.lastAlertSent.charityReviewIds = reviewIds;
      }
    }

    return { count, reviews: pendingReviews || [] };
  } catch (error) {
    console.error('Error checking charity reviews:', error);
    return { error: error.message };
  }
}

/**
 * Check for pending discount review requests (non-charities)
 */
async function checkPendingDiscountReviews() {
  try {
    const { data: pendingReviews, error } = await supabase
      .from('organisations')
      .select('id, name, discount_review_reason, discount_review_requested_at, contact_name, subscription_tier')
      .eq('discount_review_requested', true)
      .eq('discount_percent', 0)
      .order('discount_review_requested_at', { ascending: true });

    if (error) throw error;

    const count = pendingReviews?.length || 0;

    if (count > 0) {
      // Check if we've already alerted about these specific reviews
      const reviewIds = pendingReviews.map(r => r.id).sort().join(',');
      const lastAlertedIds = issueTracker.lastAlertSent.discountReviewIds || '';

      // Alert if there are new reviews we haven't alerted about
      if (reviewIds !== lastAlertedIds) {
        await sendWarningAlert(
          `${count} Discount Review Request${count > 1 ? 's' : ''} Pending`,
          `<p>The following organisations have requested a discount:</p>
           <ul>
             ${pendingReviews.map(r => `
               <li>
                 <strong>${r.name}</strong><br>
                 Plan: ${r.subscription_tier || 'Unknown'}<br>
                 Contact: ${r.contact_name || 'Unknown'}<br>
                 Requested: ${new Date(r.discount_review_requested_at).toLocaleString()}<br>
                 ${r.discount_review_reason ? `Reason: ${r.discount_review_reason}` : 'No reason provided'}
               </li>
             `).join('')}
           </ul>
           <p><a href="${process.env.DASHBOARD_URL || 'https://openword-dashboard.onrender.com'}/dashboard">
             Review in Dashboard
           </a></p>`
        );
        issueTracker.lastAlertSent.discountReviewIds = reviewIds;
      }
    }

    return { count, reviews: pendingReviews || [] };
  } catch (error) {
    console.error('Error checking discount reviews:', error);
    return { error: error.message };
  }
}

/**
 * Run all monitoring checks
 */
export async function runAllChecks() {
  console.log('🔍 Running monitoring checks...');

  const results = {
    timestamp: new Date().toISOString(),
    server: await checkServerHealth(),
    performance: await checkServerPerformance(),
    database: await checkDatabaseHealth(),
    paymentIssues: await checkPaymentIssues(),
    usageAnomalies: await checkUsageAnomalies(),
    charityReviews: await checkPendingCharityReviews(),
    discountReviews: await checkPendingDiscountReviews(),
  };

  // Log performance summary
  if (results.performance) {
    const perfStatus = results.performance.status;
    const respTime = results.performance.responseTime;
    if (perfStatus === 'good') {
      console.log(`⚡ Server performance: ${respTime}ms (good)`);
    } else if (perfStatus === 'warning') {
      console.log(`⚠️ Server performance: ${respTime}ms (slow)`);
    } else if (perfStatus === 'critical') {
      console.log(`🚨 Server performance: ${respTime}ms (critical)`);
    }
  }

  console.log('✅ Monitoring checks completed:', JSON.stringify(results, null, 2));
  return results;
}

/**
 * Start background monitoring
 */
export function startMonitoring() {
  console.log(`🔄 Starting background monitoring (every ${MONITOR_INTERVAL} minutes)`);

  // Run immediately on startup
  runAllChecks();

  // Schedule recurring checks
  cron.schedule(`*/${MONITOR_INTERVAL} * * * *`, () => {
    runAllChecks();
  });
}

export default { startMonitoring, runAllChecks };
