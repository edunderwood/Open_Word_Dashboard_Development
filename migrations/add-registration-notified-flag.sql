-- Migration: Add registration notification tracking
-- Run this in Supabase SQL Editor

-- Add column to track when admin was notified of new registration
ALTER TABLE organisations
ADD COLUMN IF NOT EXISTS registration_notified_at TIMESTAMPTZ DEFAULT NULL;

-- Add index for efficient querying of unnotified registrations
CREATE INDEX IF NOT EXISTS idx_organisations_unnotified
ON organisations(registration_notified_at)
WHERE registration_notified_at IS NULL;

-- Comment for documentation
COMMENT ON COLUMN organisations.registration_notified_at IS 'Timestamp when admin was notified of this registration. NULL means not yet notified.';
