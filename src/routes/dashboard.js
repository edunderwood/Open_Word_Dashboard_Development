/**
 * Dashboard Routes - Summary Statistics
 */

import express from 'express';
import supabase from '../services/supabase.js';
import stripe from '../services/stripe.js';

const router = express.Router();

/**
 * GET /api/dashboard/summary
 * Get key statistics for the dashboard
 */
router.get('/summary', async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59).toISOString();

    // Get total customers
    const { count: totalCustomers, error: custError } = await supabase
      .from('organisations')
      .select('*', { count: 'exact', head: true });

    // Get active customers (with active subscription)
    const { count: activeCustomers, error: activeError } = await supabase
      .from('organisations')
      .select('*', { count: 'exact', head: true })
      .in('subscription_status', ['active', 'trialing']);

    // Get customers by plan
    const { data: planBreakdown, error: planError } = await supabase
      .from('organisations')
      .select('subscription_plan')
      .not('subscription_plan', 'is', null);

    const planCounts = {};
    planBreakdown?.forEach(org => {
      const plan = org.subscription_plan || 'pay_as_you_go';
      planCounts[plan] = (planCounts[plan] || 0) + 1;
    });

    // Get usage this month from streaming_sessions (faster than translation_usage)
    const { data: sessionsThisMonth, error: usageError } = await supabase
      .from('streaming_sessions')
      .select('characters_transcribed, characters_translated')
      .in('status', ['completed', 'recovered'])
      .gte('started_at', startOfMonth);

    let totalCharactersThisMonth = 0;
    sessionsThisMonth?.forEach(s => {
      totalCharactersThisMonth += (s.characters_transcribed || 0) + (s.characters_translated || 0);
    });
    // Estimate cost at £0.000024/char (standard rate)
    const totalCostThisMonth = totalCharactersThisMonth * 0.000024;

    // Get usage last month from streaming_sessions
    const { data: sessionsLastMonth, error: usageLastError } = await supabase
      .from('streaming_sessions')
      .select('characters_transcribed, characters_translated')
      .in('status', ['completed', 'recovered'])
      .gte('started_at', startOfLastMonth)
      .lte('started_at', endOfLastMonth);

    let totalCharactersLastMonth = 0;
    sessionsLastMonth?.forEach(s => {
      totalCharactersLastMonth += (s.characters_transcribed || 0) + (s.characters_translated || 0);
    });
    const totalCostLastMonth = totalCharactersLastMonth * 0.000024;

    // Get customers with issues
    const { count: pausedCustomers } = await supabase
      .from('organisations')
      .select('*', { count: 'exact', head: true })
      .eq('is_paused', true);

    const { count: paymentIssues } = await supabase
      .from('organisations')
      .select('*', { count: 'exact', head: true })
      .in('subscription_status', ['past_due', 'unpaid']);

    // Get trial customers
    const { count: trialCustomers } = await supabase
      .from('organisations')
      .select('*', { count: 'exact', head: true })
      .eq('subscription_status', 'trialing');

    // Get new customers this month
    const { count: newCustomersThisMonth } = await supabase
      .from('organisations')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', startOfMonth);

    res.json({
      success: true,
      data: {
        customers: {
          total: totalCustomers || 0,
          active: activeCustomers || 0,
          trial: trialCustomers || 0,
          paused: pausedCustomers || 0,
          paymentIssues: paymentIssues || 0,
          newThisMonth: newCustomersThisMonth || 0,
        },
        planBreakdown: planCounts,
        usage: {
          thisMonth: {
            characters: totalCharactersThisMonth,
            cost: totalCostThisMonth,
          },
          lastMonth: {
            characters: totalCharactersLastMonth,
            cost: totalCostLastMonth,
          },
        },
        timestamp: new Date().toISOString(),
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard summary:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard summary' });
  }
});

/**
 * GET /api/dashboard/recent-activity
 * Get recent customer activity
 */
router.get('/recent-activity', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;

    // Get recent signups
    const { data: recentSignups, error: signupError } = await supabase
      .from('organisations')
      .select('id, name, created_at, subscription_tier, subscription_status')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (signupError) {
      console.error('Error fetching recent signups:', signupError);
    }

    // Get recent usage from streaming_sessions
    const { data: recentSessions, error: sessionsError } = await supabase
      .from('streaming_sessions')
      .select(`
        id,
        started_at,
        characters_transcribed,
        characters_translated,
        duration_minutes,
        status,
        organisation_id,
        organisations (name)
      `)
      .order('started_at', { ascending: false })
      .limit(limit);

    if (sessionsError) {
      console.error('Error fetching streaming sessions:', sessionsError);
    }

    // Also get recent credit usage as fallback
    const { data: recentCredits, error: creditsError } = await supabase
      .from('credit_usage')
      .select(`
        id,
        session_start,
        total_billable_characters,
        credits_used,
        organisation_id,
        organisations (name)
      `)
      .order('session_start', { ascending: false })
      .limit(limit);

    if (creditsError) {
      console.error('Error fetching credit usage:', creditsError);
    }

    // Combine and format usage data - prefer streaming_sessions, fall back to credit_usage
    let formattedUsage = [];

    if (recentSessions && recentSessions.length > 0) {
      formattedUsage = recentSessions.map(session => ({
        id: session.id,
        created_at: session.started_at,
        character_count: session.characters_translated || 0,
        duration_minutes: session.duration_minutes || 0,
        operation_type: session.status === 'active' ? 'Streaming' : 'Session',
        organisation_id: session.organisation_id,
        organisations: session.organisations
      }));
    } else if (recentCredits && recentCredits.length > 0) {
      formattedUsage = recentCredits.map(usage => ({
        id: usage.id,
        created_at: usage.session_start,
        character_count: usage.total_billable_characters || 0,
        operation_type: `${(usage.credits_used || 0).toFixed(1)} credits`,
        organisation_id: usage.organisation_id,
        organisations: usage.organisations
      }));
    }

    res.json({
      success: true,
      data: {
        recentSignups: recentSignups || [],
        recentUsage: formattedUsage,
      }
    });
  } catch (error) {
    console.error('Error fetching recent activity:', error);
    res.status(500).json({ error: 'Failed to fetch recent activity' });
  }
});

