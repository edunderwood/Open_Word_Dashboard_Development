/**
 * Google Cloud Analytics Service
 * Fetches Translation API metrics from Google Cloud Monitoring
 */

import { google } from 'googleapis';
import { readFileSync, existsSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config();

// Render secret file paths
const RENDER_CREDENTIALS_FILE = '/etc/secrets/GOOGLE_APPLICATION_CREDENTIALS_JSON';
const RENDER_PROJECT_ID_FILE = '/etc/secrets/GOOGLE_CLOUD_PROJECT_ID';

/**
 * Get Google Cloud Project ID from secret file or environment variable
 */
function getProjectId() {
  // First check Render secret file
  if (existsSync(RENDER_PROJECT_ID_FILE)) {
    try {
      return readFileSync(RENDER_PROJECT_ID_FILE, 'utf8').trim();
    } catch (err) {
      console.error('Error reading project ID from secret file:', err.message);
    }
  }
  // Fall back to environment variable
  return process.env.GOOGLE_CLOUD_PROJECT_ID;
}

const GOOGLE_PROJECT_ID = getProjectId();

/**
 * Get authenticated Google client
 * Supports credentials from:
 * 1. Render secret file (/etc/secrets/GOOGLE_APPLICATION_CREDENTIALS_JSON)
 * 2. Environment variable (JSON string)
 * 3. Default credentials (ADC)
 */
async function getAuthClient() {
  const scopes = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/monitoring.read',
  ];

  // Option 1: Check for Render secret file
  if (existsSync(RENDER_CREDENTIALS_FILE)) {
    try {
      const fileContents = readFileSync(RENDER_CREDENTIALS_FILE, 'utf8');
      const credentials = JSON.parse(fileContents);
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes,
      });
      console.log('Using Google credentials from Render secret file');
      return auth.getClient();
    } catch (parseError) {
      console.error('Failed to parse credentials from secret file:', parseError.message);
    }
  }

  // Option 2: Check for credentials in environment variable (JSON string)
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

  if (credentialsJson) {
    try {
      const credentials = JSON.parse(credentialsJson);
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes,
      });
      console.log('Using Google credentials from environment variable');
      return auth.getClient();
    } catch (parseError) {
      throw new Error(`Failed to parse GOOGLE_APPLICATION_CREDENTIALS_JSON: ${parseError.message}`);
    }
  }

  // Option 3: Fall back to default credentials (file-based or ADC)
  console.log('Using default Google credentials (ADC)');
  const auth = new google.auth.GoogleAuth({
    scopes,
  });

  return auth.getClient();
}

/**
 * Get Translation API metrics from Cloud Monitoring
 * @param {number} days - Number of days to look back
 */
export async function getTranslationMetrics(days = 7) {
  if (!GOOGLE_PROJECT_ID) {
    throw new Error('GOOGLE_CLOUD_PROJECT_ID not configured');
  }

  try {
    const authClient = await getAuthClient();
    const monitoring = google.monitoring({ version: 'v3', auth: authClient });

    const endTime = new Date();
    const startTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Query for Translation API request count
    const requestCountResponse = await monitoring.projects.timeSeries.list({
      name: `projects/${GOOGLE_PROJECT_ID}`,
      filter: 'metric.type="serviceruntime.googleapis.com/api/request_count" AND resource.labels.service="translate.googleapis.com"',
      'interval.startTime': startTime.toISOString(),
      'interval.endTime': endTime.toISOString(),
      aggregation: {
        alignmentPeriod: '86400s', // 1 day
        perSeriesAligner: 'ALIGN_SUM',
      },
    });

    // Query for Translation API character count
    const charCountResponse = await monitoring.projects.timeSeries.list({
      name: `projects/${GOOGLE_PROJECT_ID}`,
      filter: 'metric.type="translate.googleapis.com/character_count"',
      'interval.startTime': startTime.toISOString(),
      'interval.endTime': endTime.toISOString(),
      aggregation: {
        alignmentPeriod: '86400s',
        perSeriesAligner: 'ALIGN_SUM',
      },
    });

    // Query for error count
    const errorCountResponse = await monitoring.projects.timeSeries.list({
      name: `projects/${GOOGLE_PROJECT_ID}`,
      filter: 'metric.type="serviceruntime.googleapis.com/api/request_count" AND resource.labels.service="translate.googleapis.com" AND metric.labels.response_code_class!="2xx"',
      'interval.startTime': startTime.toISOString(),
      'interval.endTime': endTime.toISOString(),
      aggregation: {
        alignmentPeriod: '86400s',
        perSeriesAligner: 'ALIGN_SUM',
      },
    });

    return {
      requestCount: requestCountResponse.data.timeSeries || [],
      characterCount: charCountResponse.data.timeSeries || [],
      errorCount: errorCountResponse.data.timeSeries || [],
    };
  } catch (error) {
    throw new Error(`Google Cloud Monitoring error: ${error.message}`);
  }
}

