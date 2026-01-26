-- Price Migration Tables
-- Used to manage bulk price updates across all customers with email notifications
-- Run this migration in Supabase SQL Editor

-- Main migration tracking table
CREATE TABLE IF NOT EXISTS price_migrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,                          -- "January 2026 Price Update"
    status TEXT DEFAULT 'pending',               -- pending, emails_sent, completed, cancelled

    -- Old pricing (display only, in pence/cents)
    old_basic_gbp INTEGER,                       -- pence (1400 = £14)
    old_standard_gbp INTEGER,
    old_pro_gbp INTEGER,
    old_credit_gbp INTEGER,                      -- pence per credit (122 = £1.22)

    -- New pricing (display only, in pence/cents)
    new_basic_gbp INTEGER,
    new_standard_gbp INTEGER,
    new_pro_gbp INTEGER,
    new_credit_gbp INTEGER,

    -- New Stripe Price IDs (for migration)
    new_price_id_basic_gbp TEXT,
    new_price_id_basic_usd TEXT,
    new_price_id_basic_eur TEXT,
    new_price_id_standard_gbp TEXT,
    new_price_id_standard_usd TEXT,
    new_price_id_standard_eur TEXT,
    new_price_id_pro_gbp TEXT,
    new_price_id_pro_usd TEXT,
    new_price_id_pro_eur TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    emails_sent_at TIMESTAMPTZ,                  -- When warning emails sent
    migration_scheduled_for TIMESTAMPTZ,         -- emails_sent_at + 7 days
    migration_completed_at TIMESTAMPTZ,

    -- Stats
    total_customers INTEGER DEFAULT 0,
    emails_sent_count INTEGER DEFAULT 0,
    migrations_completed INTEGER DEFAULT 0,
    migrations_failed INTEGER DEFAULT 0,

    created_by TEXT                              -- Admin who created
);

-- Track individual customer migrations
CREATE TABLE IF NOT EXISTS price_migration_customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    migration_id UUID REFERENCES price_migrations(id) ON DELETE CASCADE,
    organisation_id UUID REFERENCES organisations(id) ON DELETE CASCADE,

    -- Customer's current state
    current_tier TEXT,                           -- basic, standard, pro
    current_currency TEXT,                       -- gbp, usd, eur
    current_price_id TEXT,                       -- Stripe Price ID
    stripe_subscription_id TEXT,                 -- Stripe Subscription ID
    stripe_subscription_item_id TEXT,            -- Stripe Subscription Item ID

    -- Target state
    new_price_id TEXT,                           -- New Stripe Price ID

    -- Status tracking
    email_sent_at TIMESTAMPTZ,
    email_status TEXT,                           -- sent, failed, skipped
    migration_status TEXT DEFAULT 'pending',     -- pending, completed, failed, skipped
    migration_completed_at TIMESTAMPTZ,
    error_message TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),

    -- Ensure one entry per customer per migration
    UNIQUE(migration_id, organisation_id)
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_price_migrations_status ON price_migrations(status);
CREATE INDEX IF NOT EXISTS idx_price_migrations_scheduled ON price_migrations(migration_scheduled_for) WHERE status = 'emails_sent';
CREATE INDEX IF NOT EXISTS idx_price_migration_customers_migration ON price_migration_customers(migration_id);
CREATE INDEX IF NOT EXISTS idx_price_migration_customers_status ON price_migration_customers(migration_status);

-- Add comments for documentation
COMMENT ON TABLE price_migrations IS 'Tracks bulk price migration campaigns with email notifications';
COMMENT ON TABLE price_migration_customers IS 'Tracks individual customer status within a price migration';
COMMENT ON COLUMN price_migrations.status IS 'pending = created but not started, emails_sent = warning emails sent awaiting migration, completed = all subscriptions migrated, cancelled = migration aborted';
COMMENT ON COLUMN price_migration_customers.email_status IS 'sent = email delivered, failed = email failed, skipped = no email address or opted out';
COMMENT ON COLUMN price_migration_customers.migration_status IS 'pending = awaiting migration, completed = subscription updated, failed = stripe error, skipped = no active subscription';
