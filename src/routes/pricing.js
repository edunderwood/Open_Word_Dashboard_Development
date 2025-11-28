/**
 * Pricing Management Routes
 */

import express from 'express';
import supabase from '../services/supabase.js';
import stripe from '../services/stripe.js';

const router = express.Router();

/**
 * GET /api/pricing
 * Get all pricing tiers
 */
router.get('/', async (req, res) => {
  try {
    const { data: tiers, error } = await supabase
      .from('pricing_tiers')
      .select('*')
      .order('sort_order', { ascending: true });

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
      .from('pricing_tiers')
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
      name,
      description,
      monthlyPrice,
      yearlyPrice,
      includedCharacters,
      overageRate,
      features,
      isActive,
    } = req.body;

    // Build update object with only provided fields
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (monthlyPrice !== undefined) updateData.monthly_price = monthlyPrice;
    if (yearlyPrice !== undefined) updateData.yearly_price = yearlyPrice;
    if (includedCharacters !== undefined) updateData.included_characters = includedCharacters;
    if (overageRate !== undefined) updateData.overage_rate = overageRate;
    if (features !== undefined) updateData.features = features;
    if (isActive !== undefined) updateData.is_active = isActive;
    updateData.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('pricing_tiers')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    console.log(`💰 Pricing tier updated: ${data.name} (${id})`);

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
      name,
      slug,
      description,
      monthlyPrice,
      yearlyPrice,
      includedCharacters,
      overageRate,
      features,
      sortOrder,
    } = req.body;

    if (!name || !slug) {
      return res.status(400).json({ error: 'Name and slug are required' });
    }

    const { data, error } = await supabase
      .from('pricing_tiers')
      .insert({
        name,
        slug,
        description,
        monthly_price: monthlyPrice || 0,
        yearly_price: yearlyPrice || 0,
        included_characters: includedCharacters || 0,
        overage_rate: overageRate || 0,
        features: features || [],
        sort_order: sortOrder || 999,
        is_active: true,
      })
      .select()
      .single();

    if (error) throw error;

    console.log(`💰 New pricing tier created: ${name}`);

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
    const { count: customerCount } = await supabase
      .from('organisations')
      .select('*', { count: 'exact', head: true })
      .eq('pricing_tier_id', id);

    if (customerCount > 0) {
      return res.status(400).json({
        error: `Cannot delete tier - ${customerCount} customer(s) are using it`,
      });
    }

    // Soft delete by setting inactive
    const { error } = await supabase
      .from('pricing_tiers')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) throw error;

    console.log(`💰 Pricing tier deleted: ${id}`);

    res.json({
      success: true,
      message: 'Pricing tier deleted successfully',
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
          unitAmount: p.unit_amount / 100,
          currency: p.currency,
          interval: p.recurring?.interval,
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
 * Sync pricing tier with Stripe product
 */
router.post('/:id/sync-stripe', async (req, res) => {
  try {
    const { id } = req.params;
    const { stripeProductId } = req.body;

    if (!stripeProductId) {
      return res.status(400).json({ error: 'Stripe product ID required' });
    }

    // Get Stripe product details
    const product = await stripe.products.retrieve(stripeProductId);
    const prices = await stripe.prices.list({
      product: stripeProductId,
      active: true,
    });

    // Find monthly and yearly prices
    let monthlyPrice = 0;
    let yearlyPrice = 0;

    prices.data.forEach(price => {
      if (price.recurring?.interval === 'month') {
        monthlyPrice = price.unit_amount / 100;
      } else if (price.recurring?.interval === 'year') {
        yearlyPrice = price.unit_amount / 100;
      }
    });

    // Update local tier
    const { data, error } = await supabase
      .from('pricing_tiers')
      .update({
        stripe_product_id: stripeProductId,
        monthly_price: monthlyPrice,
        yearly_price: yearlyPrice,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    console.log(`💰 Pricing tier synced with Stripe: ${data.name}`);

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
