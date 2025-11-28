-- Create pricing_tiers table for OpenWord Dashboard
-- Run this in your Supabase SQL Editor

CREATE TABLE IF NOT EXISTS pricing_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(50) UNIQUE NOT NULL,
  description TEXT,
  monthly_price DECIMAL(10, 2) DEFAULT 0,
  yearly_price DECIMAL(10, 2) DEFAULT 0,
  included_characters INTEGER DEFAULT 0,
  overage_rate DECIMAL(10, 4) DEFAULT 0,
  features JSONB DEFAULT '[]'::jsonb,
  stripe_product_id VARCHAR(100),
  sort_order INTEGER DEFAULT 999,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE pricing_tiers ENABLE ROW LEVEL SECURITY;

-- Create policy for service role (dashboard) to have full access
CREATE POLICY "Service role has full access to pricing_tiers"
  ON pricing_tiers
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Create policy for anon/authenticated to read active tiers only
CREATE POLICY "Public can view active pricing tiers"
  ON pricing_tiers
  FOR SELECT
  USING (is_active = true);

-- Insert default pricing tiers
INSERT INTO pricing_tiers (name, slug, description, monthly_price, yearly_price, included_characters, overage_rate, features, sort_order) VALUES
(
  'Pay As You Go',
  'pay_as_you_go',
  'Perfect for occasional use with no monthly commitment',
  0,
  0,
  0,
  0.008,
  '["No monthly fee", "Pay only for what you use", "All languages supported", "Basic support"]'::jsonb,
  1
),
(
  'Standard',
  'standard',
  'Great for regular users with predictable usage',
  29,
  290,
  500000,
  0.006,
  '["500K characters included", "All languages supported", "Priority support", "Usage analytics"]'::jsonb,
  2
),
(
  'Professional',
  'professional',
  'For high-volume users and businesses',
  79,
  790,
  2000000,
  0.004,
  '["2M characters included", "All languages supported", "Priority support", "Advanced analytics", "API access"]'::jsonb,
  3
),
(
  'Enterprise',
  'enterprise',
  'Custom solutions for large organisations',
  199,
  1990,
  10000000,
  0.002,
  '["10M characters included", "All languages supported", "Dedicated support", "Custom integrations", "SLA guarantee", "On-premise option"]'::jsonb,
  4
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_pricing_tiers_slug ON pricing_tiers(slug);
CREATE INDEX IF NOT EXISTS idx_pricing_tiers_active ON pricing_tiers(is_active);

-- Add comment
COMMENT ON TABLE pricing_tiers IS 'Stores subscription pricing tiers for OpenWord';