/**
 * GET /api/dashboard/credits
 * Get credit system statistics across all customers
 */
router.get('/credits', async (req, res) => {
  try {
    const CHARS_PER_CREDIT = 23000;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // Get all credit balances
    const { data: balances, error: balancesError } = await supabase
      .from('credit_balances')
      .select('current_balance, lifetime_purchased, lifetime_used, organisation_id');

    // Calculate totals
    let totalCurrentBalance = 0;
    let totalLifetimePurchased = 0;
    let totalLifetimeUsed = 0;
    let lowBalanceCount = 0;
    let zeroBalanceCount = 0;

    balances?.forEach(b => {
      const balance = parseFloat(b.current_balance) || 0;
      totalCurrentBalance += balance;
      totalLifetimePurchased += parseFloat(b.lifetime_purchased) || 0;
      totalLifetimeUsed += parseFloat(b.lifetime_used) || 0;

      if (balance <= 0) {
        zeroBalanceCount++;
      } else if (balance <= 10) {
        lowBalanceCount++;
      }
    });

    // Get credit purchases this month
    const { data: purchasesThisMonth } = await supabase
      .from('credit_purchases')
      .select('credits_purchased, amount_paid_pence')
      .gte('created_at', startOfMonth);

    let creditsPurchasedThisMonth = 0;
    let revenueThisMonth = 0;
    purchasesThisMonth?.forEach(p => {
      creditsPurchasedThisMonth += parseFloat(p.credits_purchased) || 0;
      revenueThisMonth += (p.amount_paid_pence || 0) / 100;
    });

    // Get credit usage this month
    const { data: usageThisMonth } = await supabase
      .from('credit_usage')
      .select('credits_used, total_billable_characters')
      .gte('session_start', startOfMonth);

    let creditsUsedThisMonth = 0;
    let charsThisMonth = 0;
    usageThisMonth?.forEach(u => {
      creditsUsedThisMonth += parseFloat(u.credits_used) || 0;
      charsThisMonth += u.total_billable_characters || 0;
    });

    // Get tier breakdown
    const { data: tierBreakdown } = await supabase
      .from('organisations')
      .select('subscription_tier');

    const tierCounts = { basic: 0, standard: 0, pro: 0, enterprise: 0 };
    tierBreakdown?.forEach(org => {
      const tier = org.subscription_tier || 'basic';
      tierCounts[tier] = (tierCounts[tier] || 0) + 1;
    });

    res.json({
      success: true,
      data: {
        balances: {
          totalCurrent: totalCurrentBalance,
          totalPurchased: totalLifetimePurchased,
          totalUsed: totalLifetimeUsed,
          customersWithBalance: balances?.length || 0,
          lowBalance: lowBalanceCount,
          zeroBalance: zeroBalanceCount
        },
        thisMonth: {
          creditsPurchased: creditsPurchasedThisMonth,
          creditsUsed: creditsUsedThisMonth,
          revenue: revenueThisMonth,
          charactersProcessed: charsThisMonth
        },
        tiers: tierCounts,
        charsPerCredit: CHARS_PER_CREDIT
      }
    });
  } catch (error) {
    console.error('Error fetching credit stats:', error);
    res.status(500).json({ error: 'Failed to fetch credit statistics' });
  }
});

/**
 * GET /api/dashboard/low-balance-customers
 * Get customers with low or zero credit balances
 */
