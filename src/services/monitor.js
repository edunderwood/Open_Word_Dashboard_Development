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

// Store for tracking issues
const issueTracker = {
  serverDown: false,
  lastServerCheck: null,
  consecutiveFailures: 0,
  lastAlertSent: {},
};

/**
 * Check if OpenWord main server is healthy
 */
async function checkServerHealth() {
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

    if (response.ok) {
      if (issueTracker.serverDown) {
        // Server recovered
        await sendWarningAlert(
          'Server Recovered',
          `<p>OpenWord server is back online after ${issueTracker.consecutiveFailures} failed checks.</p>
           <p>URL: ${OPENWORD_SERVER_URL}</p>`
        );
      }
      issueTracker.serverDown = false;
      issueTracker.consecutiveFailures = 0;
      issueTracker.lastServerCheck = new Date();
      return { healthy: true, status: response.status };
    } else {
      throw new Error(`Server returned ${response.status}`);
    }
  } catch (error) {
    issueTracker.consecutiveFailures++;
    issueTracker.lastServerCheck = new Date();

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

    return { healthy: false, error: error.message };
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
 * Run all monitoring checks
 */
export async function runAllChecks() {
  console.log('🔍 Running monitoring checks...');

  const results = {
    timestamp: new Date().toISOString(),
    server: await checkServerHealth(),
    database: await checkDatabaseHealth(),
    paymentIssues: await checkPaymentIssues(),
    usageAnomalies: await checkUsageAnomalies(),
    charityReviews: await checkPendingCharityReviews(),
  };

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
