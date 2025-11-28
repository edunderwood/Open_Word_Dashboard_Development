/**
 * Vercel Analytics Service
 * Fetches deployment and project metrics from Vercel API
 */

import dotenv from 'dotenv';

dotenv.config();

const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const BASE_URL = 'https://api.vercel.com';

/**
 * Make authenticated request to Vercel API
 */
async function vercelRequest(endpoint) {
  if (!VERCEL_TOKEN) {
    throw new Error('VERCEL_TOKEN not configured');
  }

  const url = new URL(`${BASE_URL}${endpoint}`);
  if (VERCEL_TEAM_ID) {
    url.searchParams.append('teamId', VERCEL_TEAM_ID);
  }

  const response = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${VERCEL_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Vercel API error: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Get all projects
 */
export async function getProjects() {
  const data = await vercelRequest('/v9/projects');
  return data.projects || [];
}

/**
 * Get project by ID or name
 * @param {string} projectId - Vercel project ID or name
 */
export async function getProject(projectId) {
  const data = await vercelRequest(`/v9/projects/${projectId}`);
  return data;
}

/**
 * Get deployments for a project
 * @param {string} projectId - Vercel project ID
 * @param {number} limit - Max results
 */
export async function getDeployments(projectId, limit = 20) {
  const data = await vercelRequest(`/v6/deployments?projectId=${projectId}&limit=${limit}`);
  return data.deployments || [];
}

/**
 * Get deployment by ID
 * @param {string} deploymentId - Deployment ID or URL
 */
export async function getDeployment(deploymentId) {
  const data = await vercelRequest(`/v13/deployments/${deploymentId}`);
  return data;
}

/**
 * Get deployment events/logs
 * @param {string} deploymentId - Deployment ID
 */
export async function getDeploymentEvents(deploymentId) {
  const data = await vercelRequest(`/v2/deployments/${deploymentId}/events`);
  return data;
}

/**
 * Get domains for a project
 * @param {string} projectId - Vercel project ID
 */
export async function getProjectDomains(projectId) {
  const data = await vercelRequest(`/v9/projects/${projectId}/domains`);
  return data.domains || [];
}

/**
 * Get usage/billing info (requires team/pro plan)
 */
export async function getUsage() {
  try {
    // This endpoint might not be available on all plans
    const data = await vercelRequest('/v1/usage');
    return data;
  } catch (error) {
    // Fall back to null if usage endpoint not available
    return { error: error.message };
  }
}

/**
 * Get environment variables for a project
 * @param {string} projectId - Vercel project ID
 */
export async function getEnvVariables(projectId) {
  const data = await vercelRequest(`/v9/projects/${projectId}/env`);
  return data.envs || [];
}

/**
 * Get comprehensive analytics for OpenWord Client on Vercel
 */
export async function getVercelAnalytics() {
  try {
    // Get all projects
    const projects = await getProjects();

    // Filter for OpenWord related projects
    const openwordProjects = projects.filter(p =>
      p.name?.toLowerCase().includes('openword') ||
      p.name?.toLowerCase().includes('open-word') ||
      p.name?.toLowerCase().includes('open_word')
    );

    // Get details for each project
    const projectDetails = await Promise.all(
      openwordProjects.map(async (project) => {
        try {
          const [deployments, domains] = await Promise.all([
            getDeployments(project.id, 10).catch(() => []),
            getProjectDomains(project.id).catch(() => []),
          ]);

          // Calculate deployment stats
          const recentDeployments = deployments.slice(0, 10);
          const successfulDeploys = recentDeployments.filter(d => d.state === 'READY').length;
          const failedDeploys = recentDeployments.filter(d => d.state === 'ERROR').length;

          // Get average build time from recent deployments
          let avgBuildTime = 0;
          const buildsWithTime = recentDeployments.filter(d => d.buildingAt && d.ready);
          if (buildsWithTime.length > 0) {
            const totalTime = buildsWithTime.reduce((sum, d) => {
              return sum + (new Date(d.ready).getTime() - new Date(d.buildingAt).getTime());
            }, 0);
            avgBuildTime = Math.round(totalTime / buildsWithTime.length / 1000); // in seconds
          }

          return {
            id: project.id,
            name: project.name,
            framework: project.framework,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
            latestDeployment: project.latestDeployments?.[0] || null,
            domains: domains.map(d => ({
              name: d.name,
              verified: d.verified,
            })),
            deploymentStats: {
              total: recentDeployments.length,
              successful: successfulDeploys,
              failed: failedDeploys,
              successRate: recentDeployments.length > 0
                ? ((successfulDeploys / recentDeployments.length) * 100).toFixed(1)
                : 0,
              avgBuildTimeSeconds: avgBuildTime,
            },
            recentDeployments: recentDeployments.map(d => ({
              id: d.uid,
              state: d.state,
              createdAt: d.createdAt,
              ready: d.ready,
              url: d.url,
              source: d.source,
              meta: d.meta?.githubCommitMessage || d.meta?.gitlabCommitMessage || null,
            })),
          };
        } catch (error) {
          return {
            id: project.id,
            name: project.name,
            error: error.message,
          };
        }
      })
    );

    // Try to get usage info
    const usage = await getUsage();

    return {
      success: true,
      data: {
        totalProjects: projects.length,
        openwordProjects: projectDetails,
        allProjects: projects.map(p => ({
          id: p.id,
          name: p.name,
          framework: p.framework,
          updatedAt: p.updatedAt,
        })),
        usage: usage.error ? null : usage,
        errors: {
          usage: usage.error,
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
  getProjects,
  getProject,
  getDeployments,
  getDeployment,
  getDeploymentEvents,
  getProjectDomains,
  getUsage,
  getEnvVariables,
  getVercelAnalytics,
};
