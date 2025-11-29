/**
 * Costs Analytics Service
 * Aggregates costs from all service providers and compares with revenue
 */

import { getDeepgramAnalytics } from './deepgram-analytics.js';
import { getGoogleAnalytics } from './google-analytics.js';
import stripe from './stripe.js';
import supabase from './supabase.js';

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
      return { error: analytics.error, cost: 0 };
    }

    const cost = parseFloat(analytics.data?.summary?.totalCost) || 0;
    const hours = parseFloat(analytics.data?.summary?.totalHours) || 0;
    const balance = analytics.data?.balances?.[0]?.amount || 0;

    return {
      cost,
      hours,
      balance,
      details: {
        costPerHour: hours > 0 ? (cost / hours).toFixed(4) : '0',
        requests: analytics.data?.summary?.totalRequests || 0
      }
    };
  } catch (error) {
    return { error: error.message, cost: 0 };
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
      return { error: analytics.error, cost: 0 };
    }

    const cost = parseFloat(analytics.data?.summary?.estimatedCostUSD) || 0;
    const requests = analytics.data?.summary?.totalRequests || 0;
    const bytes = analytics.data?.summary?.totalBytes || 0;

    return {
      cost,
      requests,
      bytes,
      details: {
        avgLatencyMs: analytics.data?.summary?.avgLatencyMs || '0',
        errorRate: analytics.data?.summary?.errorRate || '0'
      }
    };
  } catch (error) {
    return { error: error.message, cost: 0 };
  }
}

/**
 * Get Supabase costs (estimated based on plan)
 * Note: Supabase doesn't have a billing API, so this is based on plan limits
 */
async function getSupabaseCosts() {
  try {
    // Supabase free tier limits
    const SUPABASE_FREE_TIER_COST = 0; // Free tier
    const SUPABASE_PRO_COST = 25; // $25/month for Pro

    // Check database size and usage
    const { count: totalOrgs } = await supabase
      .from('organisations')
      .select('*', { count: 'exact', head: true });

    const { count: totalUsageRecords } = await supabase
      .from('translation_usage')
      .select('*', { count: 'exact', head: true });

    // Estimate if we're on free or pro tier based on usage
    // Free tier: 500MB database, 2GB bandwidth, 50K monthly active users
    const estimatedOnProTier = (totalOrgs || 0) > 50 || (totalUsageRecords || 0) > 100000;

    const cost = estimatedOnProTier ? SUPABASE_PRO_COST : SUPABASE_FREE_TIER_COST;

    return {
      cost,
      tier: estimatedOnProTier ? 'Pro' : 'Free',
      details: {
        totalOrganisations: totalOrgs || 0,
        totalUsageRecords: totalUsageRecords || 0
      }
    };
  } catch (error) {
    return { error: error.message, cost: 0 };
  }
}

/**
 * Get Render costs (estimated based on services)
 * Note: Render doesn't have a public billing API
 */
async function getRenderCosts() {
  try {
    // Render pricing estimates
    const RENDER_FREE_TIER = 0;
    const RENDER_STARTER = 7; // $7/month for starter
    const RENDER_STANDARD = 25; // $25/month for standard

    // OpenWord uses:
    // - 1 Web Service (Control Panel) - Standard ($25/month assumed)
    // - 1 Web Service (Dashboard) - Starter ($7/month assumed)
    const estimatedCost = RENDER_STANDARD + RENDER_STARTER;

    return {
      cost: estimatedCost,
      details: {
        services: [
          { name: 'OpenWord Control Panel', plan: 'Standard', cost: RENDER_STANDARD },
          { name: 'OpenWord Dashboard', plan: 'Starter', cost: RENDER_STARTER }
        ]
      }
    };
  } catch (error) {
    return { error: error.message, cost: 0 };
  }
}

/**
 * Get Vercel costs (estimated based on usage)
 * Note: Vercel free tier is generous for most use cases
 */
async function getVercelCosts() {
  try {
    // Vercel Hobby tier is free, Pro is $20/month
    const VERCEL_FREE_TIER = 0;
    const VERCEL_PRO = 20;

    // Assume free tier for now (can be upgraded)
    return {
      cost: VERCEL_FREE_TIER,
      tier: 'Hobby (Free)',
      details: {
        note: 'Using Vercel Hobby tier for client hosting'
      }
    };
  } catch (error) {
    return { error: error.message, cost: 0 };
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

    // Calculate totals
    const totalCosts =
      (deepgram.cost || 0) +
      (googleTranslate.cost || 0) +
      (supabaseCosts.cost || 0) +
      (render.cost || 0) +
      (vercel.cost || 0);

    const totalRevenue = (revenue.totalRevenue || 0) + (revenue.usageRevenue || 0);
    const profit = totalRevenue - totalCosts;
    const profitMargin = totalRevenue > 0 ? ((profit / totalRevenue) * 100).toFixed(1) : 0;

    return {
      success: true,
      data: {
        costs: {
          deepgram: {
            name: 'Deepgram (Speech-to-Text)',
            cost: deepgram.cost || 0,
            currency: 'USD',
            ...deepgram
          },
          googleTranslate: {
            name: 'Google Cloud Translation',
            cost: googleTranslate.cost || 0,
            currency: 'USD',
            ...googleTranslate
          },
          supabase: {
            name: 'Supabase (Database)',
            cost: supabaseCosts.cost || 0,
            currency: 'USD',
            ...supabaseCosts
          },
          render: {
            name: 'Render (Server Hosting)',
            cost: render.cost || 0,
            currency: 'USD',
            ...render
          },
          vercel: {
            name: 'Vercel (Client Hosting)',
            cost: vercel.cost || 0,
            currency: 'USD',
            ...vercel
          },
          total: totalCosts
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
          totalCosts,
          totalRevenue,
          profit,
          profitMargin,
          isProfit: profit >= 0
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
