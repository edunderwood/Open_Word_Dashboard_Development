/**
 * Supabase Client for Admin Dashboard
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing Supabase configuration');
}

// Use service role key for admin operations (bypasses RLS)
export const supabase = createClient(supabaseUrl, supabaseServiceKey);

export default supabase;
