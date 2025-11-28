/**
 * Render.com Analytics Service
 * Fetches metrics from Render API
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

    // Get metrics for each service (last 24 hours)
    const endTime = new Date().toISOString();
    const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const serviceDetails = await Promise.all(
      openwordServices.map(async (s) => {
        const serviceId = s.service?.id;
        if (!serviceId) return null;

        try {
          const [metrics, deploys] = await Promise.all([
            getServiceMetrics(serviceId, startTime, endTime, '1h').catch(() => null),
            getServiceDeploys(serviceId, 5).catch(() => []),
          ]);

          return {
            id: serviceId,
            name: s.service?.name,
            type: s.service?.type,
            status: s.service?.suspended === 'not_suspended' ? 'running' : 'suspended',
            createdAt: s.service?.createdAt,
            updatedAt: s.service?.updatedAt,
            url: s.service?.serviceDetails?.url,
            metrics: metrics,
            recentDeploys: deploys,
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

    return {
      success: true,
      data: {
        totalServices: services.length,
        openwordServices: serviceDetails.filter(Boolean),
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
