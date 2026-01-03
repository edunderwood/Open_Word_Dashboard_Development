/**
 * Pricing Tiers Management Routes
 * Manages the pricing_tiers table used by the main OpenWord system
 * Fetches pricing from Stripe as the source of truth
 */

import express from 'express';
import supabase from '../services/supabase.js';
import stripe from '../services/stripe.js';

const router = express.Router();

/**
 * GET /api/pricing
 * Get all pricing tiers from pricing_tiers table
 */
router.get('/', async (req, res) => {
  try {
    const { data: tiers, error } = await supabase
      .from('pricing_tiers')
      .select('*')
      .order('display_order', { ascending: true });

    if (error) throw error;

    res.json({
      success: true,
      data: tiers || [],
    });
  } catch (error) {
    console.error('Error fetching pricing tiers:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch pricing tiers' });
  }
});

/**
 * GET /api/pricing/stripe
 * Get pricing from Stripe products/prices (source of truth)
 * Returns plans (subscriptions) and credits (one-time) separately
 * Multi-currency support: Returns prices for GBP, USD, EUR
 * NOTE: This route must be defined BEFORE /:id to avoid being matched as an ID
 */
router.get('/stripe', async (req, res) => {
  try {
    // Fetch all active products from Stripe
    const products = await stripe.products.list({
      active: true,
      limit: 50
    });

    // Fetch all active recurring prices (for plans/subscriptions)
    const recurringPrices = await stripe.prices.list({
      active: true,
      type: 'recurring',
      limit: 100
    });

    // Fetch all active one-time prices (for credits)
    const oneTimePrices = await stripe.prices.list({
      active: true,
      type: 'one_time',
      limit: 100
    });

    // Build maps of product ID to prices by currency
    // Structure: { productId: { gbp: price, usd: price, eur: price } }
    const recurringPriceMap = {};
    for (const price of recurringPrices.data) {
      const currency = price.currency.toLowerCase();
      if (!recurringPriceMap[price.product]) {
        recurringPriceMap[price.product] = {};
      }
      // Keep the most recent price for each currency
      if (!recurringPriceMap[price.product][currency] ||
          price.created > recurringPriceMap[price.product][currency].created) {
        recurringPriceMap[price.product][currency] = price;
      }
    }

    const oneTimePriceMap = {};
    for (const price of oneTimePrices.data) {
      const currency = price.currency.toLowerCase();
      if (!oneTimePriceMap[price.product]) {
        oneTimePriceMap[price.product] = {};
      }
      // Keep the most recent price for each currency
      if (!oneTimePriceMap[price.product][currency] ||
          price.created > oneTimePriceMap[price.product][currency].created) {
        oneTimePriceMap[price.product][currency] = price;
      }
    }

    // Separate products into plans and credits
    const plans = [];
    const credits = [];

    for (const product of products.data) {
      const recurringPrices = recurringPriceMap[product.id] || {};
      const oneTimePrices = oneTimePriceMap[product.id] || {};

      // Check if it's a credit product (has one-time price or name contains "Credit")
      const hasOneTimePrice = Object.keys(oneTimePrices).length > 0;
      const isCredit = hasOneTimePrice || product.name.toLowerCase().includes('credit');

      if (isCredit && hasOneTimePrice) {
        // Extract credit quantity from name (e.g., "100 Open Word Credits" -> 100)
        const creditMatch = product.name.match(/(\d+)/);
        const creditQuantity = creditMatch ? parseInt(creditMatch[1], 10) : 0;

        // Build prices object for all currencies
        const prices = {};
        for (const [currency, price] of Object.entries(oneTimePrices)) {
          prices[currency] = {
            amount: price.unit_amount,
            priceId: price.id
          };
        }

        credits.push({
          stripeProductId: product.id,
          name: product.name,
          description: product.description || '',
          prices, // { gbp: { amount, priceId }, usd: { amount, priceId }, eur: { amount, priceId } }
          creditQuantity,
          metadata: product.metadata || {}
        });
      } else if (Object.keys(recurringPrices).length > 0) {
        // It's a subscription plan - build prices for all currencies
        const prices = {};
        let interval = 'month';
        for (const [currency, price] of Object.entries(recurringPrices)) {
          prices[currency] = {
            amount: price.unit_amount,
            priceId: price.id
          };
          interval = price.recurring?.interval || 'month';
        }

        plans.push({
          stripeProductId: product.id,
          name: product.name,
          description: product.description || '',
          prices, // { gbp: { amount, priceId }, usd: { amount, priceId }, eur: { amount, priceId } }
          interval,
          metadata: product.metadata || {}
        });
      }
    }

    // Sort plans by GBP price (ascending), fallback to USD then EUR
    plans.sort((a, b) => {
      const priceA = a.prices.gbp?.amount || a.prices.usd?.amount || a.prices.eur?.amount || 0;
      const priceB = b.prices.gbp?.amount || b.prices.usd?.amount || b.prices.eur?.amount || 0;
      return priceA - priceB;
    });

    // Sort credits by quantity (ascending: 1, 5, 10, 25, 50, 100)
    credits.sort((a, b) => a.creditQuantity - b.creditQuantity);

    res.json({
      success: true,
      data: {
        plans,
        credits
      }
    });
  } catch (error) {
    console.error('Error fetching Stripe pricing:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch Stripe pricing' });
  }
});

