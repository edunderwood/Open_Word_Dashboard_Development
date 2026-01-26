/**
 * Price Migration Routes
 *
 * API endpoints for managing bulk price migrations
 */

import express from 'express';
import {
    createMigration,
    getCustomersToMigrate,
    sendMigrationEmails,
    executeMigration,
    cancelMigration,
    getMigrationDetails,
    listMigrations
} from '../services/price-migration.js';
import stripe from '../services/stripe.js';
import supabase from '../services/supabase.js';

const router = express.Router();

/**
 * GET /api/price-migration
 * List all migrations
 */
router.get('/', async (req, res) => {
    try {
        const result = await listMigrations();

        if (!result.success) {
            return res.status(500).json({ success: false, error: result.error });
        }

        res.json({ success: true, migrations: result.migrations });
    } catch (error) {
        console.error('Error listing migrations:', error);
        res.status(500).json({ success: false, error: 'Failed to list migrations' });
    }
});

/**
 * GET /api/price-migration/preview
 * Preview affected customers without creating a migration
 */
router.get('/preview', async (req, res) => {
    try {
        // Create a temporary migration object to use with getCustomersToMigrate
        // This shows what customers would be affected
        const result = await getCustomersToMigrate(null);

        if (!result.success) {
            // If migration is null, we need to query customers directly
            const { data: orgs, error } = await stripe.subscriptions.list({ limit: 100 });

            return res.json({
                success: true,
                message: 'Create a migration first to see detailed preview',
                estimatedCustomers: orgs?.data?.length || 0
            });
        }

        res.json({
            success: true,
            customers: result.customers,
            total: result.customers.length,
            validForMigration: result.customers.filter(c => c.hasValidNewPrice).length
        });
    } catch (error) {
        console.error('Error previewing migration:', error);
        res.status(500).json({ success: false, error: 'Failed to preview migration' });
    }
});

/**
 * GET /api/price-migration/stripe-prices
 * Get current Stripe prices for each tier/currency
 */
router.get('/stripe-prices', async (req, res) => {
    try {
        // Fetch all active recurring prices
        const prices = await stripe.prices.list({
            active: true,
            type: 'recurring',
            limit: 100
        });

        // Get product details
        const products = await stripe.products.list({
            active: true,
            limit: 50
        });

        const productMap = {};
        for (const product of products.data) {
            productMap[product.id] = product;
        }

        // Organize prices by product and currency
        const pricesByTier = {
            basic: {},
            standard: {},
            pro: {}
        };

        for (const price of prices.data) {
            const product = productMap[price.product];
            if (!product) continue;

            const productName = product.name.toLowerCase();
            const currency = price.currency.toLowerCase();

            let tier = null;
            if (productName.includes('basic')) tier = 'basic';
            else if (productName.includes('standard')) tier = 'standard';
            else if (productName.includes('pro')) tier = 'pro';

            if (tier) {
                pricesByTier[tier][currency] = {
                    priceId: price.id,
                    amount: price.unit_amount,
                    interval: price.recurring?.interval || 'month',
                    productId: product.id,
                    productName: product.name
                };
            }
        }

        res.json({
            success: true,
            prices: pricesByTier
        });
    } catch (error) {
        console.error('Error fetching Stripe prices:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch Stripe prices' });
    }
});

/**
 * GET /api/price-migration/customers-list
 * Get all available organisations for migration selection
 * Includes active and trial customers
 */
router.get('/customers-list', async (req, res) => {
    try {
        const { data: orgs, error } = await supabase
            .from('organisations')
            .select(`
                id, name, subscription_tier, subscription_status, preferred_currency,
                discount_percent, discount_type,
                charity_discount_percent, charity_verified, is_charity,
                stripe_subscription_id
            `)
            .in('subscription_tier', ['basic', 'standard', 'pro'])
            .in('subscription_status', ['active', 'trialing'])
            .not('stripe_subscription_id', 'is', null)
            .order('name');

        if (error) throw error;

        // Format response with discount info
        const customers = (orgs || []).map(org => {
            const effectiveDiscount = org.charity_verified
                ? (org.charity_discount_percent || 50)
                : (org.discount_percent || 0);

            return {
                id: org.id,
                name: org.name,
                tier: org.subscription_tier,
                status: org.subscription_status,
                currency: org.preferred_currency || 'gbp',
                discountPercent: effectiveDiscount,
                discountType: org.charity_verified ? 'charity' : (org.discount_type || null),
                isCharity: org.charity_verified || org.is_charity,
                hasSubscription: !!org.stripe_subscription_id
            };
        });

        res.json({
            success: true,
            customers,
            total: customers.length
        });
    } catch (error) {
        console.error('Error fetching customers list:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch customers' });
    }
});

