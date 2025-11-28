/**
 * Deepgram Analytics Service
 * Fetches usage data from Deepgram API
 */

import dotenv from 'dotenv';

dotenv.config();

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DEEPGRAM_PROJECT_ID = process.env.DEEPGRAM_PROJECT_ID;
const BASE_URL = 'https://api.deepgram.com/v1';

/**
 * Make authenticated request to Deepgram API
 */
async function deepgramRequest(endpoint) {
  if (!DEEPGRAM_API_KEY) {
    throw new Error('DEEPGRAM_API_KEY not configured');
  }

  const response = await fetch(`${BASE_URL}${endpoint}`, {
    headers: {
      'Authorization': `Token ${DEEPGRAM_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Deepgram API error: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Get usage summary for a date range
 * @param {string} startDate - ISO date string
 * @param {string} endDate - ISO date string
 */
export async function getUsageSummary(startDate, endDate) {
  if (!DEEPGRAM_PROJECT_ID) {
    throw new Error('DEEPGRAM_PROJECT_ID not configured');
  }

  const params = new URLSearchParams({
    start: startDate,
    end: endDate,
  });

  const data = await deepgramRequest(`/projects/${DEEPGRAM_PROJECT_ID}/usage?${params}`);
  return data;
}

/**
 * Get detailed usage requests
 * @param {string} startDate - ISO date string
 * @param {string} endDate - ISO date string
 * @param {number} limit - Max results
 */
export async function getUsageRequests(startDate, endDate, limit = 100) {
  if (!DEEPGRAM_PROJECT_ID) {
    throw new Error('DEEPGRAM_PROJECT_ID not configured');
  }

  const params = new URLSearchParams({
    start: startDate,
    end: endDate,
    limit: limit.toString(),
  });

  const data = await deepgramRequest(`/projects/${DEEPGRAM_PROJECT_ID}/requests?${params}`);
  return data;
}

/**
 * Get project balances
 */
export async function getBalances() {
  if (!DEEPGRAM_PROJECT_ID) {
    throw new Error('DEEPGRAM_PROJECT_ID not configured');
  }

  const data = await deepgramRequest(`/projects/${DEEPGRAM_PROJECT_ID}/balances`);
  return data;
}

/**
 * Get project details
 */
export async function getProject() {
  if (!DEEPGRAM_PROJECT_ID) {
    throw new Error('DEEPGRAM_PROJECT_ID not configured');
  }

  const data = await deepgramRequest(`/projects/${DEEPGRAM_PROJECT_ID}`);
  return data;
}

/**
 * Get all projects (to list available projects)
 */
export async function getProjects() {
  const data = await deepgramRequest('/projects');
  return data;
}

/**
 * Get usage breakdown by model/feature
 * @param {string} startDate - ISO date string
 * @param {string} endDate - ISO date string
 */
export async function getUsageFields(startDate, endDate) {
  if (!DEEPGRAM_PROJECT_ID) {
    throw new Error('DEEPGRAM_PROJECT_ID not configured');
  }

  const params = new URLSearchParams({
    start: startDate,
    end: endDate,
  });

  const data = await deepgramRequest(`/projects/${DEEPGRAM_PROJECT_ID}/usage/fields?${params}`);
  return data;
}

/**
 * Format date as YYYY-MM-DD for Deepgram API
 */
function formatDate(date) {
  return date.toISOString().split('T')[0];
}

/**
 * Calculate performance stats from request data
 */
function calculatePerformanceStats(requests) {
  if (!requests || requests.length === 0) {
    return null;
  }

  // Extract duration data from requests
  const durations = requests
    .filter(r => r.duration && r.duration > 0)
    .map(r => r.duration);

  if (durations.length === 0) {
    return null;
  }

  // Sort for percentile calculations
  durations.sort((a, b) => a - b);

  const sum = durations.reduce((a, b) => a + b, 0);
  const avg = sum / durations.length;
  const min = durations[0];
  const max = durations[durations.length - 1];
  const p50 = durations[Math.floor(durations.length * 0.5)];
  const p95 = durations[Math.floor(durations.length * 0.95)];

  return {
    avgDurationSec: avg.toFixed(2),
    minDurationSec: min.toFixed(2),
    maxDurationSec: max.toFixed(2),
    p50DurationSec: p50.toFixed(2),
    p95DurationSec: p95.toFixed(2),
    sampleSize: durations.length,
  };
}

/**
 * Calculate capacity analysis and warnings
 */
function calculateCapacityAnalysis(usage, balances) {
  const warnings = [];
  const metrics = {};

  // Deepgram limits for Pay-as-you-go/Growth plans
  const CONCURRENT_STREAM_LIMIT = 50;
  const CONCURRENT_PRERECORDED_LIMIT = 100;

  // Calculate daily usage patterns
  if (usage.results && usage.results.length > 0) {
    const dailyRequests = usage.results.map(d => d.requests || 0);
    const dailyHours = usage.results.map(d => d.hours || 0);

    const avgDailyRequests = dailyRequests.reduce((a, b) => a + b, 0) / dailyRequests.length;
    const maxDailyRequests = Math.max(...dailyRequests);
    const avgDailyHours = dailyHours.reduce((a, b) => a + b, 0) / dailyHours.length;
    const maxDailyHours = Math.max(...dailyHours);

    metrics.avgDailyRequests = avgDailyRequests.toFixed(1);
    metrics.maxDailyRequests = maxDailyRequests;
    metrics.avgDailyHours = avgDailyHours.toFixed(2);
    metrics.maxDailyHours = maxDailyHours.toFixed(2);

    // Estimate peak concurrent sessions (assuming avg session ~10 min, peak hour = 20% of daily)
    const avgSessionMinutes = (avgDailyHours * 60) / (avgDailyRequests || 1);
    const estimatedPeakConcurrent = Math.ceil((maxDailyRequests * 0.2) / (60 / avgSessionMinutes));

    metrics.avgSessionMinutes = avgSessionMinutes.toFixed(1);
    metrics.estimatedPeakConcurrent = estimatedPeakConcurrent;
    metrics.concurrentLimit = CONCURRENT_STREAM_LIMIT;
    metrics.capacityUsedPercent = ((estimatedPeakConcurrent / CONCURRENT_STREAM_LIMIT) * 100).toFixed(1);

    // Capacity warnings
    if (estimatedPeakConcurrent > CONCURRENT_STREAM_LIMIT * 0.8) {
      warnings.push({
        level: 'critical',
        message: `Peak concurrent streams (${estimatedPeakConcurrent}) approaching limit of ${CONCURRENT_STREAM_LIMIT}. Consider upgrading to Enterprise plan.`,
      });
    } else if (estimatedPeakConcurrent > CONCURRENT_STREAM_LIMIT * 0.5) {
      warnings.push({
        level: 'warning',
        message: `Peak concurrent streams at ${metrics.capacityUsedPercent}% of limit. Monitor during high-usage events.`,
      });
    }

    // Usage trend warning
    if (dailyRequests.length >= 7) {
      const recentAvg = dailyRequests.slice(-7).reduce((a, b) => a + b, 0) / 7;
      const olderAvg = dailyRequests.slice(0, 7).reduce((a, b) => a + b, 0) / 7;
      if (olderAvg > 0 && recentAvg > olderAvg * 1.5) {
        warnings.push({
          level: 'info',
          message: `Usage increased ${((recentAvg / olderAvg - 1) * 100).toFixed(0)}% in recent week. Plan for capacity accordingly.`,
        });
      }
    }
  }

  // Balance warnings
  if (balances.balances && balances.balances.length > 0) {
    const totalBalance = balances.balances.reduce((sum, b) => sum + (b.amount || 0), 0);
    metrics.totalBalance = totalBalance.toFixed(2);

    // Estimate days remaining based on usage
    if (usage.results && usage.results.length > 0) {
      const totalCost = usage.results.reduce((sum, d) => sum + (d.total_amount || 0), 0);
      const avgDailyCost = totalCost / usage.results.length;
      if (avgDailyCost > 0) {
        const daysRemaining = totalBalance / avgDailyCost;
        metrics.estimatedDaysRemaining = Math.floor(daysRemaining);

        if (daysRemaining < 30) {
          warnings.push({
            level: 'warning',
            message: `Balance will last approximately ${Math.floor(daysRemaining)} days at current usage rate.`,
          });
        } else if (daysRemaining < 90) {
          warnings.push({
            level: 'info',
            message: `Balance estimated to last ${Math.floor(daysRemaining)} days.`,
          });
        }
      }
    }
  }

  return { metrics, warnings };
}

/**
 * Get comprehensive analytics for dashboard
 */
export async function getDeepgramAnalytics(days = 30) {
  const endDate = formatDate(new Date());
  const startDate = formatDate(new Date(Date.now() - days * 24 * 60 * 60 * 1000));

  try {
    const [usage, balances, project, requests] = await Promise.all([
      getUsageSummary(startDate, endDate).catch(e => ({ error: e.message })),
      getBalances().catch(e => ({ error: e.message })),
      getProject().catch(e => ({ error: e.message })),
      getUsageRequests(startDate, endDate, 100).catch(e => ({ error: e.message })),
    ]);

    // Calculate totals from usage data
    let totalHours = 0;
    let totalRequests = 0;
    let totalCost = 0;

    if (usage.results) {
      usage.results.forEach(day => {
        totalHours += day.hours || 0;
        totalRequests += day.requests || 0;
        totalCost += day.total_amount || 0;
      });
    }

    // Calculate performance stats from individual requests
    const performanceStats = calculatePerformanceStats(requests.requests || requests);

    // Calculate capacity analysis
    const capacityAnalysis = calculateCapacityAnalysis(usage, balances);

    return {
      success: true,
      data: {
        period: { start: startDate, end: endDate, days },
        summary: {
          totalHours: totalHours.toFixed(2),
          totalRequests,
          totalCost: totalCost.toFixed(4),
        },
        performance: performanceStats,
        capacity: capacityAnalysis.metrics,
        warnings: capacityAnalysis.warnings,
        dailyUsage: usage.results || [],
        balances: balances.balances || [],
        project: project.project_id ? project : null,
        errors: {
          usage: usage.error,
          balances: balances.error,
          project: project.error,
        },
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

export default {
  getUsageSummary,
  getUsageRequests,
  getBalances,
  getProject,
  getProjects,
  getUsageFields,
  getDeepgramAnalytics,
};
