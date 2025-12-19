/**
 * Pricing Tiers Management Routes
 * Manages the pricing_tiers table used by the main OpenWord system
 */

import express from 'express';
import supabase from '../services/supabase.js';

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
