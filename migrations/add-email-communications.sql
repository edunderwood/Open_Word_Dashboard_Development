-- Migration: Add email communications support
-- Run this in Supabase SQL Editor

-- Table to track all sent emails for audit/history
CREATE TABLE IF NOT EXISTS email_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id UUID REFERENCES organisations(id) ON DELETE SET NULL,
    recipient_email TEXT NOT NULL,
    recipient_name TEXT,
    subject TEXT NOT NULL,
    body_preview TEXT,  -- First 500 chars of email body for reference
    sent_at TIMESTAMPTZ DEFAULT NOW(),
    sent_by TEXT,  -- Admin who sent the email
    status TEXT DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'bounced')),
    email_type TEXT CHECK (email_type IN ('bulk_announcement', 'individual', 'maintenance', 'feature_update', 'pricing_change', 'welcome', 'custom')),
    error_message TEXT,  -- Store error if failed
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for querying by organisation
CREATE INDEX IF NOT EXISTS idx_email_log_org ON email_log(organisation_id);

-- Index for querying by date
CREATE INDEX IF NOT EXISTS idx_email_log_sent_at ON email_log(sent_at DESC);

-- Index for querying by type
CREATE INDEX IF NOT EXISTS idx_email_log_type ON email_log(email_type);

-- Add email opt-out column to organisations
ALTER TABLE organisations
ADD COLUMN IF NOT EXISTS email_opt_out BOOLEAN DEFAULT false;

-- RLS policies for email_log (admin access only via service role)
ALTER TABLE email_log ENABLE ROW LEVEL SECURITY;

-- Only service role can access email_log (dashboard uses service role)
CREATE POLICY "Service role full access to email_log" ON email_log
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

-- Grant permissions
GRANT ALL ON email_log TO service_role;

COMMENT ON TABLE email_log IS 'Tracks all emails sent to customers from the dashboard';
COMMENT ON COLUMN email_log.email_type IS 'Type of email: bulk_announcement, individual, maintenance, feature_update, pricing_change, welcome, custom';
COMMENT ON COLUMN organisations.email_opt_out IS 'If true, customer has opted out of bulk marketing emails';
