/**
 * Render.com Analytics Service
 * Fetches metrics from Render API including CPU, memory, bandwidth, and HTTP stats
 */

import dotenv from 'dotenv';

dotenv.config();

const RENDER_API_KEY = process.env.RENDER_API_KEY;
const BASE_URL = 'https://api.render.com/v1';

/**
 * Make authenticated request to Render API
 */
async function renderRequest(endpoint) {
  if (!RENDER_API_KEY) {
    throw new Error('RENDER_API_KEY not configured');
  }

  const response = await fetch(`${BASE_URL}${endpoint}`, {
    headers: {
      'Authorization': `Bearer ${RENDER_API_KEY}`,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Render API error: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Build metrics query params
 */
function buildMetricsParams(resourceIds, startTime, endTime, resolution = '1h') {
  const params = new URLSearchParams();
  resourceIds.forEach(id => params.append('resource', id));
  params.append('startTime', startTime);
  params.append('endTime', endTime);
  params.append('resolution', resolution);
  return params.toString();
}

/**
 * Get CPU usage metrics
 */
export async function getCpuMetrics(resourceIds, startTime, endTime, resolution = '1h') {
  const params = buildMetricsParams(resourceIds, startTime, endTime, resolution);
  return renderRequest(`/metrics/cpu?${params}`);
}

/**
 * Get CPU limit metrics
 */
export async function getCpuLimitMetrics(resourceIds, startTime, endTime, resolution = '1h') {
  const params = buildMetricsParams(resourceIds, startTime, endTime, resolution);
  return renderRequest(`/metrics/cpu-limit?${params}`);
}

/**
 * Get memory usage metrics
 */
export async function getMemoryMetrics(resourceIds, startTime, endTime, resolution = '1h') {
  const params = buildMetricsParams(resourceIds, startTime, endTime, resolution);
  return renderRequest(`/metrics/memory?${params}`);
}

/**
 * Get memory limit metrics
 */
export async function getMemoryLimitMetrics(resourceIds, startTime, endTime, resolution = '1h') {
  const params = buildMetricsParams(resourceIds, startTime, endTime, resolution);
  return renderRequest(`/metrics/memory-limit?${params}`);
}

/**
 * Get bandwidth usage metrics
 */
export async function getBandwidthMetrics(resourceIds, startTime, endTime, resolution = '1h') {
  const params = buildMetricsParams(resourceIds, startTime, endTime, resolution);
  return renderRequest(`/metrics/bandwidth?${params}`);
}

/**
 * Get HTTP request count metrics
 */
export async function getHttpRequestMetrics(resourceIds, startTime, endTime, resolution = '1h') {
  const params = buildMetricsParams(resourceIds, startTime, endTime, resolution);
  return renderRequest(`/metrics/http-requests?${params}`);
}

/**
 * Get HTTP latency metrics
 */
export async function getHttpLatencyMetrics(resourceIds, startTime, endTime, resolution = '1h') {
  const params = buildMetricsParams(resourceIds, startTime, endTime, resolution);
  return renderRequest(`/metrics/http-latency?${params}`);
}

/**
 * Get all services
 */
export async function getServices() {
  const data = await renderRequest('/services?limit=50');
  return data;
}

/**
 * Get service details
 * @param {string} serviceId - Render service ID
 */
export async function getService(serviceId) {
  const data = await renderRequest(`/services/${serviceId}`);
  return data;
}

/**
 * Get service metrics (CPU, Memory, etc.)
 * @param {string} serviceId - Render service ID
 * @param {string} startTime - ISO timestamp
 * @param {string} endTime - ISO timestamp
 * @param {string} resolution - '1m', '5m', '1h', '1d'
 */
export async function getServiceMetrics(serviceId, startTime, endTime, resolution = '1h') {
  const params = new URLSearchParams({
    startTime,
    endTime,
    resolution,
  });

  const data = await renderRequest(`/services/${serviceId}/metrics?${params}`);
  return data;
}

/**
 * Get service events/deploys
 * @param {string} serviceId - Render service ID
 */
export async function getServiceEvents(serviceId, limit = 20) {
  const data = await renderRequest(`/services/${serviceId}/events?limit=${limit}`);
  return data;
}

/**
 * Get service deploys
 * @param {string} serviceId - Render service ID
 */
export async function getServiceDeploys(serviceId, limit = 20) {
  const data = await renderRequest(`/services/${serviceId}/deploys?limit=${limit}`);
  return data;
}

/**
 * Get owner/account info
 */
export async function getOwners() {
  const data = await renderRequest('/owners?limit=10');
  return data;
}

/**
 * Process metrics data to get stats
 */
function processMetricsData(metricsData) {
  if (!metricsData || !Array.isArray(metricsData) || metricsData.length === 0) {
    return null;
  }

  // Flatten all values from all resources
  const allValues = metricsData.flatMap(m =>
    (m.values || []).map(v => v.value).filter(v => v !== null && v !== undefined)
  );

  if (allValues.length === 0) return null;

  const sum = allValues.reduce((a, b) => a + b, 0);
  const avg = sum / allValues.length;
  const max = Math.max(...allValues);
  const min = Math.min(...allValues);

  // Get most recent value
  const latest = metricsData[0]?.values?.[metricsData[0]?.values?.length - 1]?.value || 0;

  return { avg, max, min, latest, count: allValues.length };
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Calculate performance warnings based on metrics
 */
function calculateWarnings(metrics, memoryLimit) {
  const warnings = [];

  // Memory warnings
  if (metrics.memory && memoryLimit) {
    const memoryUsagePercent = (metrics.memory.latest / memoryLimit) * 100;
    if (memoryUsagePercent > 90) {
      warnings.push({
        level: 'critical',
        message: `Memory usage critical: ${memoryUsagePercent.toFixed(1)}% of limit. Consider upgrading instance.`,
      });
    } else if (memoryUsagePercent > 75) {
      warnings.push({
        level: 'warning',
        message: `Memory usage high: ${memoryUsagePercent.toFixed(1)}% of limit.`,
      });
    }
  }

  // CPU warnings (if CPU is consistently high)
  if (metrics.cpu && metrics.cpu.avg > 0.8) {
    warnings.push({
      level: 'warning',
      message: `High average CPU usage: ${(metrics.cpu.avg * 100).toFixed(1)}%. May impact performance.`,
    });
  }

  // Latency warnings
  if (metrics.latency && metrics.latency.avg > 1000) {
    warnings.push({
      level: 'warning',
      message: `High average latency: ${metrics.latency.avg.toFixed(0)}ms. Check application performance.`,
    });
  } else if (metrics.latency && metrics.latency.max > 5000) {
    warnings.push({
      level: 'info',
      message: `Peak latency spike detected: ${metrics.latency.max.toFixed(0)}ms.`,
    });
  }

  return warnings;
}

/**
 * Get comprehensive analytics for all OpenWord services
 */
export async function getRenderAnalytics() {
  try {
    // Get all services first
    const servicesResponse = await getServices();
    const services = servicesResponse || [];

    // Filter for OpenWord related services
    const openwordServices = services.filter(s =>
      s.service?.name?.toLowerCase().includes('openword') ||
      s.service?.name?.toLowerCase().includes('open-word') ||
      s.service?.name?.toLowerCase().includes('open_word')
    );

    // Get metrics time range (last 24 hours)
    const endTime = new Date().toISOString();
    const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Get service IDs for metrics queries
    const serviceIds = openwordServices.map(s => s.service?.id).filter(Boolean);

    // Fetch all metrics in parallel (these endpoints accept multiple resource IDs)
    let cpuData = null, cpuLimitData = null, memoryData = null, memoryLimitData = null;
    let bandwidthData = null, httpRequestsData = null, httpLatencyData = null;

    if (serviceIds.length > 0) {
      [cpuData, cpuLimitData, memoryData, memoryLimitData, bandwidthData, httpRequestsData, httpLatencyData] = await Promise.all([
        getCpuMetrics(serviceIds, startTime, endTime, '1h').catch(() => null),
        getCpuLimitMetrics(serviceIds, startTime, endTime, '1h').catch(() => null),
        getMemoryMetrics(serviceIds, startTime, endTime, '1h').catch(() => null),
        getMemoryLimitMetrics(serviceIds, startTime, endTime, '1h').catch(() => null),
        getBandwidthMetrics(serviceIds, startTime, endTime, '1h').catch(() => null),
        getHttpRequestMetrics(serviceIds, startTime, endTime, '1h').catch(() => null),
        getHttpLatencyMetrics(serviceIds, startTime, endTime, '1h').catch(() => null),
      ]);
    }

    // Process aggregate metrics
    const aggregateMetrics = {
      cpu: processMetricsData(cpuData),
      cpuLimit: processMetricsData(cpuLimitData),
      memory: processMetricsData(memoryData),
      memoryLimit: processMetricsData(memoryLimitData),
      bandwidth: processMetricsData(bandwidthData),
      httpRequests: processMetricsData(httpRequestsData),
      latency: processMetricsData(httpLatencyData),
    };

    // Calculate warnings
    const memoryLimitValue = aggregateMetrics.memoryLimit?.latest || null;
    const warnings = calculateWarnings(aggregateMetrics, memoryLimitValue);

    // Get detailed info for each service
    const serviceDetails = await Promise.all(
      openwordServices.map(async (s) => {
        const serviceId = s.service?.id;
        if (!serviceId) return null;

        try {
          const deploys = await getServiceDeploys(serviceId, 5).catch(() => []);

          // Calculate deploy stats
          const deployStats = {
            total: deploys.length,
            successful: deploys.filter(d => d.deploy?.status === 'live').length,
            failed: deploys.filter(d => d.deploy?.status === 'build_failed' || d.deploy?.status === 'update_failed').length,
          };

          return {
            id: serviceId,
            name: s.service?.name,
            type: s.service?.type,
            status: s.service?.suspended === 'not_suspended' ? 'running' : 'suspended',
            createdAt: s.service?.createdAt,
            updatedAt: s.service?.updatedAt,
            url: s.service?.serviceDetails?.url,
            region: s.service?.serviceDetails?.region,
            plan: s.service?.serviceDetails?.plan,
            recentDeploys: deploys,
            deployStats,
          };
        } catch (error) {
          return {
            id: serviceId,
            name: s.service?.name,
            error: error.message,
          };
        }
      })
    );

    // Format metrics for display
    const formattedMetrics = {
      cpu: aggregateMetrics.cpu ? {
        current: `${(aggregateMetrics.cpu.latest * 100).toFixed(1)}%`,
        avg: `${(aggregateMetrics.cpu.avg * 100).toFixed(1)}%`,
        max: `${(aggregateMetrics.cpu.max * 100).toFixed(1)}%`,
      } : null,
      memory: aggregateMetrics.memory ? {
        current: formatBytes(aggregateMetrics.memory.latest),
        avg: formatBytes(aggregateMetrics.memory.avg),
        max: formatBytes(aggregateMetrics.memory.max),
        limit: aggregateMetrics.memoryLimit ? formatBytes(aggregateMetrics.memoryLimit.latest) : null,
        usagePercent: aggregateMetrics.memoryLimit ?
          `${((aggregateMetrics.memory.latest / aggregateMetrics.memoryLimit.latest) * 100).toFixed(1)}%` : null,
      } : null,
      bandwidth: aggregateMetrics.bandwidth ? {
        total: formatBytes(aggregateMetrics.bandwidth.avg * aggregateMetrics.bandwidth.count),
        avgPerHour: formatBytes(aggregateMetrics.bandwidth.avg),
        peak: formatBytes(aggregateMetrics.bandwidth.max),
      } : null,
      http: aggregateMetrics.httpRequests ? {
        totalRequests: Math.round(aggregateMetrics.httpRequests.avg * aggregateMetrics.httpRequests.count),
        avgPerHour: Math.round(aggregateMetrics.httpRequests.avg),
        peakPerHour: Math.round(aggregateMetrics.httpRequests.max),
      } : null,
      latency: aggregateMetrics.latency ? {
        avg: `${aggregateMetrics.latency.avg.toFixed(0)}ms`,
        p50: `${aggregateMetrics.latency.avg.toFixed(0)}ms`, // Approximation
        max: `${aggregateMetrics.latency.max.toFixed(0)}ms`,
      } : null,
    };

    return {
      success: true,
      data: {
        totalServices: services.length,
        openwordServices: serviceDetails.filter(Boolean),
        metrics: formattedMetrics,
        warnings,
        period: '24 hours',
        allServices: services.map(s => ({
          id: s.service?.id,
          name: s.service?.name,
          type: s.service?.type,
          status: s.service?.suspended === 'not_suspended' ? 'running' : 'suspended',
        })),
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
  getServices,
  getService,
  getServiceMetrics,
  getServiceEvents,
  getServiceDeploys,
  getOwners,
  getRenderAnalytics,
};
