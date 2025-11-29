/**
 * Costs Analytics Service
 * Aggregates costs from all service providers and compares with revenue
 * All costs displayed in GBP (Sterling)
 */

import { getDeepgramAnalytics } from './deepgram-analytics.js';
import { getGoogleAnalytics } from './google-analytics.js';
import stripe from './stripe.js';
import supabase from './supabase.js';

// USD to GBP exchange rate (approximate - could be fetched from API for accuracy)
const USD_TO_GBP = 0.79;

/**
 * Get current month date range
 */
function getCurrentMonthRange() {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  return { startOfMonth, endOfMonth, now };
}

/**
 * Get Deepgram costs for current month
 */
async function getDeepgramCosts() {
  try {
    const { now, startOfMonth } = getCurrentMonthRange();
    const daysInMonth = Math.ceil((now - startOfMonth) / (1000 * 60 * 60 * 24)) || 1;

    const analytics = await getDeepgramAnalytics(daysInMonth);

    if (!analytics.success) {
      return { error: analytics.error, cost: 0, costUSD: 0 };
    }

    const costUSD = parseFloat(analytics.data?.summary?.totalCost) || 0;
    const hours = parseFloat(analytics.data?.summary?.totalHours) || 0;
    const balance = analytics.data?.balances?.[0]?.amount || 0;

    return {
      cost: costUSD * USD_TO_GBP,
      costUSD,
      hours,
      balance,
      tier: 'Pay-as-you-go',
      details: {
        costPerHour: hours > 0 ? (costUSD / hours).toFixed(4) : '0',
        requests: analytics.data?.summary?.totalRequests || 0
      }
    };
  } catch (error) {
    return { error: error.message, cost: 0, costUSD: 0 };
  }
}

/**
 * Get Google Translate costs for current month
 */
async function getGoogleTranslateCosts() {
  try {
    const { now, startOfMonth } = getCurrentMonthRange();
    const daysInMonth = Math.ceil((now - startOfMonth) / (1000 * 60 * 60 * 24)) || 1;

    const analytics = await getGoogleAnalytics(daysInMonth);

    if (!analytics.success) {
      return { error: analytics.error, cost: 0, costUSD: 0 };
    }

    const costUSD = parseFloat(analytics.data?.summary?.estimatedCostUSD) || 0;
    const requests = analytics.data?.summary?.totalRequests || 0;
    const bytes = analytics.data?.summary?.totalBytes || 0;

    return {
      cost: costUSD * USD_TO_GBP,
      costUSD,
      requests,
      bytes,
      tier: 'Pay-as-you-go',
      details: {
        avgLatencyMs: analytics.data?.summary?.avgLatencyMs || '0',
        errorRate: analytics.data?.summary?.errorRate || '0'
      }
    };
  } catch (error) {
    return { error: error.message, cost: 0, costUSD: 0 };
  }
}

/**
 * Get Supabase costs by querying the Management API
 * Returns organization subscription plan information
 */
