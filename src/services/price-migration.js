/**
 * Price Migration Service
 *
 * Handles bulk price migrations:
 * 1. Creating migration records
 * 2. Sending warning emails to customers
 * 3. Executing Stripe subscription updates
 */

import supabase from './supabase.js';
import stripe from './stripe.js';
import { sendCustomerEmail } from './email.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Format price in pence/cents for display
 * @param {number} amountInPence - Amount in pence/cents
 * @param {string} currency - Currency code (gbp, usd, eur)
 * @returns {string} Formatted price string
 */
function formatPrice(amountInPence, currency = 'gbp') {
    const symbols = { gbp: '£', usd: '$', eur: '€' };
    const symbol = symbols[currency.toLowerCase()] || '£';
    const amount = (amountInPence / 100).toFixed(2);
    return `${symbol}${amount}`;
}

/**
 * Get the new price ID for a customer based on their tier and currency
 * @param {object} migration - Migration record
 * @param {string} tier - Customer's tier (basic, standard, pro)
 * @param {string} currency - Customer's currency (gbp, usd, eur)
 * @returns {string|null} New Stripe Price ID or null if not found
 */
function getNewPriceId(migration, tier, currency) {
    const key = `new_price_id_${tier}_${currency}`;
    return migration[key] || null;
}

/**
 * Create a new price migration campaign
 * @param {object} config - Migration configuration
 * @param {string} config.name - Migration name
 * @param {object} config.oldPricing - Old pricing { basic_gbp, standard_gbp, pro_gbp, credit_gbp }
 * @param {object} config.newPricing - New pricing { basic_gbp, standard_gbp, pro_gbp, credit_gbp }
 * @param {object} config.newPriceIds - New Stripe Price IDs for each tier/currency
 * @param {string} adminEmail - Admin who created the migration
 * @returns {Promise<{success: boolean, migration?: object, error?: string}>}
 */
