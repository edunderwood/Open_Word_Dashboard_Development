/**
 * Pending-payment reminder scheduler
 *
 * Customers who start registering (plan chosen, organisation created with
 * payment_status 'pending') but never complete Stripe Checkout previously got
 * no reminder at all. Daily cron that sends two gentle "finish setting up"
 * emails:
 *   1st - at least 1 day after sign-up
 *   2nd - at least 7 days after sign-up and 3+ days after the 1st
 * Only accounts created in the last 30 days (older ones need a personal
 * follow-up, not an automated email out of the blue). Skips enterprise
 * accounts (own setup flow), opted-out accounts, and anything no longer
 * pending at send time. Stamps pending_payment_reminder_{1,2}_sent_at so each
 * email goes once (migration: Control Panel repo
 * migrations/add-pending-payment-reminders.sql).
 */
import cron from 'node-cron';
import { supabase } from './supabase.js';
import { sendCustomerEmail, sendWarningAlert, logEmail } from './email.js';

let isRunning = false;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_DAYS = 30;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@openword.live';
const LOGIN_URL = (process.env.OPENWORD_SERVER_URL || 'https://server.openword.live') + '/login';

function tierLabel(tier) {
  return tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : null;
}

function buildEmailBody({ name, tier, final }) {
  const plan = tierLabel(tier);
  return `
    <p>Hi ${name || 'there'},</p>
    ${final
      ? `<p>Just a final, gentle reminder: your Open Word account${plan ? ` on the <strong>${plan}</strong> plan` : ''} is almost ready, but the last step — adding your payment details — hasn't been completed yet.</p>`
      : `<p>Thanks for signing up to Open Word. Your account${plan ? ` on the <strong>${plan}</strong> plan` : ''} has been created, but the last step — adding your payment details — wasn't completed, so you can't start a live translation session yet.</p>`}
    <p>It only takes a minute. Log in and you'll be taken straight to the payment step:</p>
    <p style="text-align: center;">
      <a href="${LOGIN_URL}" class="button">Finish setting up Open Word</a>
    </p>
    <p>If something went wrong, or you'd like help choosing a plan, just reply to
    this email or write to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> —
    we're happy to help.${final ? ' If you’ve decided Open Word isn’t for you, no action is needed and we won’t send any more reminders.' : ''}</p>
    <p>Thanks,<br>
    The Open Word Team</p>
  `;
}

/**
 * @param {{ dryRun?: boolean }} options - dryRun: log what would be sent, send/stamp nothing
 * @returns {Promise<{sent:number, skipped:number, failed:number, planned:Array}>}
 */
export async function processPendingPaymentReminders({ dryRun = false } = {}) {
  if (isRunning) {
    console.log('⏳ Pending-payment reminder scheduler already running, skipping...');
    return { sent: 0, skipped: 0, failed: 0, planned: [] };
  }
  isRunning = true;
  const summary = { sent: 0, skipped: 0, failed: 0, planned: [] };

  try {
    const now = Date.now();
    const { data: orgs, error } = await supabase
      .from('organisations')
      .select('id, name, user_id, created_at, subscription_tier, email_opt_out, is_enterprise, payment_status, pending_payment_reminder_1_sent_at, pending_payment_reminder_2_sent_at')
      .eq('payment_status', 'pending')
      .gte('created_at', new Date(now - MAX_AGE_DAYS * DAY_MS).toISOString())
      .lte('created_at', new Date(now - 1 * DAY_MS).toISOString())
      .is('pending_payment_reminder_2_sent_at', null);
    if (error) throw error;

    for (const org of orgs || []) {
      if (org.is_enterprise || org.email_opt_out || !org.user_id) {
        summary.skipped++;
        continue;
      }

      const ageDays = (now - new Date(org.created_at).getTime()) / DAY_MS;
      const r1 = org.pending_payment_reminder_1_sent_at;
      let which = null;
      if (!r1) {
        which = 1;
      } else if (ageDays >= 7 && now - new Date(r1).getTime() >= 3 * DAY_MS) {
        which = 2;
      }
      if (!which) continue;

      let email = null;
      try {
        const { data: authUser } = await supabase.auth.admin.getUserById(org.user_id);
        email = authUser?.user?.email || null;
      } catch (authErr) {
        console.error(`   ❌ Failed to fetch auth user for ${org.name}:`, authErr.message);
      }
      if (!email) {
        summary.skipped++;
        continue;
      }

      const subject = which === 1
        ? 'Finish setting up your Open Word account'
        : 'Reminder: your Open Word account is almost ready';
      summary.planned.push({ organisation: org.name, reminder: which, ageDays: Math.floor(ageDays) });

      if (dryRun) continue;

      // Re-check right before sending - they may have paid since the query
      const { data: fresh } = await supabase.from('organisations').select('payment_status').eq('id', org.id).single();
      if (fresh?.payment_status !== 'pending') {
        summary.skipped++;
        continue;
      }

      const result = await sendCustomerEmail(
        email,
        subject,
        buildEmailBody({ name: org.name, tier: org.subscription_tier, final: which === 2 }),
        org.name || 'Customer'
      );
      await logEmail({
        organisationId: org.id,
        recipientEmail: email,
        recipientName: org.name,
        subject,
        emailType: 'pending_payment_reminder',
        status: result.success ? 'sent' : 'failed',
        error: result.error,
      });

      if (result.success) {
        const column = which === 1 ? 'pending_payment_reminder_1_sent_at' : 'pending_payment_reminder_2_sent_at';
        const { error: updateErr } = await supabase
          .from('organisations')
          .update({ [column]: new Date().toISOString() })
          .eq('id', org.id);
        if (updateErr) {
          console.error(`   ⚠️  Email sent but failed to stamp reminder ${which} for ${org.name}:`, updateErr.message);
        }
        summary.sent++;
      } else {
        summary.failed++;
      }
    }

    console.log(`   ✅ Pending-payment reminders${dryRun ? ' (DRY RUN)' : ''}: ${summary.planned.length} due, ${summary.sent} sent, ${summary.skipped} skipped, ${summary.failed} failed`);
    if (summary.failed > 0) {
      await sendWarningAlert(
        'Pending-payment reminder send failures',
        `<p>${summary.failed} pending-payment reminder email(s) failed to send. Check dashboard logs for details.</p>`
      );
    }
  } catch (error) {
    console.error('❌ Pending-payment reminder scheduler error:', error);
  } finally {
    isRunning = false;
  }
  return summary;
}

export function startPendingPaymentReminderScheduler() {
  console.log('📅 Starting pending-payment reminder scheduler (runs daily at 9:15 AM UTC)');
  cron.schedule('15 9 * * *', async () => {
    console.log('\n⏰ Pending-payment reminder scheduler triggered at', new Date().toISOString());
    await processPendingPaymentReminders();
  });
  // Catch up on startup in case the server was down at 9:15 AM
  setTimeout(async () => {
    console.log('\n🚀 Running initial pending-payment reminder check...');
    await processPendingPaymentReminders();
  }, 20000);
}

export default { startPendingPaymentReminderScheduler, processPendingPaymentReminders };
