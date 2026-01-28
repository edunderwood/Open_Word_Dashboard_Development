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
 * Uses Supabase translation_usage for accurate character counts
 * Falls back to Google Cloud Monitoring estimates if Supabase fails
 */
async function getGoogleTranslateCosts() {
  try {
    const { now, startOfMonth } = getCurrentMonthRange();
    const daysInMonth = Math.ceil((now - startOfMonth) / (1000 * 60 * 60 * 24)) || 1;

    // Get actual character counts from Supabase translation_usage table
    let totalCharacters = 0;
    let translationRecords = 0;

    try {
      // Note: language='transcript' for transcriptions, other values are actual translations
      const { data: usageData, error: usageError } = await supabase
        .from('translation_usage')
        .select('character_count, language')
        .gte('created_at', startOfMonth.toISOString())
        .neq('language', 'transcript'); // Only count translations, not transcripts

      if (!usageError && usageData) {
        usageData.forEach(record => {
          totalCharacters += record.character_count || 0;
        });
        translationRecords = usageData.length;
        console.log(`📊 Google Translate: ${totalCharacters.toLocaleString()} chars from ${translationRecords} records (Supabase)`);
      }
    } catch (dbError) {
      console.error('Error fetching translation usage from Supabase:', dbError.message);
    }

    // Also get Google Cloud Monitoring data for comparison/latency info
    let googleAnalytics = null;
    try {
      googleAnalytics = await getGoogleAnalytics(daysInMonth);
    } catch (gcError) {
      console.error('Error fetching Google Cloud analytics:', gcError.message);
    }

    // Calculate cost: $20 per million characters
    const COST_PER_MILLION_CHARS_USD = 20;
    const costUSD = (totalCharacters / 1000000) * COST_PER_MILLION_CHARS_USD;

    return {
      cost: costUSD * USD_TO_GBP,
      costUSD,
      characters: totalCharacters,
      translationRecords,
      tier: 'Pay-as-you-go',
      details: {
        source: totalCharacters > 0 ? 'Supabase (accurate)' : 'No data',
        avgLatencyMs: googleAnalytics?.data?.summary?.avgLatencyMs || 'N/A',
        errorRate: googleAnalytics?.data?.summary?.errorRate || 'N/A',
        googleCloudEstimate: googleAnalytics?.data?.summary?.approxCharacters || 0
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
    let totalOrgs = 0;
    try {
      const result = await supabase
        .from('organisations')
        .select('*', { count: 'exact', head: true });
      totalOrgs = result.count || 0;
    } catch (e) {
      totalOrgs = 0;
    }

    const estimatedOnProTier = totalOrgs > 50;
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
 * Get usage statistics: tier breakdown, credit usage last month and this month
 */
async function getUsageStatistics() {
  try {
    const now = new Date();

    // This month date range
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    // Last month date range
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    console.log(`📊 Usage stats date ranges:`);
    console.log(`   This month: ${thisMonthStart.toISOString()} to ${thisMonthEnd.toISOString()}`);
    console.log(`   Last month: ${lastMonthStart.toISOString()} to ${lastMonthEnd.toISOString()}`);

    // Fetch pricing tiers from database (source of truth for prices)
    const { data: pricingTiers } = await supabase
      .from('pricing_tiers')
      .select('id, monthly_fee_pence, credit_price_pence');

    // Build tier fee map from database (convert pence to pounds)
    const TIER_MONTHLY_FEES = {};
    let creditPricePence = 118; // Default fallback
    pricingTiers?.forEach(tier => {
      TIER_MONTHLY_FEES[tier.id] = (tier.monthly_fee_pence || 0) / 100;
      if (tier.credit_price_pence) {
        creditPricePence = tier.credit_price_pence; // Use first found credit price
      }
    });

    // Fallback if no pricing tiers found
    if (Object.keys(TIER_MONTHLY_FEES).length === 0) {
      TIER_MONTHLY_FEES.basic = 14;
      TIER_MONTHLY_FEES.standard = 28;
      TIER_MONTHLY_FEES.pro = 44;
      TIER_MONTHLY_FEES.enterprise = 300;
    }

    // Credit value from database (convert pence to pounds)
    const CREDIT_VALUE_FULL = creditPricePence / 100;

    // Get organisations by tier with discount info
    // EXCLUDE cancelled subscriptions (subscription_cancelled_at IS NOT NULL)
    const { data: orgs } = await supabase
      .from('organisations')
      .select('id, subscription_tier, minimum_monthly_fee, charity_verified, charity_discount_percent, discount_percent, subscription_cancelled_at')
      .is('subscription_cancelled_at', null); // Only include active subscriptions

    // Build a map of org_id -> effective discount (charity or general discount)
    const orgDiscountMap = {};
    orgs?.forEach(org => {
      // Charity discount takes priority, then general discount
      if (org.charity_verified) {
        orgDiscountMap[org.id] = org.charity_discount_percent || 50;
      } else if (org.discount_percent > 0) {
        orgDiscountMap[org.id] = org.discount_percent;
      } else {
        orgDiscountMap[org.id] = 0;
      }
    });

    // Count orgs by tier and calculate expected fees
    const tierBreakdown = {
      basic: { count: 0, expectedFee: 0 },
      standard: { count: 0, expectedFee: 0 },
      pro: { count: 0, expectedFee: 0 },
      enterprise: { count: 0, expectedFee: 0 }
    };

    let totalExpectedMonthlyFees = 0;

    orgs?.forEach(org => {
      const tier = org.subscription_tier || 'basic';
      if (tierBreakdown[tier]) {
        tierBreakdown[tier].count++;

        // Use org's minimum_monthly_fee if set, otherwise use tier default from database
        let fee = org.minimum_monthly_fee || TIER_MONTHLY_FEES[tier] || 14;

        // Apply discount (charity or general)
        const discount = orgDiscountMap[org.id] || 0;
        if (discount > 0) {
          fee = fee * (1 - discount / 100);
        }

        tierBreakdown[tier].expectedFee += fee;
        totalExpectedMonthlyFees += fee;
      }
    });

    // Get credit usage for this month WITH organisation_id
    const { data: thisMonthUsage, error: thisMonthError } = await supabase
      .from('credit_usage')
      .select('credits_used, total_billable_characters, organisation_id')
      .gte('session_start', thisMonthStart.toISOString())
      .lte('session_start', thisMonthEnd.toISOString());

    if (thisMonthError) {
      console.error('Error fetching this month usage:', thisMonthError);
    }

    let thisMonthCredits = 0;
    let thisMonthCharacters = 0;
    let thisMonthValueGBP = 0;

    thisMonthUsage?.forEach(u => {
      const credits = parseFloat(u.credits_used) || 0;
      thisMonthCredits += credits;
      thisMonthCharacters += u.total_billable_characters || 0;

      // Calculate value based on org's discount (charity or general)
      const discount = orgDiscountMap[u.organisation_id] || 0;
      const creditValue = CREDIT_VALUE_FULL * (1 - discount / 100);
      thisMonthValueGBP += credits * creditValue;
    });

    // Get credit usage for last month WITH organisation_id
    const { data: lastMonthUsage, error: lastMonthError } = await supabase
      .from('credit_usage')
      .select('credits_used, total_billable_characters, organisation_id')
      .gte('session_start', lastMonthStart.toISOString())
      .lte('session_start', lastMonthEnd.toISOString());

    if (lastMonthError) {
      console.error('Error fetching last month usage:', lastMonthError);
    }

    console.log(`   This month records: ${thisMonthUsage?.length || 0}`);
    console.log(`   Last month records: ${lastMonthUsage?.length || 0}`);

    let lastMonthCredits = 0;
    let lastMonthCharacters = 0;
    let lastMonthValueGBP = 0;

    lastMonthUsage?.forEach(u => {
      const credits = parseFloat(u.credits_used) || 0;
      lastMonthCredits += credits;
      lastMonthCharacters += u.total_billable_characters || 0;

      // Calculate value based on org's discount (charity or general)
      const discount = orgDiscountMap[u.organisation_id] || 0;
      const creditValue = CREDIT_VALUE_FULL * (1 - discount / 100);
      lastMonthValueGBP += credits * creditValue;
    });

    return {
      tierBreakdown,
      totalOrganisations: orgs?.length || 0,
      expectedMonthlyFees: totalExpectedMonthlyFees,
      thisMonth: {
        creditsUsed: thisMonthCredits,
        charactersProcessed: thisMonthCharacters,
        valueGBP: thisMonthValueGBP,
        period: `${thisMonthStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} - ${now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
      },
      lastMonth: {
        creditsUsed: lastMonthCredits,
        charactersProcessed: lastMonthCharacters,
        valueGBP: lastMonthValueGBP,
        period: lastMonthStart.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
      },
      creditValueGBP: CREDIT_VALUE_FULL
    };
  } catch (error) {
    console.error('Error getting usage statistics:', error);
    return {
      error: error.message,
      tierBreakdown: {},
      expectedMonthlyFees: 0,
      thisMonth: { creditsUsed: 0, charactersProcessed: 0, valueGBP: 0 },
      lastMonth: { creditsUsed: 0, charactersProcessed: 0, valueGBP: 0 }
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
    const [deepgram, googleTranslate, supabaseCosts, render, vercel, revenue, usageStats] = await Promise.all([
      getDeepgramCosts(),
      getGoogleTranslateCosts(),
      getSupabaseCosts(),
      getRenderCosts(),
      getVercelCosts(),
      getMonthlyRevenue(),
      getUsageStatistics()
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
        usage: {
          tierBreakdown: usageStats.tierBreakdown || {},
          totalOrganisations: usageStats.totalOrganisations || 0,
          expectedMonthlyFees: usageStats.expectedMonthlyFees || 0,
          thisMonth: usageStats.thisMonth || { creditsUsed: 0, charactersProcessed: 0, valueGBP: 0 },
          lastMonth: usageStats.lastMonth || { creditsUsed: 0, charactersProcessed: 0, valueGBP: 0 },
          creditValueGBP: usageStats.creditValueGBP || 1.18
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
