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

    // Get usage this month
    const { data: usageThisMonth, error: usageError } = await supabase
      .from('translation_usage')
      .select('character_count, estimated_cost')
      .gte('created_at', startOfMonth);

    let totalCharactersThisMonth = 0;
    let totalCostThisMonth = 0;
    usageThisMonth?.forEach(u => {
      totalCharactersThisMonth += u.character_count || 0;
      totalCostThisMonth += parseFloat(u.estimated_cost) || 0;
    });

    // Get usage last month
    const { data: usageLastMonth, error: usageLastError } = await supabase
      .from('translation_usage')
      .select('character_count, estimated_cost')
      .gte('created_at', startOfLastMonth)
      .lte('created_at', endOfLastMonth);

    let totalCharactersLastMonth = 0;
    let totalCostLastMonth = 0;
    usageLastMonth?.forEach(u => {
      totalCharactersLastMonth += u.character_count || 0;
      totalCostLastMonth += parseFloat(u.estimated_cost) || 0;
    });

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
      .select('id, name, created_at, subscription_plan, subscription_status')
      .order('created_at', { ascending: false })
      .limit(limit);

    // Get recent usage
    const { data: recentUsage, error: usageError } = await supabase
      .from('translation_usage')
      .select(`
        id,
        created_at,
        character_count,
        operation_type,
        organisation_id,
        organisations (name)
      `)
      .order('created_at', { ascending: false })
      .limit(limit);

    res.json({
      success: true,
      data: {
        recentSignups: recentSignups || [],
        recentUsage: recentUsage || [],
      }
    });
  } catch (error) {
    console.error('Error fetching recent activity:', error);
    res.status(500).json({ error: 'Failed to fetch recent activity' });
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

    // Get MRR from active subscriptions
    const subscriptions = await stripe.subscriptions.list({
      status: 'active',
      limit: 100,
    });

    let mrr = 0;
    subscriptions.data.forEach(sub => {
      sub.items.data.forEach(item => {
        if (item.price.recurring) {
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

export default router;
