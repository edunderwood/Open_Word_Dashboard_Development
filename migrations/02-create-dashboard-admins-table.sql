-- Create dashboard_admins table for OpenWord Dashboard
-- This controls who can access the admin dashboard
-- Run this in your Supabase SQL Editor

CREATE TABLE IF NOT EXISTS dashboard_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'admin',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Enable RLS
ALTER TABLE dashboard_admins ENABLE ROW LEVEL SECURITY;

-- Create policy for service role to have full access
CREATE POLICY "Service role has full access to dashboard_admins"
  ON dashboard_admins
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_dashboard_admins_user_id ON dashboard_admins(user_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_admins_email ON dashboard_admins(email);

-- Add comment
COMMENT ON TABLE dashboard_admins IS 'Controls which users can access the OpenWord admin dashboard';

-- ============================================================
-- ADD YOUR ADMIN USERS BELOW
-- ============================================================
-- First, find the user_id from auth.users table:
-- SELECT id, email FROM auth.users WHERE email = 'your-email@example.com';

-- Then insert them as an admin:
-- INSERT INTO dashboard_admins (user_id, email, role) VALUES
-- ('user-uuid-here', 'admin@openword.live', 'super_admin');

-- Example: Add admin@openword.live as super admin
-- (Replace the UUID with the actual user_id from auth.users)
--
-- INSERT INTO dashboard_admins (user_id, email, role)
-- SELECT id, email, 'super_admin'
-- FROM auth.users
-- WHERE email = 'admin@openword.live';

-- ============================================================
-- QUICK SETUP: Run this to add an admin by email
-- ============================================================
-- This will add the user as an admin if they exist in auth.users:

DO $$
DECLARE
  admin_email TEXT := 'admin@openword.live';  -- CHANGE THIS to your email
  admin_role TEXT := 'super_admin';
  found_user_id UUID;
BEGIN
  -- Find the user
  SELECT id INTO found_user_id FROM auth.users WHERE email = admin_email;

  IF found_user_id IS NOT NULL THEN
    -- Insert if not exists
    INSERT INTO dashboard_admins (user_id, email, role)
    VALUES (found_user_id, admin_email, admin_role)
    ON CONFLICT (user_id) DO UPDATE SET role = admin_role, is_active = true;

    RAISE NOTICE 'Admin added: % with role %', admin_email, admin_role;
  ELSE
    RAISE NOTICE 'User not found: %. They need to register first.', admin_email;
  END IF;
END $$;
