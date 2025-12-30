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
      query = query.eq('subscription_tier', plan);
    }

    // Charity/Discount filter
    const charity = req.query.charity || '';
    if (charity) {
      switch (charity) {
        case 'verified':
          query = query.eq('charity_verified', true);
          break;
        case 'discounted':
          // Non-charity organisations with a discount
          query = query.eq('charity_verified', false).gt('discount_percent', 0);
          break;
        case 'discount_pending':
          // Non-charity organisations requesting a discount
          query = query.eq('discount_review_requested', true).eq('discount_percent', 0);
          break;
        case 'pending':
          query = query.eq('charity_review_requested', true).eq('charity_verified', false);
          break;
        case 'claimed':
          query = query.eq('is_registered_charity', true).eq('charity_verified', false);
          break;
        case 'none':
          // No charity status AND no non-charity discount
          query = query.eq('is_registered_charity', false).eq('charity_verified', false);
          // Note: We can't easily filter discount_percent = 0 OR NULL in this query builder
          // So 'none' will show all non-charity orgs (some may have discounts)
          break;
      }
    }

    // Get total count first
    const { count: totalCount } = await query;

    // Apply pagination
    const { data: customers, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    // Get customer IDs for batch fetching credits
    const customerIds = customers.map(c => c.id);

    // Batch fetch credit balances
    const { data: creditBalances } = await supabase
      .from('credit_balances')
      .select('organisation_id, current_balance')
      .in('organisation_id', customerIds);

    // Create a map of customer_id -> credit_balance
    const creditMap = {};
    creditBalances?.forEach(cb => {
      creditMap[cb.organisation_id] = parseFloat(cb.current_balance) || 0;
    });

    // Fetch last login for each customer (batch fetch auth users)
    const customersWithLogin = await Promise.all(
      customers.map(async (customer) => {
        let lastLogin = null;
        if (customer.user_id) {
          try {
            const { data: authUser } = await supabase.auth.admin.getUserById(customer.user_id);
            if (authUser?.user) {
              lastLogin = authUser.user.last_sign_in_at;
            }
          } catch (err) {
            // Silently fail for individual auth lookups
          }
        }
        return {
          ...customer,
          last_login: lastLogin,
          credit_balance: creditMap[customer.id] ?? 0
        };
      })
    );

    res.json({
      success: true,
      data: customersWithLogin,
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
 * GET /api/customers/:id/session-stats
 * Get customer session/streaming statistics from streaming_sessions table
 */
router.get('/:id/session-stats', async (req, res) => {
  try {
    const { id } = req.params;

    // Get customer with user_id for auth lookup
    const { data: customer, error: custError } = await supabase
      .from('organisations')
      .select('id, user_id, name')
      .eq('id', id)
      .single();

    if (custError) throw custError;
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Get last login from auth.users via admin API
    let lastLogin = null;
    if (customer.user_id) {
      try {
        const { data: authUser, error: authError } = await supabase.auth.admin.getUserById(customer.user_id);
        if (!authError && authUser?.user) {
          lastLogin = authUser.user.last_sign_in_at;
        }
      } catch (authErr) {
        console.error('Error fetching auth user:', authErr);
      }
    }

    // Get streaming sessions from the streaming_sessions table
    const { data: sessions, error: sessError } = await supabase
      .from('streaming_sessions')
      .select('*')
      .eq('organisation_id', id)
      .order('started_at', { ascending: false })
      .limit(50);

    if (sessError) {
      console.error('Error fetching streaming sessions:', sessError);
      // If table doesn't exist yet, return empty stats
      if (sessError.code === '42P01') {
        return res.json({
          success: true,
          data: {
            lastLogin,
            lastStreamingSession: null,
            sessionStats: {
              totalSessions: 0,
              avgSessionDurationMinutes: 0,
              avgSessionDurationFormatted: '0 min',
              last10Sessions: [],
              note: 'streaming_sessions table not yet created - run migration'
            },
          },
        });
      }
      throw sessError;
    }

    // Calculate session statistics
    let lastStreamingSession = null;
    let avgSessionDuration = 0;
    let totalSessions = 0;
    const sessionDurations = [];

    // Get the most recent session
    if (sessions && sessions.length > 0) {
      const mostRecent = sessions[0];
      lastStreamingSession = {
        startedAt: mostRecent.started_at,
        endedAt: mostRecent.ended_at,
        durationMinutes: mostRecent.duration_minutes,
        status: mostRecent.status,
        charactersTranscribed: mostRecent.characters_transcribed,
        charactersTranslated: mostRecent.characters_translated,
        sourceLanguage: mostRecent.source_language,
        languagesUsed: mostRecent.languages_used,
      };
    }

    // Get completed sessions with duration
    const completedSessions = sessions?.filter(s =>
      s.status === 'completed' && s.duration_minutes && s.duration_minutes > 0
    ) || [];

    // Build session list for stats
    completedSessions.forEach(session => {
      // Only count sessions with reasonable duration (1 min to 12 hours)
      if (session.duration_minutes >= 1 && session.duration_minutes <= 720) {
        sessionDurations.push({
          durationMinutes: session.duration_minutes,
          startedAt: session.started_at,
          endedAt: session.ended_at,
          charactersTranscribed: session.characters_transcribed || 0,
          charactersTranslated: session.characters_translated || 0,
          languagesUsed: session.languages_used || [],
        });
        totalSessions++;
      }
    });

    // Calculate average of last 10 sessions
    const last10Sessions = sessionDurations.slice(0, 10);
    if (last10Sessions.length > 0) {
      const totalDuration = last10Sessions.reduce((sum, s) => sum + s.durationMinutes, 0);
      avgSessionDuration = totalDuration / last10Sessions.length;
    }

    // Calculate total characters for last 10 sessions
    const totalTranscribed = last10Sessions.reduce((sum, s) => sum + (s.charactersTranscribed || 0), 0);
    const totalTranslated = last10Sessions.reduce((sum, s) => sum + (s.charactersTranslated || 0), 0);

    res.json({
      success: true,
      data: {
        lastLogin,
        lastStreamingSession,
        sessionStats: {
          totalSessions,
          avgSessionDurationMinutes: Math.round(avgSessionDuration * 10) / 10,
          avgSessionDurationFormatted: formatDuration(avgSessionDuration),
          totalCharactersTranscribed: totalTranscribed,
          totalCharactersTranslated: totalTranslated,
          last10Sessions: last10Sessions.map(s => ({
            ...s,
            durationFormatted: formatDuration(s.durationMinutes),
          })),
        },
      },
    });
  } catch (error) {
    console.error('Error fetching session stats:', error);
    res.status(500).json({ error: 'Failed to fetch session stats' });
  }
});

/**
 * Helper function to format duration in minutes to human readable
 */
function formatDuration(minutes) {
  if (!minutes || minutes <= 0) return '0 min';

  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);

  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins} min`;
}

/**
 * GET /api/customers/:id/credits
 * Get customer credit balance and history
 */
router.get('/:id/credits', async (req, res) => {
  try {
    const { id } = req.params;
    const CHARS_PER_CREDIT = 23000;

    // Get credit balance
    const { data: balance, error: balanceError } = await supabase
      .from('credit_balances')
      .select('*')
      .eq('organisation_id', id)
      .single();

    // Get recent purchases
    const { data: purchases, error: purchasesError } = await supabase
      .from('credit_purchases')
      .select('*')
      .eq('organisation_id', id)
      .order('created_at', { ascending: false })
      .limit(20);

    // Get recent usage
    const { data: usage, error: usageError } = await supabase
      .from('credit_usage')
      .select('*')
      .eq('organisation_id', id)
      .order('session_start', { ascending: false })
      .limit(20);

    // Calculate usage this month
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const { data: monthlyUsage } = await supabase
      .from('credit_usage')
      .select('credits_used, total_billable_characters')
      .eq('organisation_id', id)
      .gte('session_start', startOfMonth);

    let creditsUsedThisMonth = 0;
    let charsThisMonth = 0;
    monthlyUsage?.forEach(u => {
      creditsUsedThisMonth += parseFloat(u.credits_used) || 0;
      charsThisMonth += u.total_billable_characters || 0;
    });

    // Get organisation tier info
    const { data: org } = await supabase
      .from('organisations')
      .select('subscription_tier, is_registered_charity')
      .eq('id', id)
      .single();

    res.json({
      success: true,
      data: {
        balance: balance ? {
          current: parseFloat(balance.current_balance) || 0,
          purchased: parseFloat(balance.lifetime_purchased) || 0,
          used: parseFloat(balance.lifetime_used) || 0,
          lifetimePurchased: parseFloat(balance.lifetime_purchased) || 0,
          lifetimeUsed: parseFloat(balance.lifetime_used) || 0,
          lowBalanceThreshold: parseFloat(balance.low_balance_threshold) || 10,
          updatedAt: balance.updated_at
        } : {
          current: 0,
          purchased: 0,
          used: 0,
          lifetimePurchased: 0,
          lifetimeUsed: 0,
          lowBalanceThreshold: 10
        },
        tier: org?.subscription_tier || 'basic',
        isCharity: org?.is_registered_charity || false,
        thisMonth: {
          creditsUsed: creditsUsedThisMonth,
          charactersProcessed: charsThisMonth
        },
        purchases: purchases || [],
        recentUsage: usage || [],
        charsPerCredit: CHARS_PER_CREDIT
      }
    });
  } catch (error) {
    console.error('Error fetching customer credits:', error);
    res.status(500).json({ error: 'Failed to fetch customer credits' });
  }
});

/**
 * POST /api/customers/:id/add-credits
 * Add credits to a customer account (admin gift)
 */
router.post('/:id/add-credits', async (req, res) => {
  try {
    const { id } = req.params;
    const { credits, reason } = req.body;

    if (!credits || credits <= 0) {
      return res.status(400).json({ error: 'Credits must be a positive number' });
    }

    // Get current balance
    const { data: existingBalance } = await supabase
      .from('credit_balances')
      .select('*')
      .eq('organisation_id', id)
      .single();

    if (existingBalance) {
      // Update existing balance
      const { error: updateError } = await supabase
        .from('credit_balances')
        .update({
          current_balance: parseFloat(existingBalance.current_balance) + credits,
          lifetime_purchased: parseFloat(existingBalance.lifetime_purchased) + credits,
          updated_at: new Date().toISOString()
        })
        .eq('organisation_id', id);

      if (updateError) throw updateError;
    } else {
      // Create new balance record
      const { error: insertError } = await supabase
        .from('credit_balances')
        .insert({
          organisation_id: id,
          current_balance: credits,
          lifetime_purchased: credits,
          lifetime_used: 0
        });

      if (insertError) throw insertError;
    }

    // Record the purchase as a gift
    const { error: purchaseError } = await supabase
      .from('credit_purchases')
      .insert({
        organisation_id: id,
        credits_purchased: credits,
        amount_paid_pence: 0,
        unit_price_pence: 0,
        purchase_type: 'gift',
        notes: reason || 'Admin credit gift'
      });

    if (purchaseError) throw purchaseError;

    // Get organisation name for logging
    const { data: org } = await supabase
      .from('organisations')
      .select('name')
      .eq('id', id)
      .single();

    console.log(`🎁 ${credits} credits gifted to ${org?.name || id}: ${reason || 'No reason provided'}`);

    res.json({
      success: true,
      message: `${credits} credits added successfully`,
      data: {
        creditsAdded: credits,
        newBalance: existingBalance
          ? parseFloat(existingBalance.current_balance) + credits
          : credits
      }
    });
  } catch (error) {
    console.error('Error adding credits:', error);
    res.status(500).json({ error: 'Failed to add credits' });
  }
});

/**
 * POST /api/customers/:id/deduct-credits
 * Manually deduct credits (admin adjustment)
 */
router.post('/:id/deduct-credits', async (req, res) => {
  try {
    const { id } = req.params;
    const { credits, reason } = req.body;

    if (!credits || credits <= 0) {
      return res.status(400).json({ error: 'Credits must be a positive number' });
    }

    // Get current balance
    const { data: existingBalance, error: balanceError } = await supabase
      .from('credit_balances')
      .select('*')
      .eq('organisation_id', id)
      .single();

    if (balanceError || !existingBalance) {
      return res.status(400).json({ error: 'Customer has no credit balance' });
    }

    const currentBalance = parseFloat(existingBalance.current_balance);
    if (credits > currentBalance) {
      return res.status(400).json({
        error: `Cannot deduct ${credits} credits. Current balance is only ${currentBalance}`
      });
    }

    // Deduct credits
    const { error: updateError } = await supabase
      .from('credit_balances')
      .update({
        current_balance: currentBalance - credits,
        lifetime_used: parseFloat(existingBalance.lifetime_used) + credits,
        updated_at: new Date().toISOString()
      })
      .eq('organisation_id', id);

    if (updateError) throw updateError;

    // Get organisation name for logging
    const { data: org } = await supabase
      .from('organisations')
      .select('name')
      .eq('id', id)
      .single();

    console.log(`➖ ${credits} credits deducted from ${org?.name || id}: ${reason || 'No reason provided'}`);

    res.json({
      success: true,
      message: `${credits} credits deducted successfully`,
      data: {
        creditsDeducted: credits,
        newBalance: currentBalance - credits,
        reason: reason || 'Admin adjustment'
      }
    });
  } catch (error) {
    console.error('Error deducting credits:', error);
    res.status(500).json({ error: 'Failed to deduct credits' });
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

/**
 * POST /api/customers/:id/grant-charity-discount
 * Grant charity discount to a customer (even if not a verified charity)
 */
router.post('/:id/grant-charity-discount', async (req, res) => {
  try {
    const { id } = req.params;
    const { discountPercent, reason } = req.body;

    const discount = discountPercent || 50; // Default 50% discount

    const { data, error } = await supabase
      .from('organisations')
      .update({
        charity_verified: true,
        charity_discount_percent: discount,
        charity_review_requested: false,
        charity_review_completed_at: new Date().toISOString(),
        charity_review_notes: reason || 'Discount granted by admin'
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    console.log(`💚 Charity discount (${discount}%) granted to: ${data.name} (${id}) - ${reason || 'No reason'}`);

    res.json({
      success: true,
      message: `${discount}% charity discount granted successfully`,
      data,
    });
  } catch (error) {
    console.error('Error granting charity discount:', error);
    res.status(500).json({ error: 'Failed to grant charity discount' });
  }
});

/**
 * POST /api/customers/:id/deny-charity-review
 * Deny a charity review request (mark as completed without granting discount)
 */
router.post('/:id/deny-charity-review', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { data, error } = await supabase
      .from('organisations')
      .update({
        charity_review_requested: false,
        charity_review_completed_at: new Date().toISOString(),
        charity_review_notes: reason || 'Review denied by admin - not eligible for charity discount'
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    console.log(`🚫 Charity review denied for: ${data.name} (${id}) - ${reason || 'No reason'}`);

    res.json({
      success: true,
      message: 'Charity review denied',
      data,
    });
  } catch (error) {
    console.error('Error denying charity review:', error);
    res.status(500).json({ error: 'Failed to deny charity review' });
  }
});

/**
 * POST /api/customers/:id/set-discount
 * Set a non-charity discount for an organisation
 * Requires: discountPercent (10, 20, 30, 40, or 50), discountType, reason
 */
router.post('/:id/set-discount', async (req, res) => {
  try {
    const { id } = req.params;
    const { discountPercent, discountType, reason } = req.body;

    // Validate discount percentage (must be one of the predefined values)
    const validPercentages = [10, 20, 30, 40, 50];
    if (!validPercentages.includes(discountPercent)) {
      return res.status(400).json({
        error: `Invalid discount percentage. Must be one of: ${validPercentages.join(', ')}`
      });
    }

    // Validate discount type
    const validTypes = ['partner', 'promotional', 'negotiated', 'nonprofit', 'educational', 'community', 'other'];
    if (!validTypes.includes(discountType)) {
      return res.status(400).json({
        error: `Invalid discount type. Must be one of: ${validTypes.join(', ')}`
      });
    }

    const { data, error } = await supabase
      .from('organisations')
      .update({
        discount_percent: discountPercent,
        discount_type: discountType,
        discount_reason: reason || null,
        discount_approved_by: 'Admin Dashboard',
        discount_approved_at: new Date().toISOString(),
        discount_review_requested: false // Clear the review request when discount is approved
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    console.log(`💰 ${discountPercent}% ${discountType} discount set for: ${data.name} (${id}) - ${reason || 'No reason'}`);

    res.json({
      success: true,
      message: `${discountPercent}% ${discountType} discount applied successfully`,
      data,
    });
  } catch (error) {
    console.error('Error setting discount:', error);
    res.status(500).json({ error: 'Failed to set discount' });
  }
});

/**
 * POST /api/customers/:id/remove-discount
 * Remove a non-charity discount from an organisation
 */
router.post('/:id/remove-discount', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { data, error } = await supabase
      .from('organisations')
      .update({
        discount_percent: 0,
        discount_type: null,
        discount_reason: reason ? `Removed: ${reason}` : 'Discount removed by admin',
        discount_approved_by: null,
        discount_approved_at: null,
        discount_review_requested: false
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    console.log(`❌ Discount removed from: ${data.name} (${id}) - ${reason || 'No reason'}`);

    res.json({
      success: true,
      message: 'Discount removed successfully',
      data,
    });
  } catch (error) {
    console.error('Error removing discount:', error);
    res.status(500).json({ error: 'Failed to remove discount' });
  }
});

/**
 * POST /api/customers/:id/deny-discount-request
 * Deny a pending discount request
 */
router.post('/:id/deny-discount-request', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { data, error } = await supabase
      .from('organisations')
      .update({
        discount_review_requested: false,
        discount_review_reason: reason ? `Denied: ${reason}` : 'Discount request denied'
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    console.log(`🚫 Discount request denied for: ${data.name} (${id}) - ${reason || 'No reason'}`);

    res.json({
      success: true,
      message: 'Discount request denied',
      data,
    });
  } catch (error) {
    console.error('Error denying discount request:', error);
    res.status(500).json({ error: 'Failed to deny discount request' });
  }
});

/**
 * POST /api/customers/:id/revoke-charity-discount
 * Revoke charity discount from a customer
 */
router.post('/:id/revoke-charity-discount', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { data, error } = await supabase
      .from('organisations')
      .update({
        charity_verified: false,
        charity_discount_percent: 0,
        charity_review_notes: reason || 'Discount revoked by admin'
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    console.log(`❌ Charity discount revoked from: ${data.name} (${id}) - ${reason || 'No reason'}`);

    res.json({
      success: true,
      message: 'Charity discount revoked',
      data,
    });
  } catch (error) {
    console.error('Error revoking charity discount:', error);
    res.status(500).json({ error: 'Failed to revoke charity discount' });
  }
});

export default router;