/**
 * GET /api/price-migration/:id
 * Get migration details with customer status
 */
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await getMigrationDetails(id);

        if (!result.success) {
            return res.status(404).json({ success: false, error: result.error });
        }

        res.json({
            success: true,
            migration: result.migration,
            customers: result.customers
        });
    } catch (error) {
        console.error('Error getting migration details:', error);
        res.status(500).json({ success: false, error: 'Failed to get migration details' });
    }
});

/**
 * POST /api/price-migration
 * Create a new price migration
 */
router.post('/', async (req, res) => {
    try {
        const {
            name,
            oldPricing,
            newPricing,
            newPriceIds,
            selectedOrganisationIds  // Optional array of org IDs to include
        } = req.body;

        if (!name) {
            return res.status(400).json({ success: false, error: 'Migration name is required' });
        }

        const adminEmail = req.session.user?.email || 'admin';
        const result = await createMigration({
            name,
            oldPricing,
            newPricing,
            newPriceIds,
            selectedOrganisationIds
        }, adminEmail);

        if (!result.success) {
            return res.status(400).json({ success: false, error: result.error });
        }

        res.json({
            success: true,
            message: 'Migration created successfully',
            migration: result.migration
        });
    } catch (error) {
        console.error('Error creating migration:', error);
        res.status(500).json({ success: false, error: 'Failed to create migration' });
    }
});

/**
 * POST /api/price-migration/:id/send-emails
 * Send warning emails to all affected customers
 */
router.post('/:id/send-emails', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await sendMigrationEmails(id);

        if (!result.success) {
            return res.status(400).json({ success: false, error: result.error });
        }

        res.json({
            success: true,
            message: `Emails sent: ${result.sent} successful, ${result.failed} failed`,
            sent: result.sent,
            failed: result.failed,
            errors: result.errors
        });
    } catch (error) {
        console.error('Error sending migration emails:', error);
        res.status(500).json({ success: false, error: 'Failed to send emails' });
    }
});

/**
 * POST /api/price-migration/:id/execute
 * Execute the migration (update Stripe subscriptions)
 * Can be triggered manually or by the scheduler
 */
router.post('/:id/execute', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await executeMigration(id);

        if (!result.success) {
            return res.status(400).json({ success: false, error: result.error });
        }

        res.json({
            success: true,
            message: `Migration completed: ${result.completed} successful, ${result.failed} failed`,
            completed: result.completed,
            failed: result.failed,
            errors: result.errors
        });
    } catch (error) {
        console.error('Error executing migration:', error);
        res.status(500).json({ success: false, error: 'Failed to execute migration' });
    }
});

/**
 * POST /api/price-migration/:id/cancel
 * Cancel a pending migration
 */
router.post('/:id/cancel', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await cancelMigration(id);

        if (!result.success) {
            return res.status(400).json({ success: false, error: result.error });
        }

        res.json({
            success: true,
            message: 'Migration cancelled successfully'
        });
    } catch (error) {
        console.error('Error cancelling migration:', error);
        res.status(500).json({ success: false, error: 'Failed to cancel migration' });
    }
});

/**
 * GET /api/price-migration/:id/customers
 * Get detailed customer list for a migration
 */
router.get('/:id/customers', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await getCustomersToMigrate(id);

        if (!result.success) {
            return res.status(400).json({ success: false, error: result.error });
        }

        res.json({
            success: true,
            customers: result.customers,
            total: result.customers.length
        });
    } catch (error) {
        console.error('Error getting migration customers:', error);
        res.status(500).json({ success: false, error: 'Failed to get customers' });
    }
});

export default router;
