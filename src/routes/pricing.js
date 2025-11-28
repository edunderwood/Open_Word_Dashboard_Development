/**
 * Pricing Management Routes
 * Uses existing subscription_pricing table from main OpenWord system
 */

import express from 'express';
import supabase from '../services/supabase.js';
import stripe from '../services/stripe.js';

const router = express.Router();

/**
 * GET /api/pricing
 * Get all pricing tiers from subscription_pricing table
 */
router.get('/', async (req, res) => {
  try {
    const { data: tiers, error } = await supabase
      .from('subscription_pricing')
      .select('*')
      .order('monthly_fee', { ascending: true });

    if (error) throw error;

    res.json({
      success: true,
      data: tiers || [],
    });
  } catch (error) {
    console.error('Error fetching pricing tiers:', error);
    res.status(500).json({ error: 'Failed to fetch pricing tiers' });
  }
});

/**
 * GET /api/pricing/:id
 * Get single pricing tier
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: tier, error } = await supabase
      .from('subscription_pricing')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;

    if (!tier) {
      return res.status(404).json({ error: 'Pricing tier not found' });
    }

    res.json({
      success: true,
      data: tier,
    });
  } catch (error) {
    console.error('Error fetching pricing tier:', error);
    res.status(500).json({ error: 'Failed to fetch pricing tier' });
  }
});

/**
 * PUT /api/pricing/:id
 * Update pricing tier
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      displayName,
      monthlyFee,
      usageRate,
      minimumMonthlyFee,
      features,
      isActive,
      stripeMonthlyPriceId,
      stripeUsagePriceId,
    } = req.body;

    // Build update object with only provided fields
    const updateData = {};
    if (displayName !== undefined) updateData.display_name = displayName;
    if (monthlyFee !== undefined) updateData.monthly_fee = monthlyFee;
    if (usageRate !== undefined) updateData.usage_rate = usageRate;
    if (minimumMonthlyFee !== undefined) updateData.minimum_monthly_fee = minimumMonthlyFee;
    if (features !== undefined) updateData.features = features;
    if (isActive !== undefined) updateData.is_active = isActive;
    if (stripeMonthlyPriceId !== undefined) updateData.stripe_monthly_price_id = stripeMonthlyPriceId;
    if (stripeUsagePriceId !== undefined) updateData.stripe_usage_price_id = stripeUsagePriceId;
    updateData.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('subscription_pricing')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    console.log(`💰 Pricing tier updated: ${data.display_name} (${id})`);

    res.json({
      success: true,
      message: 'Pricing tier updated successfully',
      data,
    });
  } catch (error) {
    console.error('Error updating pricing tier:', error);
    res.status(500).json({ error: 'Failed to update pricing tier' });
  }
});

/**
 * POST /api/pricing
 * Create new pricing tier
 */
router.post('/', async (req, res) => {
  try {
    const {
      planName,
      displayName,
      monthlyFee,
      usageRate,
      minimumMonthlyFee,
      features,
      stripeMonthlyPriceId,
      stripeUsagePriceId,
    } = req.body;

    if (!planName || !displayName) {
      return res.status(400).json({ error: 'Plan name and display name are required' });
    }

    const { data, error } = await supabase
      .from('subscription_pricing')
      .insert({
        plan_name: planName,
        display_name: displayName,
        monthly_fee: monthlyFee || 0,
        usage_rate: usageRate || 0.000048,
        minimum_monthly_fee: minimumMonthlyFee || 0,
        features: features || [],
        stripe_monthly_price_id: stripeMonthlyPriceId,
        stripe_usage_price_id: stripeUsagePriceId,
        is_active: true,
      })
      .select()
      .single();

    if (error) throw error;

    console.log(`💰 New pricing tier created: ${displayName}`);

    res.json({
      success: true,
      message: 'Pricing tier created successfully',
      data,
    });
  } catch (error) {
    console.error('Error creating pricing tier:', error);
    res.status(500).json({ error: 'Failed to create pricing tier' });
  }
});

/**
 * DELETE /api/pricing/:id
 * Delete pricing tier (soft delete by setting inactive)
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if any customers are using this tier
    const { data: tier } = await supabase
      .from('subscription_pricing')
      .select('plan_name')
      .eq('id', id)
      .single();

    if (tier) {
      const { count: customerCount } = await supabase
        .from('organisations')
        .select('*', { count: 'exact', head: true })
        .eq('subscription_plan', tier.plan_name);

      if (customerCount > 0) {
        return res.status(400).json({
          error: `Cannot delete tier - ${customerCount} customer(s) are using it`,
        });
      }
    }

    // Soft delete by setting inactive
    const { error } = await supabase
      .from('subscription_pricing')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) throw error;

    console.log(`💰 Pricing tier disabled: ${id}`);

    res.json({
      success: true,
      message: 'Pricing tier disabled successfully',
    });
  } catch (error) {
    console.error('Error deleting pricing tier:', error);
    res.status(500).json({ error: 'Failed to delete pricing tier' });
  }
});

/**
 * GET /api/pricing/stripe/products
 * Get Stripe products and prices for reference
 */
router.get('/stripe/products', async (req, res) => {
  try {
    const products = await stripe.products.list({ active: true, limit: 100 });
    const prices = await stripe.prices.list({ active: true, limit: 100 });

    // Map prices to products
    const productsWithPrices = products.data.map(product => {
      const productPrices = prices.data.filter(p => p.product === product.id);
      return {
        id: product.id,
        name: product.name,
        description: product.description,
        prices: productPrices.map(p => ({
          id: p.id,
          unitAmount: p.unit_amount ? p.unit_amount / 100 : 0,
          currency: p.currency,
          interval: p.recurring?.interval,
          usageType: p.recurring?.usage_type,
        })),
      };
    });

    res.json({
      success: true,
      data: productsWithPrices,
    });
  } catch (error) {
    console.error('Error fetching Stripe products:', error);
    res.status(500).json({ error: 'Failed to fetch Stripe products' });
  }
});

/**
 * POST /api/pricing/:id/sync-stripe
 * Link pricing tier with Stripe price IDs
 */
router.post('/:id/sync-stripe', async (req, res) => {
  try {
    const { id } = req.params;
    const { stripeMonthlyPriceId, stripeUsagePriceId } = req.body;

    const updateData = {
      updated_at: new Date().toISOString(),
    };

    if (stripeMonthlyPriceId) {
      updateData.stripe_monthly_price_id = stripeMonthlyPriceId;
    }
    if (stripeUsagePriceId) {
      updateData.stripe_usage_price_id = stripeUsagePriceId;
    }

    const { data, error } = await supabase
      .from('subscription_pricing')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    console.log(`💰 Pricing tier synced with Stripe: ${data.display_name}`);

    res.json({
      success: true,
      message: 'Pricing tier synced with Stripe',
      data,
    });
  } catch (error) {
    console.error('Error syncing with Stripe:', error);
    res.status(500).json({ error: 'Failed to sync with Stripe' });
  }
});

export default router;
