/**
 * Closed-account deletion scheduler
 *
 * An account is "closed" 30 days after its cancelled subscription expires
 * (organisations.tier_expires_at); the privacy policy and DPA promise to
 * delete it then. Cancelling during a free trial records no
 * tier_expires_at, so for those the plan is treated as ending on the trial
 * end date or the cancellation date, whichever is later. Daily at 05:00 UTC:
 *   - from 23 days after expiry: email a warning ("your account will be deleted
 *     on <date>"), once (account_deletion_warning_sent_at);
 *   - once 30 days have passed since expiry AND at least 7 days since the
 *     warning: delete the account (account-deletion.js) and email a short
 *     confirmation.
 * Skips free trials (own cleanup), enterprise accounts (deleted on explicit
 * request only), anyone who has resubscribed, and the Dashboard admin's own
 * organisation (guarded in deleteOrganisationAccount). Never runs on startup,
 * so a deploy can't trigger deletions. Emails support a summary of anything
 * deleted.
 */

import cron from 'node-cron';
import { supabase } from './supabase.js';
import { sendCustomerEmail, sendWarningAlert, logEmail } from './email.js';
import { deleteOrganisationAccount } from './account-deletion.js';

let isRunning = false;
const DAY_MS = 24 * 60 * 60 * 1000;
const WARN_AFTER_EXPIRY_DAYS = 23;
const DELETE_AFTER_EXPIRY_DAYS = 30;
const MIN_NOTICE_DAYS = 7;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@openword.live';
const LOGIN_URL = (process.env.OPENWORD_SERVER_URL || 'https://server.openword.live') + '/login';

// When the plan actually ended: tier_expires_at, or for trial cancellations
// (which record none) the later of the trial end and the cancellation date
export function planEndDate(org) {
  if (org.tier_expires_at) return new Date(org.tier_expires_at).getTime();
  const dates = [org.trial_ends_at, org.subscription_cancelled_at].filter(Boolean).map(d => new Date(d).getTime());
  return dates.length ? Math.max(...dates) : null;
}