/**
 * Get billing information for Translation API
 */
export async function getBillingInfo() {
  if (!GOOGLE_PROJECT_ID) {
    throw new Error('GOOGLE_CLOUD_PROJECT_ID not configured');
  }

  try {
    const authClient = await getAuthClient();
    const cloudbilling = google.cloudbilling({ version: 'v1', auth: authClient });

    const billingInfo = await cloudbilling.projects.getBillingInfo({
      name: `projects/${GOOGLE_PROJECT_ID}`,
    });

    return billingInfo.data;
  } catch (error) {
    throw new Error(`Google Cloud Billing error: ${error.message}`);
  }
}

/**
 * Get API quotas and limits
 */
export async function getQuotas() {
  if (!GOOGLE_PROJECT_ID) {
    throw new Error('GOOGLE_CLOUD_PROJECT_ID not configured');
  }

  try {
    const authClient = await getAuthClient();
    const serviceusage = google.serviceusage({ version: 'v1', auth: authClient });

    const quotas = await serviceusage.services.get({
      name: `projects/${GOOGLE_PROJECT_ID}/services/translate.googleapis.com`,
    });

    return quotas.data;
  } catch (error) {
    throw new Error(`Google Cloud Service Usage error: ${error.message}`);
  }
}

/**
 * Get comprehensive Google Cloud analytics for dashboard
 */
export async function getGoogleAnalytics(days = 7) {
  try {
    const [metrics, billing] = await Promise.all([
      getTranslationMetrics(days).catch(e => ({ error: e.message })),
      getBillingInfo().catch(e => ({ error: e.message })),
    ]);

    // Process metrics to get totals
    let totalRequests = 0;
    let totalCharacters = 0;
    let totalErrors = 0;
    const dailyData = [];

    if (metrics.requestCount && !metrics.error) {
      metrics.requestCount.forEach(series => {
        series.points?.forEach(point => {
          totalRequests += parseInt(point.value?.int64Value || 0);
        });
      });
    }

    if (metrics.characterCount && !metrics.error) {
      metrics.characterCount.forEach(series => {
        series.points?.forEach(point => {
          totalCharacters += parseInt(point.value?.int64Value || 0);
        });
      });
    }

    if (metrics.errorCount && !metrics.error) {
      metrics.errorCount.forEach(series => {
        series.points?.forEach(point => {
          totalErrors += parseInt(point.value?.int64Value || 0);
        });
      });
    }

    // Estimate cost (Translation API v3 is $20 per million characters)
    const estimatedCost = (totalCharacters / 1000000) * 20;

    return {
      success: true,
      data: {
        period: { days },
        summary: {
          totalRequests,
          totalCharacters,
          totalErrors,
          errorRate: totalRequests > 0 ? ((totalErrors / totalRequests) * 100).toFixed(2) : 0,
          estimatedCostUSD: estimatedCost.toFixed(2),
        },
        billing: billing.error ? null : billing,
        rawMetrics: metrics.error ? null : metrics,
        errors: {
          metrics: metrics.error,
          billing: billing.error,
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
  getTranslationMetrics,
  getBillingInfo,
  getQuotas,
  getGoogleAnalytics,
};