export async function createMigration(config, adminEmail) {
    try {
        const { name, oldPricing, newPricing, newPriceIds } = config;

        // Validate required fields
        if (!name) {
            return { success: false, error: 'Migration name is required' };
        }

        // Count customers who will be affected (active subscriptions)
        const { count: totalCustomers, error: countError } = await supabase
            .from('organisations')
            .select('*', { count: 'exact', head: true })
            .in('subscription_tier', ['basic', 'standard', 'pro'])
            .eq('subscription_status', 'active')
            .not('stripe_subscription_id', 'is', null);

        if (countError) throw countError;

        // Create migration record
        const { data: migration, error: insertError } = await supabase
            .from('price_migrations')
            .insert({
                name,
                status: 'pending',
                old_basic_gbp: oldPricing?.basic_gbp,
                old_standard_gbp: oldPricing?.standard_gbp,
                old_pro_gbp: oldPricing?.pro_gbp,
                old_credit_gbp: oldPricing?.credit_gbp,
                new_basic_gbp: newPricing?.basic_gbp,
                new_standard_gbp: newPricing?.standard_gbp,
                new_pro_gbp: newPricing?.pro_gbp,
                new_credit_gbp: newPricing?.credit_gbp,
                new_price_id_basic_gbp: newPriceIds?.basic_gbp,
                new_price_id_basic_usd: newPriceIds?.basic_usd,
                new_price_id_basic_eur: newPriceIds?.basic_eur,
                new_price_id_standard_gbp: newPriceIds?.standard_gbp,
                new_price_id_standard_usd: newPriceIds?.standard_usd,
                new_price_id_standard_eur: newPriceIds?.standard_eur,
                new_price_id_pro_gbp: newPriceIds?.pro_gbp,
                new_price_id_pro_usd: newPriceIds?.pro_usd,
                new_price_id_pro_eur: newPriceIds?.pro_eur,
                total_customers: totalCustomers || 0,
                created_by: adminEmail
            })
            .select()
            .single();

        if (insertError) throw insertError;

        console.log(`📋 Price migration created: ${name} (${migration.id})`);
        console.log(`   Affects ${totalCustomers} customers`);

        return { success: true, migration };
    } catch (error) {
        console.error('Error creating price migration:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Get customers to migrate (active subscriptions with valid tiers)
 * @param {string} migrationId - Migration ID
 * @returns {Promise<{success: boolean, customers?: Array, error?: string}>}
 */
export async function getCustomersToMigrate(migrationId) {
    try {
        // Get migration record
        const { data: migration, error: migrationError } = await supabase
            .from('price_migrations')
            .select('*')
            .eq('id', migrationId)
            .single();

        if (migrationError) throw migrationError;
        if (!migration) {
            return { success: false, error: 'Migration not found' };
        }

        // Get all organisations with active subscriptions
        const { data: orgs, error: orgsError } = await supabase
            .from('organisations')
            .select('id, name, user_id, subscription_tier, stripe_customer_id, stripe_subscription_id')
            .in('subscription_tier', ['basic', 'standard', 'pro'])
            .eq('subscription_status', 'active')
            .not('stripe_subscription_id', 'is', null);

        if (orgsError) throw orgsError;

        // Enrich with Stripe subscription details and email
        const customers = [];
        for (const org of orgs || []) {
            try {
                // Get email from auth user
                let email = null;
                if (org.user_id) {
                    const { data: authUser } = await supabase.auth.admin.getUserById(org.user_id);
                    email = authUser?.user?.email || null;
                }

                // Get subscription details from Stripe
                let currency = 'gbp';
                let currentPriceId = null;
                let subscriptionItemId = null;

                if (org.stripe_subscription_id) {
                    try {
                        const subscription = await stripe.subscriptions.retrieve(org.stripe_subscription_id);
                        if (subscription.items?.data?.[0]) {
                            const item = subscription.items.data[0];
                            currentPriceId = item.price?.id;
                            subscriptionItemId = item.id;
                            currency = item.price?.currency || 'gbp';
                        }
                    } catch (stripeError) {
                        console.error(`Failed to get subscription for ${org.name}:`, stripeError.message);
                    }
                }

                // Get the new price ID for this customer
                const newPriceId = getNewPriceId(migration, org.subscription_tier, currency);

                customers.push({
                    organisationId: org.id,
                    name: org.name,
                    email,
                    tier: org.subscription_tier,
                    currency,
                    stripeCustomerId: org.stripe_customer_id,
                    stripeSubscriptionId: org.stripe_subscription_id,
                    subscriptionItemId,
                    currentPriceId,
                    newPriceId,
                    hasValidNewPrice: !!newPriceId
                });
            } catch (error) {
                console.error(`Error processing customer ${org.name}:`, error.message);
            }
        }

        return { success: true, customers };
    } catch (error) {
        console.error('Error getting customers to migrate:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Generate email body HTML for price change notification
 * @param {object} params - Email parameters
 * @returns {string} HTML email body
 */
function generatePriceChangeEmailBody(params) {
    const {
        orgName,
        tierName,
        effectiveDate,
        currentPrice,
        newPrice,
        currentCredit,
        newCredit,
        currency
    } = params;

    const tierDisplay = {
        basic: 'Basic',
        standard: 'Standard',
        pro: 'Professional'
    };

    return `
        <p>Dear ${orgName},</p>

        <p>We're writing to let you know about upcoming changes to Open Word pricing,
        effective from <strong>${effectiveDate}</strong>.</p>

        <h3 style="color: #2563eb; margin-top: 25px;">Your Current Plan: ${tierDisplay[tierName] || tierName}</h3>

        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <tr style="background: #f3f4f6;">
                <th style="padding: 12px; text-align: left; border: 1px solid #e5e7eb;"></th>
                <th style="padding: 12px; text-align: center; border: 1px solid #e5e7eb;">Current</th>
                <th style="padding: 12px; text-align: center; border: 1px solid #e5e7eb;">New (from ${effectiveDate})</th>
            </tr>
            <tr>
                <td style="padding: 12px; border: 1px solid #e5e7eb;"><strong>Monthly Subscription</strong></td>
                <td style="padding: 12px; text-align: center; border: 1px solid #e5e7eb;">${currentPrice}/month</td>
                <td style="padding: 12px; text-align: center; border: 1px solid #e5e7eb;">${newPrice}/month</td>
            </tr>
            <tr style="background: #f9fafb;">
                <td style="padding: 12px; border: 1px solid #e5e7eb;"><strong>Credit Price</strong></td>
                <td style="padding: 12px; text-align: center; border: 1px solid #e5e7eb;">${currentCredit}/credit</td>
                <td style="padding: 12px; text-align: center; border: 1px solid #e5e7eb;">${newCredit}/credit</td>
            </tr>
            <tr>
                <td style="padding: 12px; border: 1px solid #e5e7eb;"><strong>~30 mins streaming</strong></td>
                <td style="padding: 12px; text-align: center; border: 1px solid #e5e7eb;">${currentCredit} (1 credit)</td>
                <td style="padding: 12px; text-align: center; border: 1px solid #e5e7eb;">${newCredit} (1 credit)</td>
            </tr>
        </table>

        <p style="margin-top: 20px;">The new pricing will apply to your next billing cycle after <strong>${effectiveDate}</strong>.</p>

        <p style="margin-top: 20px;">If you have any questions about these changes, please don't hesitate to contact us.</p>

        <p style="margin-top: 30px;">Thank you for being an Open Word customer.</p>
    `;
}

/**
 * Send warning emails to all customers in a migration
 * @param {string} migrationId - Migration ID
 * @returns {Promise<{success: boolean, sent: number, failed: number, errors?: Array}>}
 */
export async function sendMigrationEmails(migrationId) {
    try {
        // Get migration record
        const { data: migration, error: migrationError } = await supabase
            .from('price_migrations')
            .select('*')
            .eq('id', migrationId)
            .single();

        if (migrationError) throw migrationError;
        if (!migration) {
            return { success: false, error: 'Migration not found' };
        }

        if (migration.status !== 'pending') {
            return { success: false, error: `Migration is already ${migration.status}` };
        }

        // Get customers
        const { success: customersSuccess, customers, error: customersError } = await getCustomersToMigrate(migrationId);
        if (!customersSuccess) {
            return { success: false, error: customersError };
        }

        // Calculate effective date (7 days from now)
        const effectiveDate = new Date();
        effectiveDate.setDate(effectiveDate.getDate() + 7);
        const effectiveDateStr = effectiveDate.toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        });

        let sent = 0;
        let failed = 0;
        const errors = [];

        // Create customer records and send emails
        for (const customer of customers) {
            try {
                // Determine current and new pricing for this customer's tier
                const tierPricing = {
                    basic: { old: migration.old_basic_gbp, new: migration.new_basic_gbp },
                    standard: { old: migration.old_standard_gbp, new: migration.new_standard_gbp },
                    pro: { old: migration.old_pro_gbp, new: migration.new_pro_gbp }
                };

                const pricing = tierPricing[customer.tier] || tierPricing.basic;
                const currency = customer.currency || 'gbp';

                // Insert customer record
                const { error: insertError } = await supabase
                    .from('price_migration_customers')
                    .insert({
                        migration_id: migrationId,
                        organisation_id: customer.organisationId,
                        current_tier: customer.tier,
                        current_currency: currency,
                        current_price_id: customer.currentPriceId,
                        stripe_subscription_id: customer.stripeSubscriptionId,
                        stripe_subscription_item_id: customer.subscriptionItemId,
                        new_price_id: customer.newPriceId
                    });

                if (insertError && !insertError.message.includes('duplicate')) {
                    throw insertError;
                }

                // Skip email if no email address
                if (!customer.email) {
                    await supabase
                        .from('price_migration_customers')
                        .update({ email_status: 'skipped', error_message: 'No email address' })
                        .eq('migration_id', migrationId)
                        .eq('organisation_id', customer.organisationId);
                    continue;
                }

                // Generate email
                const emailBody = generatePriceChangeEmailBody({
                    orgName: customer.name,
                    tierName: customer.tier,
                    effectiveDate: effectiveDateStr,
                    currentPrice: formatPrice(pricing.old, currency),
                    newPrice: formatPrice(pricing.new, currency),
                    currentCredit: formatPrice(migration.old_credit_gbp, currency),
                    newCredit: formatPrice(migration.new_credit_gbp, currency),
                    currency
                });

                // Send email
                const emailResult = await sendCustomerEmail(
                    customer.email,
                    `Important: Open Word Pricing Update - Effective ${effectiveDateStr}`,
                    emailBody,
                    customer.name
                );

                // Update customer record
                await supabase
                    .from('price_migration_customers')
                    .update({
                        email_sent_at: new Date().toISOString(),
                        email_status: emailResult.success ? 'sent' : 'failed',
                        error_message: emailResult.error || null
                    })
                    .eq('migration_id', migrationId)
                    .eq('organisation_id', customer.organisationId);

                if (emailResult.success) {
                    sent++;
                } else {
                    failed++;
                    errors.push({ customer: customer.name, error: emailResult.error });
                }

                // Rate limiting - 100ms between emails
                await new Promise(resolve => setTimeout(resolve, 100));

            } catch (error) {
                failed++;
                errors.push({ customer: customer.name, error: error.message });
                console.error(`Error processing customer ${customer.name}:`, error.message);
            }
        }

        // Update migration status
        await supabase
            .from('price_migrations')
            .update({
                status: 'emails_sent',
                emails_sent_at: new Date().toISOString(),
                migration_scheduled_for: effectiveDate.toISOString(),
                emails_sent_count: sent,
                total_customers: customers.length
            })
            .eq('id', migrationId);

        console.log(`📧 Price migration emails sent: ${sent} sent, ${failed} failed`);

        return { success: true, sent, failed, errors };
    } catch (error) {
        console.error('Error sending migration emails:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Execute price migration - update all Stripe subscriptions
 * @param {string} migrationId - Migration ID
 * @returns {Promise<{success: boolean, completed: number, failed: number, errors?: Array}>}
 */
export async function executeMigration(migrationId) {
    try {
        // Get migration record
        const { data: migration, error: migrationError } = await supabase
            .from('price_migrations')
            .select('*')
            .eq('id', migrationId)
            .single();

        if (migrationError) throw migrationError;
        if (!migration) {
            return { success: false, error: 'Migration not found' };
        }

        if (migration.status === 'completed') {
            return { success: false, error: 'Migration already completed' };
        }

        if (migration.status === 'cancelled') {
            return { success: false, error: 'Migration was cancelled' };
        }

        // Get pending customers
        const { data: customers, error: customersError } = await supabase
            .from('price_migration_customers')
            .select('*')
            .eq('migration_id', migrationId)
            .eq('migration_status', 'pending');

        if (customersError) throw customersError;

        let completed = 0;
        let failed = 0;
        const errors = [];

        for (const customer of customers || []) {
            try {
                // Skip if no valid subscription or new price
                if (!customer.stripe_subscription_id || !customer.new_price_id) {
                    await supabase
                        .from('price_migration_customers')
                        .update({
                            migration_status: 'skipped',
                            error_message: !customer.stripe_subscription_id
                                ? 'No subscription ID'
                                : 'No new price ID configured'
                        })
                        .eq('id', customer.id);
                    continue;
                }

                // Get subscription from Stripe to get item ID
                let subscriptionItemId = customer.stripe_subscription_item_id;
                if (!subscriptionItemId) {
                    const subscription = await stripe.subscriptions.retrieve(customer.stripe_subscription_id);
                    subscriptionItemId = subscription.items?.data?.[0]?.id;
                }

                if (!subscriptionItemId) {
                    throw new Error('Could not find subscription item ID');
                }

                // Update subscription to new price at next renewal (no proration)
                await stripe.subscriptions.update(customer.stripe_subscription_id, {
                    items: [{
                        id: subscriptionItemId,
                        price: customer.new_price_id
                    }],
                    proration_behavior: 'none'  // Apply at next billing
                });

                // Update customer record
                await supabase
                    .from('price_migration_customers')
                    .update({
                        migration_status: 'completed',
                        migration_completed_at: new Date().toISOString()
                    })
                    .eq('id', customer.id);

                completed++;
                console.log(`✅ Migrated subscription for customer: ${customer.organisation_id}`);

            } catch (error) {
                failed++;
                errors.push({ customerId: customer.organisation_id, error: error.message });

                await supabase
                    .from('price_migration_customers')
                    .update({
                        migration_status: 'failed',
                        error_message: error.message
                    })
                    .eq('id', customer.id);

                console.error(`❌ Failed to migrate subscription:`, error.message);
            }

            // Small delay between Stripe calls
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        // Update migration status
        await supabase
            .from('price_migrations')
            .update({
                status: 'completed',
                migration_completed_at: new Date().toISOString(),
                migrations_completed: completed,
                migrations_failed: failed
            })
            .eq('id', migrationId);

        console.log(`🔄 Price migration completed: ${completed} completed, ${failed} failed`);

        return { success: true, completed, failed, errors };
    } catch (error) {
        console.error('Error executing price migration:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Cancel a pending migration
 * @param {string} migrationId - Migration ID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function cancelMigration(migrationId) {
    try {
        const { data: migration, error: fetchError } = await supabase
            .from('price_migrations')
            .select('status')
            .eq('id', migrationId)
            .single();

        if (fetchError) throw fetchError;

        if (migration.status === 'completed') {
            return { success: false, error: 'Cannot cancel completed migration' };
        }

        const { error: updateError } = await supabase
            .from('price_migrations')
            .update({ status: 'cancelled' })
            .eq('id', migrationId);

        if (updateError) throw updateError;

        console.log(`❌ Price migration cancelled: ${migrationId}`);
        return { success: true };
    } catch (error) {
        console.error('Error cancelling migration:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Get migration by ID with customer details
 * @param {string} migrationId - Migration ID
 * @returns {Promise<{success: boolean, migration?: object, customers?: Array, error?: string}>}
 */
export async function getMigrationDetails(migrationId) {
    try {
        const { data: migration, error: migrationError } = await supabase
            .from('price_migrations')
            .select('*')
            .eq('id', migrationId)
            .single();

        if (migrationError) throw migrationError;

        const { data: customers, error: customersError } = await supabase
            .from('price_migration_customers')
            .select(`
                *,
                organisations (name)
            `)
            .eq('migration_id', migrationId);

        if (customersError) throw customersError;

        return { success: true, migration, customers };
    } catch (error) {
        console.error('Error getting migration details:', error);
        return { success: false, error: error.message };
    }
}

/**
 * List all migrations
 * @returns {Promise<{success: boolean, migrations?: Array, error?: string}>}
 */
export async function listMigrations() {
    try {
        const { data: migrations, error } = await supabase
            .from('price_migrations')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        return { success: true, migrations };
    } catch (error) {
        console.error('Error listing migrations:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Get pending migrations that are ready to execute
 * @returns {Promise<{success: boolean, migrations?: Array, error?: string}>}
 */
export async function getPendingMigrations() {
    try {
        const now = new Date().toISOString();

        const { data: migrations, error } = await supabase
            .from('price_migrations')
            .select('*')
            .eq('status', 'emails_sent')
            .lte('migration_scheduled_for', now);

        if (error) throw error;

        return { success: true, migrations };
    } catch (error) {
        console.error('Error getting pending migrations:', error);
        return { success: false, error: error.message };
    }
}

export default {
    createMigration,
    getCustomersToMigrate,
    sendMigrationEmails,
    executeMigration,
    cancelMigration,
    getMigrationDetails,
    listMigrations,
    getPendingMigrations
};