const longDate = (d) => new Date(d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

function buildWarningBody({ name, deleteOn, credits }) {
  return `
    <p>Hi ${name || 'there'},</p>
    <p>Your Open Word subscription ended on its cancellation date. As set out in our privacy policy, we delete closed accounts so we don't keep your data longer than we need to.</p>
    <p><strong>Your account and its data will be permanently deleted on ${longDate(deleteOn)}.</strong> This includes your organisation settings, session history and usage records.${credits > 0 ? ` Your remaining <strong>${credits.toFixed(1)} credits</strong> will expire when your account is deleted.` : ''}</p>
    <p>If you'd like to keep using Open Word, just log in and choose a plan before then:</p>
    <p style="text-align: center;">
      <a href="${LOGIN_URL}" class="button">Keep my Open Word account</a>
    </p>
    <p>If you're happy for your account to be deleted, you don't need to do anything. If you have any questions, reply to this email or write to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
    <p>Thanks,<br>
    The Open Word Team</p>
  `;
}

export function buildDeletedBody({ name, reason }) {
  return `
    <p>Hi ${name || 'there'},</p>
    <p>${reason === 'customer_request' ? 'As you requested, your' : 'As we let you know last week, your'} Open Word account${name ? ` for <strong>${name}</strong>` : ''} and its data have now been permanently deleted.</p>
    <p>Our payment provider, Stripe, keeps copies of your invoices for 6 years to meet tax and accounting obligations. Nothing else is kept.</p>
    <p>Thank you for using Open Word. If you ever want to come back, you'd be very welcome to sign up again. If you have any questions, write to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
    <p>Thanks,<br>
    The Open Word Team</p>
  `;
}

export async function sendDeletionConfirmation({ email, name, reason }) {
  if (!email) return;
  const subject = 'Your Open Word account has been deleted';
  const result = await sendCustomerEmail(email, subject, buildDeletedBody({ name, reason }), name || 'Customer');
  // Logged without the address: the account (and its personal data) no longer exists
  await logEmail({ recipientEmail: '(deleted account)', recipientName: name, subject, emailType: 'account_deleted', status: result.success ? 'sent' : 'failed', error: result.error });
}

/**
 * @param {{ dryRun?: boolean }} options - dryRun: report what would happen, send/delete nothing
 */
export async function processClosedAccounts({ dryRun = false } = {}) {
  if (isRunning) return { warned: [], deleted: [], failed: [], skipped: 0 };
  isRunning = true;
  const summary = { warned: [], deleted: [], failed: [], skipped: 0 };

  try {
    const now = Date.now();
    const { data: orgs, error } = await supabase
      .from('organisations')
      .select('id, name, user_id, subscription_tier, subscription_status, is_enterprise, subscription_cancelled_at, tier_expires_at, trial_ends_at, account_deletion_warning_sent_at')
      .not('subscription_cancelled_at', 'is', null);
    if (error) throw error;

    // The Dashboard admin's own organisation is never deleted, so never warned either
    const { data: admins } = await supabase.from('dashboard_admins').select('user_id');
    const adminUserIds = new Set((admins || []).map(a => a.user_id).filter(Boolean));

    for (const org of orgs || []) {
      if (org.subscription_tier === 'free_trial' || org.is_enterprise || org.subscription_tier === 'enterprise'
          || ['active', 'trialing'].includes(org.subscription_status) || adminUserIds.has(org.user_id)) {
        summary.skipped++;
        continue;
      }

      const endedAt = planEndDate(org);
      if (!endedAt || endedAt > now - WARN_AFTER_EXPIRY_DAYS * DAY_MS) continue; // not yet due for a warning
      const deleteDue = endedAt + DELETE_AFTER_EXPIRY_DAYS * DAY_MS;

      if (!org.account_deletion_warning_sent_at) {
        const deleteOn = Math.max(deleteDue, now + MIN_NOTICE_DAYS * DAY_MS);
        summary.warned.push({ name: org.name, deleteOn: new Date(deleteOn).toISOString().slice(0, 10) });
        if (dryRun) continue;

        let email = null;
        if (org.user_id) {
          const { data: authUser } = await supabase.auth.admin.getUserById(org.user_id);
          email = authUser?.user?.email || null;
        }
        if (!email) { summary.skipped++; continue; }
        const { data: bal } = await supabase.from('credit_balances').select('current_balance').eq('organisation_id', org.id).maybeSingle();
        const subject = `Your Open Word account will be deleted on ${new Date(deleteOn).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`;
        const result = await sendCustomerEmail(email, subject, buildWarningBody({ name: org.name, deleteOn, credits: Number(bal?.current_balance) || 0 }), org.name || 'Customer');
        await logEmail({ organisationId: org.id, recipientEmail: email, recipientName: org.name, subject, emailType: 'account_deletion_warning', status: result.success ? 'sent' : 'failed', error: result.error });
        if (result.success) {
          await supabase.from('organisations').update({ account_deletion_warning_sent_at: new Date().toISOString() }).eq('id', org.id);
        } else {
          summary.failed.push({ name: org.name, error: `warning email: ${result.error}` });
        }
        continue;
      }

      const noticeEnds = new Date(org.account_deletion_warning_sent_at).getTime() + MIN_NOTICE_DAYS * DAY_MS;
      if (now < deleteDue || now < noticeEnds) continue;

      if (dryRun) { summary.deleted.push({ name: org.name }); continue; }
      const res = await deleteOrganisationAccount(org.id, { reason: 'expired_cancellation' });
      if (res.success) {
        summary.deleted.push({ name: org.name });
        await sendDeletionConfirmation({ email: res.ownerEmail, name: org.name, reason: 'expired_cancellation' });
      } else {
        summary.failed.push({ name: org.name, error: res.error });
      }
    }

    console.log(`   ✅ Closed accounts${dryRun ? ' (DRY RUN)' : ''}: ${summary.warned.length} warned, ${summary.deleted.length} deleted, ${summary.failed.length} failed, ${summary.skipped} skipped`);
    if (!dryRun && (summary.deleted.length || summary.failed.length)) {
      await sendWarningAlert(
        'Closed accounts deleted',
        `<p>Deleted: ${summary.deleted.map(d => d.name).join(', ') || 'none'}</p>
         ${summary.failed.length ? `<p>Failed: ${summary.failed.map(f => `${f.name} (${f.error})`).join('; ')}</p>` : ''}`
      );
    }
  } catch (error) {
    console.error('❌ Closed-account scheduler error:', error);
  } finally {
    isRunning = false;
  }
  return summary;
}

export function startClosedAccountDeletionScheduler() {
  console.log('📅 Closed-account deletion scheduled (daily at 05:00 UTC; never on startup)');
  cron.schedule('0 5 * * *', async () => {
    await processClosedAccounts();
  }, { timezone: 'UTC' });
}

export default { startClosedAccountDeletionScheduler, processClosedAccounts };