async function getSupabaseCosts() {
  try {
    const SUPABASE_ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
    const SUPABASE_ORG_ID = process.env.SUPABASE_ORG_ID;

    // Supabase plan pricing (USD per month)
    const SUPABASE_PLAN_COSTS = {
      'free': 0,
      'pro': 25,
      'team': 599,
      'enterprise': 0 // Custom pricing
    };

    // Get database usage stats
    const { count: totalOrgs } = await supabase
      .from('organisations')
      .select('*', { count: 'exact', head: true });

    const { count: totalUsageRecords } = await supabase
      .from('translation_usage')
      .select('*', { count: 'exact', head: true });

    if (!SUPABASE_ACCESS_TOKEN || !SUPABASE_ORG_ID) {
      // Estimate based on usage if no API credentials
      const estimatedOnProTier = (totalOrgs || 0) > 50 || (totalUsageRecords || 0) > 100000;
      const costUSD = estimatedOnProTier ? 25 : 0;

      return {
        cost: costUSD * USD_TO_GBP,
        costUSD: costUSD,
        tier: estimatedOnProTier ? 'Pro (estimated)' : 'Free (estimated)',
        details: {
          note: 'Add SUPABASE_ACCESS_TOKEN and SUPABASE_ORG_ID to .env for actual plan info',
          totalOrganisations: totalOrgs || 0,
          totalUsageRecords: totalUsageRecords || 0
        }
      };
    }

    // Query Supabase Management API for organization subscription
    const response = await fetch(`https://api.supabase.com/v1/organizations/${SUPABASE_ORG_ID}/billing/subscription`, {
      headers: {
        'Authorization': `Bearer ${SUPABASE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      // Try alternative endpoint
      const orgResponse = await fetch(`https://api.supabase.com/v1/organizations/${SUPABASE_ORG_ID}`, {
        headers: {
          'Authorization': `Bearer ${SUPABASE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });

      if (orgResponse.ok) {
        const orgData = await orgResponse.json();
        const plan = orgData.subscription_tier || orgData.plan || 'free';
        const planCostUSD = SUPABASE_PLAN_COSTS[plan.toLowerCase()] || 0;

        return {
          cost: planCostUSD * USD_TO_GBP,
          costUSD: planCostUSD,
          tier: plan.charAt(0).toUpperCase() + plan.slice(1),
          details: {
            orgId: SUPABASE_ORG_ID,
            orgName: orgData.name || 'Unknown',
            totalOrganisations: totalOrgs || 0,
            totalUsageRecords: totalUsageRecords || 0
          }
        };
      }

      throw new Error(`Supabase API error: ${response.status}`);
    }

    const data = await response.json();
    const plan = data.tier || data.plan || 'free';
    const planCostUSD = SUPABASE_PLAN_COSTS[plan.toLowerCase()] || 0;

    return {
      cost: planCostUSD * USD_TO_GBP,
      costUSD: planCostUSD,
      tier: plan.charAt(0).toUpperCase() + plan.slice(1),
      details: {
        orgId: SUPABASE_ORG_ID,
        plan: plan,
        totalOrganisations: totalOrgs || 0,
        totalUsageRecords: totalUsageRecords || 0
      }
    };
  } catch (error) {
    // Fall back to estimate
    const { count: totalOrgs } = await supabase
      .from('organisations')
      .select('*', { count: 'exact', head: true }).catch(() => ({ count: 0 }));

    const estimatedOnProTier = (totalOrgs || 0) > 50;
    const costUSD = estimatedOnProTier ? 25 : 0;

    return {
      error: error.message,
      cost: costUSD * USD_TO_GBP,
      costUSD: costUSD,
      tier: estimatedOnProTier ? 'Pro (estimated)' : 'Free (estimated)'
    };
  }
}

/**
 * Get Render costs by querying the Render API
 * Returns actual service plans and estimated costs
 */
async function getRenderCosts() {
  try {
    const RENDER_API_KEY = process.env.RENDER_API_KEY;

    // Render plan pricing (USD per month)
    const RENDER_PLAN_COSTS = {
      'free': 0,
      'starter': 7,
      'starter_plus': 14,
      'standard': 25,
      'standard_plus': 50,
      'pro': 85,
      'pro_plus': 175,
      'pro_max': 225,
      'pro_ultra': 450
    };

    if (!RENDER_API_KEY) {
      // Fall back to estimates if no API key
      return {
        cost: 32 * USD_TO_GBP, // Estimated: Standard + Starter
        costUSD: 32,
        tier: 'Estimated (no API key)',
        details: {
          note: 'Add RENDER_API_KEY to .env for actual plan info',
          services: [
            { name: 'OpenWord Control Panel', plan: 'Standard (estimated)', costUSD: 25 },
            { name: 'OpenWord Dashboard', plan: 'Starter (estimated)', costUSD: 7 }
          ]
        }
      };
    }

    // Query Render API for services
    const response = await fetch('https://api.render.com/v1/services?limit=50', {
      headers: {
        'Authorization': `Bearer ${RENDER_API_KEY}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Render API error: ${response.status}`);
    }

    const data = await response.json();
    const services = data || [];

    let totalCostUSD = 0;
    const serviceDetails = [];

    for (const item of services) {
      const service = item.service || item;
      const planType = service.serviceDetails?.plan || service.plan || 'free';
      const planCost = RENDER_PLAN_COSTS[planType.toLowerCase()] || 0;

      totalCostUSD += planCost;
      serviceDetails.push({
        name: service.name || 'Unknown Service',
        type: service.type || 'unknown',
        plan: planType,
        costUSD: planCost,
        status: service.suspended === 'suspended' ? 'suspended' : 'active'
      });
    }

    return {
      cost: totalCostUSD * USD_TO_GBP,
      costUSD: totalCostUSD,
      tier: `${services.length} service(s)`,
      details: {
        services: serviceDetails
      }
    };
  } catch (error) {
    return {
      error: error.message,
      cost: 32 * USD_TO_GBP, // Fallback estimate
      costUSD: 32,
      tier: 'Estimated (API error)'
    };
  }
}

/**
 * Get Vercel costs by querying the Vercel API
 * Returns team/user plan information
 */
async function getVercelCosts() {
  try {
    const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
    const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;

    // Vercel plan pricing (USD per month per seat)
    const VERCEL_PLAN_COSTS = {
      'hobby': 0,
      'pro': 20,
      'enterprise': 0 // Custom pricing
    };

    if (!VERCEL_TOKEN) {
      return {
        cost: 0,
        costUSD: 0,
        tier: 'Hobby (Free) - estimated',
        details: {
          note: 'Add VERCEL_TOKEN to .env for actual plan info'
        }
      };
    }

    // Query Vercel API for user/team info
    let endpoint = 'https://api.vercel.com/v2/user';
    if (VERCEL_TEAM_ID) {
      endpoint = `https://api.vercel.com/v2/teams/${VERCEL_TEAM_ID}`;
    }

    const response = await fetch(endpoint, {
      headers: {
        'Authorization': `Bearer ${VERCEL_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Vercel API error: ${response.status}`);
    }

    const data = await response.json();
    const billing = data.billing || data.user?.billing || {};
    const plan = billing.plan || data.plan || 'hobby';
    const planCostUSD = VERCEL_PLAN_COSTS[plan.toLowerCase()] || 0;

    return {
      cost: planCostUSD * USD_TO_GBP,
      costUSD: planCostUSD,
      tier: plan.charAt(0).toUpperCase() + plan.slice(1),
      details: {
        teamId: VERCEL_TEAM_ID || 'Personal account',
        plan: plan
      }
    };
  } catch (error) {
    return {
      error: error.message,
      cost: 0,
      costUSD: 0,
      tier: 'Hobby (Free) - estimated'
    };
  }
}

/**
 * Get revenue from Stripe for current month
 */
async function getMonthlyRevenue() {
  try {
    const { now, startOfMonth } = getCurrentMonthRange();
    const startTimestamp = Math.floor(startOfMonth.getTime() / 1000);

    // Get charges this month
    const charges = await stripe.charges.list({
      created: { gte: startTimestamp },
      limit: 100,
    });

    let totalRevenue = 0;
    let successfulCharges = 0;
    charges.data.forEach(charge => {
      if (charge.status === 'succeeded') {
        totalRevenue += charge.amount;
        successfulCharges++;
      }
    });

    // Get MRR from active subscriptions
    const subscriptions = await stripe.subscriptions.list({
      status: 'active',
      limit: 100,
    });

    let mrr = 0;
    subscriptions.data.forEach(sub => {
      sub.items.data.forEach(item => {
        if (item.price?.recurring) {
          const amount = item.price.unit_amount || 0;
          const interval = item.price.recurring.interval;
          if (interval === 'month') {
            mrr += amount;
          } else if (interval === 'year') {
            mrr += amount / 12;
          }
        }
      });
    });

    // Get usage-based revenue estimate from Supabase
    const { data: usageData } = await supabase
      .from('translation_usage')
      .select('estimated_cost')
      .gte('created_at', startOfMonth.toISOString());

    let usageRevenue = 0;
    usageData?.forEach(u => {
      usageRevenue += parseFloat(u.estimated_cost) || 0;
    });

    return {
      totalRevenue: totalRevenue / 100, // Convert pence to pounds
      mrr: mrr / 100,
      usageRevenue,
      successfulCharges,
      activeSubscriptions: subscriptions.data.length,
      details: {
        subscriptionRevenue: mrr / 100,
        usageBasedRevenue: usageRevenue
      }
    };
  } catch (error) {
    return { error: error.message, totalRevenue: 0, mrr: 0 };
  }
}

/**
 * Get comprehensive costs and revenue analysis
 * All costs converted to GBP (Sterling)
 */
export async function getCostsAnalytics() {
  try {
    // Fetch all costs in parallel
    const [deepgram, googleTranslate, supabaseCosts, render, vercel, revenue] = await Promise.all([
      getDeepgramCosts(),
      getGoogleTranslateCosts(),
      getSupabaseCosts(),
      getRenderCosts(),
      getVercelCosts(),
      getMonthlyRevenue()
    ]);

    // Calculate totals (all costs are already in GBP)
    const totalCostsGBP =
      (deepgram.cost || 0) +
      (googleTranslate.cost || 0) +
      (supabaseCosts.cost || 0) +
      (render.cost || 0) +
      (vercel.cost || 0);

    const totalCostsUSD =
      (deepgram.costUSD || 0) +
      (googleTranslate.costUSD || 0) +
      (supabaseCosts.costUSD || 0) +
      (render.costUSD || 0) +
      (vercel.costUSD || 0);

    const totalRevenue = (revenue.totalRevenue || 0) + (revenue.usageRevenue || 0);
    const profit = totalRevenue - totalCostsGBP;
    const profitMargin = totalRevenue > 0 ? ((profit / totalRevenue) * 100).toFixed(1) : 0;

    return {
      success: true,
      data: {
        costs: {
          deepgram: {
            name: 'Deepgram (Speech-to-Text)',
            cost: deepgram.cost || 0,
            costUSD: deepgram.costUSD || 0,
            currency: 'GBP',
            ...deepgram
          },
          googleTranslate: {
            name: 'Google Cloud Translation',
            cost: googleTranslate.cost || 0,
            costUSD: googleTranslate.costUSD || 0,
            currency: 'GBP',
            ...googleTranslate
          },
          supabase: {
            name: 'Supabase (Database)',
            cost: supabaseCosts.cost || 0,
            costUSD: supabaseCosts.costUSD || 0,
            currency: 'GBP',
            ...supabaseCosts
          },
          render: {
            name: 'Render (Server Hosting)',
            cost: render.cost || 0,
            costUSD: render.costUSD || 0,
            currency: 'GBP',
            ...render
          },
          vercel: {
            name: 'Vercel (Client Hosting)',
            cost: vercel.cost || 0,
            costUSD: vercel.costUSD || 0,
            currency: 'GBP',
            ...vercel
          },
          total: totalCostsGBP,
          totalUSD: totalCostsUSD
        },
        revenue: {
          stripeRevenue: revenue.totalRevenue || 0,
          usageRevenue: revenue.usageRevenue || 0,
          mrr: revenue.mrr || 0,
          total: totalRevenue,
          activeSubscriptions: revenue.activeSubscriptions || 0,
          currency: 'GBP'
        },
        summary: {
          totalCosts: totalCostsGBP,
          totalCostsUSD: totalCostsUSD,
          totalRevenue,
          profit,
          profitMargin,
          isProfit: profit >= 0,
          currency: 'GBP',
          exchangeRate: USD_TO_GBP
        },
        errors: {
          deepgram: deepgram.error,
          googleTranslate: googleTranslate.error,
          supabase: supabaseCosts.error,
          render: render.error,
          vercel: vercel.error,
          revenue: revenue.error
        },
        timestamp: new Date().toISOString()
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

export default {
  getCostsAnalytics
};
