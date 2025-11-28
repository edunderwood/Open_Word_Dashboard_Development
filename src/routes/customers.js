/**
 * Customer Management Routes
 */

import express from 'express';
import supabase from '../services/supabase.js';
import stripe from '../services/stripe.js';

const router = express.Router();

/**
 * GET /api/customers
 * List all customers with pagination and filters
 */
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const status = req.query.status || '';
    const plan = req.query.plan || '';

    let query = supabase
      .from('organisations')
      .select('*', { count: 'exact' });

    // Apply filters
    if (search) {
      query = query.or(`name.ilike.%${search}%,organisation_key.ilike.%${search}%`);
    }

    if (status) {
      if (status === 'paused') {
        query = query.eq('is_paused', true);
      } else {
        query = query.eq('subscription_status', status);
      }
    }

    if (plan) {
      query = query.eq('subscription_plan', plan);
    }

    // Get total count first
    const { count: totalCount } = await query;

    // Apply pagination
    const { data: customers, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({
      success: true,
      data: customers,
      pagination: {
        page,
        limit,
        total: totalCount,
        pages: Math.ceil(totalCount / limit),
      }
    });
  } catch (error) {
    console.error('Error fetching customers:', error);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

/**
 * GET /api/customers/:id
 * Get single customer details
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: customer, error } = await supabase
      .from('organisations')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Get Stripe subscription details if available
    let stripeData = null;
    if (customer.stripe_subscription_id) {
      try {
        const subscription = await stripe.subscriptions.retrieve(customer.stripe_subscription_id);
        stripeData = {
          status: subscription.status,
          currentPeriodStart: new Date(subscription.current_period_start * 1000).toISOString(),
          currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
        };
      } catch (stripeError) {
        console.error('Error fetching Stripe subscription:', stripeError);
      }
    }

    res.json({
      success: true,
      data: {
        ...customer,
        stripe: stripeData,
      }
    });
  } catch (error) {
    console.error('Error fetching customer:', error);
    res.status(500).json({ error: 'Failed to fetch customer' });
  }
});

/**
 * GET /api/customers/:id/usage
 * Get customer usage statistics
 */
router.get('/:id/usage', async (req, res) => {
  try {
    const { id } = req.params;
    const period = req.query.period || 'month';

    // Calculate date range
    let startDate;
    const now = new Date();

    switch (period) {
      case 'today':
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'week':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case '90':
        startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      case 'all':
        startDate = new Date(2020, 0, 1); // Far past date
        break;
      default:
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const { data: usage, error } = await supabase
      .from('translation_usage')
      .select('*')
      .eq('organisation_id', id)
      .gte('created_at', startDate.toISOString())
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Aggregate statistics
    let totalCharacters = 0;
    let totalCost = 0;
    let transcriptionChars = 0;
    let translationChars = 0;
    const byLanguage = {};
    const byDate = {};

    usage?.forEach(u => {
      totalCharacters += u.character_count || 0;
      totalCost += parseFloat(u.estimated_cost) || 0;

      if (u.operation_type === 'transcription') {
        transcriptionChars += u.character_count || 0;
      } else {
        translationChars += u.character_count || 0;
      }

      // By language
      const lang = u.target_language || 'transcript';
      byLanguage[lang] = (byLanguage[lang] || 0) + (u.character_count || 0);

      // By date
      const date = u.created_at.split('T')[0];
      if (!byDate[date]) {
        byDate[date] = { characters: 0, cost: 0 };
      }
      byDate[date].characters += u.character_count || 0;
      byDate[date].cost += parseFloat(u.estimated_cost) || 0;
    });

    res.json({
      success: true,
      data: {
        period,
        totalCharacters,
        totalCost,
        transcriptionChars,
        translationChars,
        byLanguage,
        byDate,
        records: usage?.length || 0,
      }
    });
  } catch (error) {
    console.error('Error fetching customer usage:', error);
    res.status(500).json({ error: 'Failed to fetch customer usage' });
  }
});

/**
 * POST /api/customers/:id/pause
 * Pause a customer's account
 */
router.post('/:id/pause', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { data, error } = await supabase
      .from('organisations')
      .update({
        is_paused: true,
        paused_at: new Date().toISOString(),
        pause_reason: reason || 'Paused by admin',
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    console.log(`⏸️ Customer paused: ${data.name} (${id})`);

    res.json({
      success: true,
      message: 'Customer paused successfully',
      data,
    });
  } catch (error) {
    console.error('Error pausing customer:', error);
    res.status(500).json({ error: 'Failed to pause customer' });
  }
});

/**
 * POST /api/customers/:id/unpause
 * Unpause a customer's account
 */
router.post('/:id/unpause', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('organisations')
      .update({
        is_paused: false,
        paused_at: null,
        pause_reason: null,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    console.log(`▶️ Customer unpaused: ${data.name} (${id})`);

    res.json({
      success: true,
      message: 'Customer unpaused successfully',
      data,
    });
  } catch (error) {
    console.error('Error unpausing customer:', error);
    res.status(500).json({ error: 'Failed to unpause customer' });
  }
});

/**
 * POST /api/customers/:id/end-trial
 * End a customer's trial early
 */
router.post('/:id/end-trial', async (req, res) => {
  try {
    const { id } = req.params;

    // Get customer's Stripe subscription ID
    const { data: customer, error: custError } = await supabase
      .from('organisations')
      .select('stripe_subscription_id, name')
      .eq('id', id)
      .single();

    if (custError) throw custError;

    if (!customer?.stripe_subscription_id) {
      return res.status(400).json({ error: 'Customer has no active subscription' });
    }

    // End trial in Stripe
    const subscription = await stripe.subscriptions.update(customer.stripe_subscription_id, {
      trial_end: 'now',
    });

    // Update local database
    await supabase
      .from('organisations')
      .update({
        subscription_status: subscription.status,
        trial_ends_at: null,
      })
      .eq('id', id);

    console.log(`⏱️ Trial ended for: ${customer.name} (${id})`);

    res.json({
      success: true,
      message: 'Trial ended successfully',
      data: {
        newStatus: subscription.status,
      },
    });
  } catch (error) {
    console.error('Error ending trial:', error);
    res.status(500).json({ error: 'Failed to end trial' });
  }
});

/**
 * POST /api/customers/:id/cancel-subscription
 * Cancel a customer's subscription
 */
router.post('/:id/cancel-subscription', async (req, res) => {
  try {
    const { id } = req.params;
    const { immediately } = req.body;

    // Get customer's Stripe subscription ID
    const { data: customer, error: custError } = await supabase
      .from('organisations')
      .select('stripe_subscription_id, name')
      .eq('id', id)
      .single();

    if (custError) throw custError;

    if (!customer?.stripe_subscription_id) {
      return res.status(400).json({ error: 'Customer has no active subscription' });
    }

    let subscription;
    if (immediately) {
      // Cancel immediately
      subscription = await stripe.subscriptions.cancel(customer.stripe_subscription_id);
    } else {
      // Cancel at period end
      subscription = await stripe.subscriptions.update(customer.stripe_subscription_id, {
        cancel_at_period_end: true,
      });
    }

    // Update local database
    await supabase
      .from('organisations')
      .update({
        subscription_status: subscription.status,
      })
      .eq('id', id);

    console.log(`❌ Subscription cancelled for: ${customer.name} (${id}) - ${immediately ? 'immediately' : 'at period end'}`);

    res.json({
      success: true,
      message: immediately ? 'Subscription cancelled immediately' : 'Subscription will cancel at end of billing period',
      data: {
        status: subscription.status,
        cancelAt: subscription.cancel_at ? new Date(subscription.cancel_at * 1000).toISOString() : null,
      },
    });
  } catch (error) {
    console.error('Error cancelling subscription:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

export default router;
