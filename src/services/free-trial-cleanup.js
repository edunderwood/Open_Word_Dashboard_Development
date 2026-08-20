/**
 * Free-trial (10-minute, no-card) account deletion
 *
 * Shared by the automated cleanup scheduler (never-used trials only) and the
 * manual "Delete" button in the customers dashboard (any trial, streamed or
 * not). Deleting the auth user cascades through organisations.user_id
 * (ON DELETE CASCADE) to nearly every related table - see
 * migrations/COMPLETE-DATABASE-SETUP.sql in Open_Word_Control_Panel for the
 * full cascade graph. referral_tracking has no cascade rule on its org
 * columns, so it's cleaned up explicitly first to avoid a foreign key
 * violation aborting the whole delete.
 */

import supabase from './supabase.js';

/**
 * Delete a free-trial organisation and its auth user entirely.
 * @param {{id: string, user_id: string, name?: string, subscription_tier?: string}} org
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function deleteFreeTrialOrganisation(org) {
  if (!org?.id) {
    return { success: false, error: 'Missing organisation id' };
  }
  if (org.subscription_tier !== 'free_trial') {
    return { success: false, error: `Refusing to delete: organisation is not on the free_trial tier (tier: ${org.subscription_tier})` };
  }
  if (!org.user_id) {
    return { success: false, error: 'Organisation has no linked auth user_id - cannot delete via auth cascade' };
  }

  try {
    const { error: referralErr } = await supabase
      .from('referral_tracking')
      .delete()
      .or(`referrer_organisation_id.eq.${org.id},referred_organisation_id.eq.${org.id}`);
    if (referralErr) {
      console.error(`⚠️ Failed to clean up referral_tracking for org ${org.id} (continuing anyway):`, referralErr.message);
    }

    const { error: authErr } = await supabase.auth.admin.deleteUser(org.user_id);
    if (authErr) throw authErr;

    console.log(`🗑️ Deleted free-trial organisation: ${org.name || org.id} (${org.id})`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Failed to delete free-trial organisation ${org.id}:`, error.message);
    return { success: false, error: error.message };
  }
}

export default { deleteFreeTrialOrganisation };