router.get('/low-balance-customers', async (req, res) => {
  try {
    const threshold = parseFloat(req.query.threshold) || 10;

    // Get low balance customers with org details
    const { data: lowBalanceOrgs, error } = await supabase
      .from('credit_balances')
      .select(`
        current_balance,
        lifetime_purchased,
        lifetime_used,
        updated_at,
        organisation_id,
        organisations (
          id,
          name,
          organisation_key,
          subscription_tier,
          is_charity
        )
      `)
      .lte('current_balance', threshold)
      .order('current_balance', { ascending: true });

    if (error) throw error;

    // Format response
    const customers = lowBalanceOrgs?.map(b => ({
      id: b.organisation_id,
      name: b.organisations?.name || 'Unknown',
      organisationKey: b.organisations?.organisation_key,
      tier: b.organisations?.subscription_tier || 'basic',
      isCharity: b.organisations?.is_charity || false,
      currentBalance: parseFloat(b.current_balance) || 0,
      lifetimeUsed: parseFloat(b.lifetime_used) || 0,
      lastUpdated: b.updated_at
    })) || [];

    res.json({
      success: true,
      data: {
        threshold,
        count: customers.length,
        customers
      }
    });
  } catch (error) {
    console.error('Error fetching low balance customers:', error);
    res.status(500).json({ error: 'Failed to fetch low balance customers' });
  }
});

/**
 * GET /api/dashboard/revenue
 * Get revenue statistics from Stripe
 */
router.get('/revenue', async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
    const startOfLastMonth = Math.floor(new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime() / 1000);
    const endOfLastMonth = Math.floor(new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59).getTime() / 1000);

    // Get charges this month
    const chargesThisMonth = await stripe.charges.list({
      created: { gte: startOfMonth },
      limit: 100,
    });

    let revenueThisMonth = 0;
    chargesThisMonth.data.forEach(charge => {
      if (charge.status === 'succeeded') {
        revenueThisMonth += charge.amount;
      }
    });

    // Get charges last month
    const chargesLastMonth = await stripe.charges.list({
      created: { gte: startOfLastMonth, lte: endOfLastMonth },
      limit: 100,
    });

    let revenueLastMonth = 0;
    chargesLastMonth.data.forEach(charge => {
      if (charge.status === 'succeeded') {
        revenueLastMonth += charge.amount;
      }
    });

    // Get MRR from active subscriptions (accounting for discounts)
    const subscriptions = await stripe.subscriptions.list({
      status: 'active',
      limit: 100,
      expand: ['data.discount.coupon'], // Expand to get coupon details
    });

    let mrr = 0;
    subscriptions.data.forEach(sub => {
      let subscriptionAmount = 0;

      // Calculate base subscription amount
      sub.items.data.forEach(item => {
        if (item.price.recurring) {
          const amount = item.price.unit_amount || 0;
          const interval = item.price.recurring.interval;
          if (interval === 'month') {
            subscriptionAmount += amount;
          } else if (interval === 'year') {
            subscriptionAmount += amount / 12;
          }
        }
      });

      // Apply discount if present
      if (sub.discount && sub.discount.coupon) {
        const coupon = sub.discount.coupon;
        if (coupon.percent_off) {
          // Percentage discount (e.g., 50% off)
          subscriptionAmount = subscriptionAmount * (1 - coupon.percent_off / 100);
        } else if (coupon.amount_off) {
          // Fixed amount discount (in smallest currency unit)
          subscriptionAmount = Math.max(0, subscriptionAmount - coupon.amount_off);
        }
      }

      mrr += subscriptionAmount;
    });

    res.json({
      success: true,
      data: {
        revenueThisMonth: revenueThisMonth / 100, // Convert from pence to pounds
        revenueLastMonth: revenueLastMonth / 100,
        mrr: mrr / 100,
        activeSubscriptions: subscriptions.data.length,
      }
    });
  } catch (error) {
    console.error('Error fetching revenue:', error);
    res.status(500).json({ error: 'Failed to fetch revenue data' });
  }
});

/**
 * GET /api/dashboard/pending-charity-reviews
 * Get organisations with pending charity review requests
 */
router.get('/pending-charity-reviews', async (req, res) => {
  try {
    const { data: pendingReviews, error } = await supabase
      .from('organisations')
      .select('id, name, charity_number, charity_region, charity_review_reason, charity_review_requested_at, contact_name, is_charity')
      .eq('charity_review_requested', true)
      .eq('charity_verified', false)
      .order('charity_review_requested_at', { ascending: true });

    if (error) throw error;

    res.json({
      success: true,
      data: {
        count: pendingReviews?.length || 0,
        reviews: pendingReviews || []
      }
    });
  } catch (error) {
    console.error('Error fetching pending charity reviews:', error);
    res.status(500).json({ error: 'Failed to fetch pending charity reviews' });
  }
});

/**
 * GET /api/dashboard/pending-discount-reviews
 * Get organisations with pending discount review requests (non-charities)
 */
router.get('/pending-discount-reviews', async (req, res) => {
  try {
    const { data: pendingReviews, error } = await supabase
      .from('organisations')
      .select('id, name, discount_review_reason, discount_review_requested_at, contact_name, subscription_tier')
      .eq('discount_review_requested', true)
      .eq('discount_percent', 0)
      .order('discount_review_requested_at', { ascending: true });

    if (error) throw error;

    res.json({
      success: true,
      data: {
        count: pendingReviews?.length || 0,
        reviews: pendingReviews || []
      }
    });
  } catch (error) {
    console.error('Error fetching pending discount reviews:', error);
    res.status(500).json({ error: 'Failed to fetch pending discount reviews' });
  }
});

export default router;
