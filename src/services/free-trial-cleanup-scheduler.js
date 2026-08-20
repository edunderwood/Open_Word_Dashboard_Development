/**
 * Free-trial (10-minute, no-card) cleanup scheduler
 *
 * Daily cron with two independent stages, both scoped to orgs on the
 * `free_trial` tier that have NEVER actually streamed a session
 * (last_streaming_at IS NULL) - someone who tried their 10 minutes has real
 * usage data and a lead worth keeping, so this never touches them. Deleting
 * a used trial is a manual-only action (see the dashboard's customer list).
 *
 * Stage 1 (~1 week after signup): send a one-time nudge email reminding them
 * they haven't tried it yet, and that unused trials are auto-removed after
 * ~2 months. Dedupe via free_trial_unused_warning_sent_at.
 *
 * Stage 2 (~2 months after signup): delete the account entirely, regardless
 * of whether the stage-1 email was sent/succeeded - the deletion criteria is
 * "unused for ~2 months", not "already warned".
 */

import cron from 'node-cron';
import { supabase } from './supabase.js';
import { sendCustomerEmail, sendWarningAlert, logEmail } from './email.js';
import { deleteFreeTrialOrganisation } from './free-trial-cleanup.js';

let isRunning = false;

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@openword.live';
const TRY_FREE_URL = (process.env.OPENWORD_SERVER_URL || 'https://server.openword.live') + '/try-free';

const WARNING_WINDOW_MIN_DAYS = 6;
const WARNING_WINDOW_MAX_DAYS = 8;
const DELETE_AFTER_DAYS = 60;

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function buildNudgeEmailBody({ name }) {
  return `
    <p>Hi ${name || 'there'},</p>

    <p>You signed up for an Open Word free trial about a week ago, but it
    looks like you haven't tried a live session yet.</p>

    <p>Your 10-minute trial needs no credit card and takes about a minute to
    start - just log in, click Start, and share the QR code with a couple of
    people to see the translation appear live on their phones.</p>

    <p style="text-align: center;">
      <a href="${TRY_FREE_URL}" class="button">Try Open Word Free</a>
    </p>

    <p>Heads up: trial accounts that are never used are automatically
    removed after about 2 months, so if you'd still like to try it, now's a
    good time.</p>

    <p>Any questions, just reply to this email or write to
    <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>

    <p>Thanks,<br>
    The Open Word Team</p>
  `;
}

async function processWarnings() {
  const { data: orgs, error } = await supabase
    .from('organisations')
    .select('id, name, user_id, registered_at, email_opt_out')
    .eq('subscription_tier', 'free_trial')
    .is('last_streaming_at', null)
    .is('free_trial_unused_warning_sent_at', null)
    .gte('registered_at', daysAgoIso(WARNING_WINDOW_MAX_DAYS))
    .lte('registered_at', daysAgoIso(WARNING_WINDOW_MIN_DAYS));

  if (error) throw error;

  if (!orgs || orgs.length === 0) {
    console.log('   No never-used free trials due a warning email');
    return { sent: 0, skipped: 0, failed: 0 };
  }

  console.log(`📧 Sending never-used-trial nudge emails to ${orgs.length} organisation(s)`);

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

    const subject = "Haven't tried your Open Word free trial yet?";
    const result = await sendCustomerEmail(email, subject, buildNudgeEmailBody({ name: org.name }), org.name || 'Customer');

    await logEmail({
      organisationId: org.id,
      recipientEmail: email,
      recipientName: org.name,
      subject,
      emailType: 'free_trial_unused_reminder',
      status: result.success ? 'sent' : 'failed',
      error: result.error,
    });

    if (result.success) {
      const { error: updateErr } = await supabase
        .from('organisations')
        .update({ free_trial_unused_warning_sent_at: new Date().toISOString() })
        .eq('id', org.id);
      if (updateErr) {
        console.error(`   ⚠️  Email sent but failed to stamp warning for ${org.name}:`, updateErr.message);
      }
      sent++;
    } else {
      failed++;
    }
  }

  console.log(`   ✅ Never-used-trial warnings: ${sent} sent, ${skipped} skipped, ${failed} failed`);
  return { sent, skipped, failed };
}

async function processDeletions() {
  const { data: orgs, error } = await supabase
    .from('organisations')
    .select('id, name, user_id, subscription_tier, registered_at')
    .eq('subscription_tier', 'free_trial')
    .is('last_streaming_at', null)
    .lte('registered_at', daysAgoIso(DELETE_AFTER_DAYS));

  if (error) throw error;

  if (!orgs || orgs.length === 0) {
    console.log('   No never-used free trials due for deletion');
    return { deleted: 0, failed: 0 };
  }

  console.log(`🗑️ Deleting ${orgs.length} never-used free-trial organisation(s) (unused ${DELETE_AFTER_DAYS}+ days)`);

  let deleted = 0, failed = 0;

  for (const org of orgs) {
    const result = await deleteFreeTrialOrganisation(org);
    if (result.success) {
      deleted++;
    } else {
      failed++;
      console.error(`   ❌ Failed to delete ${org.name || org.id}: ${result.error}`);
    }
  }

  console.log(`   ✅ Never-used-trial deletions: ${deleted} deleted, ${failed} failed`);
  return { deleted, failed };
}

async function runFreeTrialCleanup() {
  if (isRunning) {
    console.log('⏳ Free-trial cleanup scheduler already running, skipping...');
    return;
  }
  isRunning = true;

  try {
    const warningResult = await processWarnings();
    const deletionResult = await processDeletions();

    if (warningResult.failed > 0 || deletionResult.failed > 0) {
      await sendWarningAlert(
        'Free-trial cleanup failures',
        `<p>${warningResult.failed} warning email(s) and ${deletionResult.failed} deletion(s) failed. Check dashboard logs for details.</p>`
      );
    }
  } catch (error) {
    console.error('❌ Free-trial cleanup scheduler error:', error);
  } finally {
    isRunning = false;
  }
}

export function startFreeTrialCleanupScheduler() {
  console.log('📅 Starting free-trial cleanup scheduler (runs daily at 9:00 AM UTC)');

  cron.schedule('0 9 * * *', async () => {
    console.log('\n⏰ Free-trial cleanup scheduler triggered at', new Date().toISOString());
    await runFreeTrialCleanup();
  });

  // Catch up on startup in case the server was down at 9:00 AM
  setTimeout(async () => {
    console.log('\n🚀 Running initial free-trial cleanup check...');
    await runFreeTrialCleanup();
  }, 20000);
}

export default { startFreeTrialCleanupScheduler };