/**
 * GET /api/pricing/charity-discount
 * Get current charity discount percentage (global setting)
 * NOTE: This route must be defined BEFORE /:id to avoid being matched as an ID
 */
router.get('/charity-discount', async (req, res) => {
  try {
    // Get charity discount percentage from basic tier
    const { data: tier, error } = await supabase
      .from('pricing_tiers')
      .select('charity_discount_percent')
      .eq('id', 'basic')
      .single();

    if (error) throw error;

    const discountPercent = tier?.charity_discount_percent ?? 50;

    res.json({
      success: true,
      data: { discountPercent },
    });
  } catch (error) {
    console.error('Error fetching charity discount:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch charity discount' });
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
      return res.status(404).json({ success: false, error: 'Pricing tier not found' });
    }

    res.json({
      success: true,
      data: tier,
    });
  } catch (error) {
    console.error('Error fetching pricing tier:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch pricing tier' });
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
      monthlyFeePence,
      charsPerCredit,
      creditPricePence,
      charityDiscountPercent,
      maxConcurrentSessions,
      canCustomizeBranding,
      canReceiveFeedback,
      aiAudioEnabled,
      description,
      displayOrder,
      isActive,
    } = req.body;

    // Build update object with only provided fields
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (monthlyFeePence !== undefined) updateData.monthly_fee_pence = monthlyFeePence;
    if (charsPerCredit !== undefined) updateData.chars_per_credit = charsPerCredit;
    if (creditPricePence !== undefined) updateData.credit_price_pence = creditPricePence;
    if (charityDiscountPercent !== undefined) updateData.charity_discount_percent = charityDiscountPercent;
    if (maxConcurrentSessions !== undefined) updateData.max_concurrent_sessions = maxConcurrentSessions;
    if (canCustomizeBranding !== undefined) updateData.can_customize_branding = canCustomizeBranding;
    if (canReceiveFeedback !== undefined) updateData.can_receive_feedback = canReceiveFeedback;
    if (aiAudioEnabled !== undefined) updateData.ai_audio_enabled = aiAudioEnabled;
    if (description !== undefined) updateData.description = description;
    if (displayOrder !== undefined) updateData.display_order = displayOrder;
    if (isActive !== undefined) updateData.is_active = isActive;
    updateData.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('pricing_tiers')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Supabase error updating pricing tier:', error);
      throw error;
    }

    console.log(`💰 Pricing tier updated: ${data.name} (${id})`);

    res.json({
      success: true,
      message: 'Pricing tier updated successfully',
      data,
    });
  } catch (error) {
    console.error('Error updating pricing tier:', error);
    console.error('Update data was:', req.body);
    res.status(500).json({ success: false, error: 'Failed to update pricing tier' });
  }
});

/**
 * POST /api/pricing
 * Create new pricing tier
 */
router.post('/', async (req, res) => {
  try {
    const {
      id,
      name,
      monthlyFeePence,
      charsPerCredit,
      creditPricePence,
      charityDiscountPercent,
      maxConcurrentSessions,
      canCustomizeBranding,
      canReceiveFeedback,
      aiAudioEnabled,
      description,
      displayOrder,
    } = req.body;

    if (!id || !name) {
      return res.status(400).json({ success: false, error: 'Tier ID and name are required' });
    }

    const { data, error } = await supabase
      .from('pricing_tiers')
      .insert({
        id,
        name,
        monthly_fee_pence: monthlyFeePence || 0,
        chars_per_credit: charsPerCredit || 23000,
        credit_price_pence: creditPricePence || 118,
        charity_discount_percent: charityDiscountPercent || 50,
        max_concurrent_sessions: maxConcurrentSessions || 1,
        can_customize_branding: canCustomizeBranding || false,
        can_receive_feedback: canReceiveFeedback || false,
        ai_audio_enabled: aiAudioEnabled || false,
        description: description || '',
        display_order: displayOrder || 0,
        is_active: true,
      })
      .select()
      .single();

    if (error) throw error;

    console.log(`💰 New pricing tier created: ${name} (${id})`);

    res.json({
      success: true,
      message: 'Pricing tier created successfully',
      data,
    });
  } catch (error) {
    console.error('Error creating pricing tier:', error);
    res.status(500).json({ success: false, error: 'Failed to create pricing tier' });
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
      .eq('subscription_tier', id);

    if (customerCount > 0) {
      return res.status(400).json({
        success: false,
        error: `Cannot disable tier - ${customerCount} customer(s) are using it`,
      });
    }

    // Soft delete by setting inactive
    const { error } = await supabase
      .from('pricing_tiers')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) throw error;

    console.log(`💰 Pricing tier disabled: ${id}`);

    res.json({
      success: true,
      message: 'Pricing tier disabled successfully',
    });
  } catch (error) {
    console.error('Error disabling pricing tier:', error);
    res.status(500).json({ success: false, error: 'Failed to disable pricing tier' });
  }
});

export default router;
