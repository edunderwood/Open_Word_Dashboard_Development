/**
 * Account deletion for closed accounts.
 *
 * The privacy policy and DPA commit to deleting an account within 30 days of
 * it closing ("closed" = 30 days after a cancelled subscription expires, or
 * when the customer asks). Shared by the daily closed-account job and the
 * Dashboard's "Delete account" button.
 *
 * Deleting the owner's login cascades through organisations.user_id to almost
 * every related table (see COMPLETE-DATABASE-SETUP.sql). Four tables don't
 * cascade - referral_tracking, support_requests, enterprise_audit_log (would
 * block the delete) and email_log (SET NULL, which would keep the customer's
 * email addresses forever) - so they're removed first. Enterprise team
 * members' logins are separate auth users and are removed too. Stripe keeps
 * its own invoice records, which covers the 6-year billing requirement.
 *
 * Never deletes an organisation whose owner is a Dashboard admin (the
 * owner's own test organisation shares that login).
 */

import supabase from './supabase.js';

/**
 * @param {string} orgId
 * @param {{ reason: 'expired_cancellation' | 'customer_request', allowEnterprise?: boolean }} options
 * @returns {Promise<{success: boolean, error?: string, ownerEmail?: string|null, name?: string}>}
 */
export async function deleteOrganisationAccount(orgId, { reason, allowEnterprise = false } = {}) {
  const { data: org, error: orgErr } = await supabase
    .from('organisations')
    .select('id, name, user_id, subscription_tier, is_enterprise')
    .eq('id', orgId)
    .maybeSingle();
  if (orgErr) return { success: false, error: orgErr.message };
  if (!org) return { success: false, error: 'Organisation not found' };
  if (org.subscription_tier === 'free_trial') {
    return { success: false, error: 'Free trials are deleted by the free-trial cleanup, not this route' };
  }
  if ((org.is_enterprise || org.subscription_tier === 'enterprise') && !allowEnterprise) {
    return { success: false, error: 'Enterprise accounts are only deleted on explicit request' };
  }

  // Guard: never delete the Dashboard admin's own login/organisation
  if (org.user_id) {
    const { data: admin } = await supabase.from('dashboard_admins').select('user_id').eq('user_id', org.user_id).maybeSingle();
    if (admin) return { success: false, error: "Refusing to delete: the owner's login is a Dashboard admin" };
  }

  let ownerEmail = null;
  if (org.user_id) {
    const { data: authUser } = await supabase.auth.admin.getUserById(org.user_id);
    ownerEmail = authUser?.user?.email || null;
  }

  try {
    // Enterprise team members have their own logins
    const { data: members } = await supabase.from('enterprise_users').select('auth_user_id').eq('organisation_id', org.id);

    // Tables that don't cascade (or would keep personal data via SET NULL)
    for (const [table, filter] of [
      ['referral_tracking', (q) => q.or(`referrer_organisation_id.eq.${org.id},referred_organisation_id.eq.${org.id}`)],
      ['support_requests', (q) => q.eq('organisation_id', org.id)],
      ['enterprise_audit_log', (q) => q.eq('organisation_id', org.id)],
      ['email_log', (q) => q.eq('organisation_id', org.id)],
    ]) {
      const { error } = await filter(supabase.from(table).delete());
      if (error) throw new Error(`${table}: ${error.message}`);
    }

    for (const m of members || []) {
      if (m.auth_user_id && m.auth_user_id !== org.user_id) {
        const { error } = await supabase.auth.admin.deleteUser(m.auth_user_id);
        if (error && !/not found/i.test(error.message)) throw new Error(`enterprise login: ${error.message}`);
      }
    }

    if (org.user_id) {
      const { error } = await supabase.auth.admin.deleteUser(org.user_id); // cascades to the organisation
      if (error) throw new Error(`owner login: ${error.message}`);
    }
    // No owner login (or the cascade didn't reach it): delete the organisation row itself
    await supabase.from('organisations').delete().eq('id', org.id);

    const { data: still } = await supabase.from('organisations').select('id').eq('id', org.id).maybeSingle();
    if (still) throw new Error('organisation still present after delete');

    console.log(`🗑️ Account deleted (${reason}): ${org.name} (${org.id})`);
    return { success: true, ownerEmail, name: org.name };
  } catch (error) {
    console.error(`❌ Failed to delete account ${org.name} (${org.id}):`, error.message);
    return { success: false, error: error.message, ownerEmail, name: org.name };
  }
}

export default { deleteOrganisationAccount };
