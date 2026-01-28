-- Add customer pause columns to organisations table
-- Required for Dashboard pause/unpause functionality

-- Add is_paused column
ALTER TABLE organisations
ADD COLUMN IF NOT EXISTS is_paused BOOLEAN DEFAULT false;

-- Add paused_at timestamp
ALTER TABLE organisations
ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;

-- Add pause_reason text
ALTER TABLE organisations
ADD COLUMN IF NOT EXISTS pause_reason TEXT;

-- Add comments explaining the columns
COMMENT ON COLUMN organisations.is_paused IS 'Whether the customer account is paused by admin';
COMMENT ON COLUMN organisations.paused_at IS 'When the account was paused';
COMMENT ON COLUMN organisations.pause_reason IS 'Reason for pausing the account';

-- Create index for quick lookup of paused accounts
CREATE INDEX IF NOT EXISTS idx_organisations_is_paused
ON organisations(is_paused)
WHERE is_paused = true;
