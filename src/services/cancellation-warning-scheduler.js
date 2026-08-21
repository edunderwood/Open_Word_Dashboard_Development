/**
 * Cancellation final-warning scheduler
 *
 * Daily cron that finds organisations whose subscription was self-cancelled
 * and whose access ends in roughly 3 days (tier_expires_at, now+2d to
 * now+4d), then sends a final "you can still resubscribe" reminder.
 * Dedupes via cancellation_final_warning_sent_at.
 *
 * Naturally skips anyone who has already resubscribed: updateOrganisationTier()
 * (Open_Word_Control_Panel's db/tiers.js) clears both subscription_cancelled_at
 * and tier_expires_at on resubscription, so they stop matching the query below
 * before the warning would ever go out.
 */

import cron from 'node-cron';
import { supabase } from './supabase.js';
import { sendCustomerEmail, sendWarningAlert, logEmail } from './email.js';

let isRunning = false;

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@openword.live';
const LOGIN_URL = (process.env.OPENWORD_SERVER_URL || 'https://server.openword.live') + '/login';

const WINDOW_MIN_DAYS = 2;
const WINDOW_MAX_DAYS = 4;

function buildEmailBody({ name, endsAt }) {
  const friendlyDate = new Date(endsAt).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  return `
    <p>Hi ${name || 'there'},</p>

    <p>This is a final reminder that your Open Word subscription was
    cancelled and your access ends on <strong>${friendlyDate}</strong> -
    just 3 days from now.</p>

    <p>If you'd like to keep using Open Word, you can resubscribe any time
    before then and pick up right where you left off:</p>

    <p style="text-align: center;">
      <a href="${LOGIN_URL}" class="button">Resubscribe</a>
    </p>

    <p>If you meant to cancel, there's nothing more you need to do - your
    credits will remain available and won't expire, so you can always come
    back later.</p>

    <p>Any questions, just reply to this email or write to
    <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>

    <p>Best regards,<br>
    The Open Word Team</p>
  `;
}

function daysFromNowIso(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function processCancellationWarnings() {
  if (isRunning) {
    console.log('⏳ Cancellation warning scheduler already running, skipping...');
    return;
  }
  isRunning = true;

  try {
    const { data: orgs, error } = await supabase
      .from('organisations')
      .select('id, name, user_id, tier_expires_at, email_opt_out')
      .not('subscription_cancelled_at', 'is', null)
      .not('tier_expires_at', 'is', null)
      .gte('tier_expires_at', daysFromNowIso(WINDOW_MIN_DAYS))
      .lte('tier_expires_at', daysFromNowIso(WINDOW_MAX_DAYS))
      .is('cancellation_final_warning_sent_at', null);

    if (error) throw error;

    if (!orgs || orgs.length === 0) {
      console.log('   No cancellation final warnings due in the 2–4 day window');
      return;
    }

    console.log(`📧 Sending cancellation final warnings to ${orgs.length} organisation(s)`);

    let sent = 0, skipped = 0, failed = 0;

    for (const org of orgs) {
      if (org.email_opt_out || !org.user_id) {
        skipped++;
        continue;
      }

      let email = null;
      try {
        const { data: authUser } = await supabase.auth.admin.getUserById(org.user_id);
        email = authUser?.user?.email || null;
      } catch (authErr) {
        console.error(`   ❌ Failed to fetch auth user for ${org.name}:`, authErr.message);
      }

      if (!email) {
        skipped++;
        continue;
      }

      const subject = 'Your Open Word access ends in 3 days';
      const result = await sendCustomerEmail(
        email,
        subject,
        buildEmailBody({ name: org.name, endsAt: org.tier_expires_at }),
        org.name || 'Customer'
      );

      await logEmail({
        organisationId: org.id,
        recipientEmail: email,
        recipientName: org.name,
        subject,
        emailType: 'cancellation_final_warning',
        status: result.success ? 'sent' : 'failed',
        error: result.error,
      });

      if (result.success) {
        const { error: updateErr } = await supabase
          .from('organisations')
          .update({ cancellation_final_warning_sent_at: new Date().toISOString() })
          .eq('id', org.id);
        if (updateErr) {
          console.error(`   ⚠️  Email sent but failed to stamp warning for ${org.name}:`, updateErr.message);
        }
        sent++;
      } else {
        failed++;
      }
    }

    console.log(`   ✅ Cancellation final warnings: ${sent} sent, ${skipped} skipped, ${failed} failed`);

    if (failed > 0) {
      await sendWarningAlert(
        'Cancellation warning send failures',
        `<p>${failed} of ${orgs.length} cancellation final warning emails failed to send. Check dashboard logs for details.</p>`
      );
    }
  } catch (error) {
    console.error('❌ Cancellation warning scheduler error:', error);
  } finally {
    isRunning = false;
  }
}

export function startCancellationWarningScheduler() {
  console.log('📅 Starting cancellation warning scheduler (runs daily at 8:30 AM UTC)');

  cron.schedule('30 8 * * *', async () => {
    console.log('\n⏰ Cancellation warning scheduler triggered at', new Date().toISOString());
    await processCancellationWarnings();
  });

  // Catch up on startup in case the server was down at 8:30 AM
  setTimeout(async () => {
    console.log('\n🚀 Running initial cancellation warning check...');
    await processCancellationWarnings();
  }, 17000);
}

export default { startCancellationWarningScheduler };
