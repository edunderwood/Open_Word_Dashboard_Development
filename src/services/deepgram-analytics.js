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
 * Get comprehensive analytics for dashboard
 */
export async function getDeepgramAnalytics(days = 30) {
  const endDate = formatDate(new Date());
  const startDate = formatDate(new Date(Date.now() - days * 24 * 60 * 60 * 1000));

  try {
    const [usage, balances, project] = await Promise.all([
      getUsageSummary(startDate, endDate).catch(e => ({ error: e.message })),
      getBalances().catch(e => ({ error: e.message })),
      getProject().catch(e => ({ error: e.message })),
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

    return {
      success: true,
      data: {
        period: { start: startDate, end: endDate, days },
        summary: {
          totalHours: totalHours.toFixed(2),
          totalRequests,
          totalCost: totalCost.toFixed(4),
        },
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
