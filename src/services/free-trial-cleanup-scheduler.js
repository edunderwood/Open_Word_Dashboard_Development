/**
 * Free-trial (10-minute, no-card) cleanup scheduler
 *
 * Daily cron with three independent stages, all scoped to orgs on the
 * `free_trial` tier that have NEVER actually streamed a session
 * (last_streaming_at IS NULL) - someone who tried their 10 minutes has real
 * usage data and a lead worth keeping, so this never touches them. Deleting
 * a used trial is a manual-only action (see the dashboard's customer list).
 *
 * Tightened 2026-09-09 from the original 1-week-nudge/2-month-delete cycle:
 * a single nudge 6-8 days in, then 52 days of total silence before deletion,
 * meant most people had long forgotten the email by the time their account
 * disappeared - and since these are unused, zero-payment signups with
 * nothing real to lose, there was no good reason to hold onto them that
 * long anyway (also better data-hygiene/privacy practice - not retaining
 * signups nobody ever used).
 *
 * Stage 1 (~2-3 days after signup): early nudge - "haven't tried it yet",
 * while interest is still fresh. Dedupe via free_trial_unused_warning_sent_at.
 *
 * Stage 2 (~14-15 days after signup, a few days before deletion): final
 * warning - explicitly says the account will be removed soon, so nobody is
 * surprised. Dedupe via free_trial_final_warning_sent_at.
 *
 * Stage 3 (~18 days after signup): delete the account entirely, regardless
 * of whether either warning email was sent/succeeded - the deletion
 * criteria is "unused for ~18 days", not "already warned".
 */

import cron from 'node-cron';
import { supabase } from './supabase.js';
import { sendCustomerEmail, sendWarningAlert, logEmail } from './email.js';
import { deleteFreeTrialOrganisation } from './free-trial-cleanup.js';

let isRunning = false;

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@openword.live';
const TRY_FREE_URL = (process.env.OPENWORD_SERVER_URL || 'https://server.openword.live') + '/try-free';

const EARLY_WARNING_WINDOW_MIN_DAYS = 2;
const EARLY_WARNING_WINDOW_MAX_DAYS = 3;
const FINAL_WARNING_WINDOW_MIN_DAYS = 14;
const FINAL_WARNING_WINDOW_MAX_DAYS = 15;
// Exported so the customer list (src/routes/customers.js) can show unused
// 10-min trials' real scheduled deletion date in the "Trial Ends" column
// (organisations.trial_ends_at is never set for this tier - it's only
// populated by the 30-day Stripe trial flow) without hardcoding this number
// a second time in a different file and risking the two drifting apart.
export const DELETE_AFTER_DAYS = 18;

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function buildEarlyNudgeEmailBody({ name }) {
  return `
    <p>Hi ${name || 'there'},</p>

    <p>You signed up for an Open Word free trial a couple of days ago, but
    it looks like you haven't tried a live session yet.</p>

    <p>Your 10-minute trial needs no credit card and takes about a minute to
    start - just log in, click Start, and share the QR code with a couple of
    people to see the translation appear live on their phones.</p>

    <p style="text-align: center;">
      <a href="${TRY_FREE_URL}" class="button">Try Open Word Free</a>
    </p>

    <p>Heads up: trial accounts that are never used are automatically
    removed after a couple of weeks, so if you'd still like to try it,
    now's a good time.</p>

    <p>Any questions, just reply to this email or write to
    <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>

    <p>Thanks,<br>
    The Open Word Team</p>
  `;
}

function buildFinalWarningEmailBody({ name }) {
  const daysUntilDelete = DELETE_AFTER_DAYS - FINAL_WARNING_WINDOW_MIN_DAYS;
  return `
    <p>Hi ${name || 'there'},</p>

    <p>You signed up for an Open Word free trial about two weeks ago, but it
    still looks like you haven't tried a live session yet.</p>

    <p>Since it's never been used, your trial account is scheduled to be
    removed in about ${daysUntilDelete} days. If you'd like to keep it,
    all it takes is one 10-minute session - no credit card needed:</p>

    <p style="text-align: center;">
      <a href="${TRY_FREE_URL}" class="button">Try Open Word Free</a>
    </p>

    <p>If you don't get to it in time, no problem - you're always welcome
    to sign up again later.</p>

    <p>Any questions, just reply to this email or write to
    <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>

    <p>Thanks,<br>
    The Open Word Team</p>
  `;
}

/**
 * Shared logic for both warning stages: find never-streamed free-trial orgs
 * whose registered_at falls in [windowMaxDays, windowMinDays] ago, that
 * haven't already received THIS stage's email (dedupeColumn), and send it.
 */
async function processWarningStage({ windowMinDays, windowMaxDays, dedupeColumn, emailType, subject, buildBody, label }) {
  const { data: orgs, error } = await supabase
    .from('organisations')
    .select(`id, name, user_id, registered_at, email_opt_out, ${dedupeColumn}`)
    .eq('subscription_tier', 'free_trial')
    .is('last_streaming_at', null)
    .is(dedupeColumn, null)
    .gte('registered_at', daysAgoIso(windowMaxDays))
    .lte('registered_at', daysAgoIso(windowMinDays));

  if (error) throw error;

  if (!orgs || orgs.length === 0) {
    console.log(`   No never-used free trials due a ${label} email`);
    return { sent: 0, skipped: 0, failed: 0 };
  }

  console.log(`📧 Sending ${label} emails to ${orgs.length} organisation(s)`);

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

    const result = await sendCustomerEmail(email, subject, buildBody({ name: org.name }), org.name || 'Customer');

    await logEmail({
      organisationId: org.id,
      recipientEmail: email,
      recipientName: org.name,
      subject,
      emailType,
      status: result.success ? 'sent' : 'failed',
      error: result.error,
    });

    if (result.success) {
      const { error: updateErr } = await supabase
        .from('organisations')
        .update({ [dedupeColumn]: new Date().toISOString() })
        .eq('id', org.id);
      if (updateErr) {
        console.error(`   ⚠️  Email sent but failed to stamp ${dedupeColumn} for ${org.name}:`, updateErr.message);
      }
      sent++;
    } else {
      failed++;
    }
  }

  console.log(`   ✅ ${label} emails: ${sent} sent, ${skipped} skipped, ${failed} failed`);
  return { sent, skipped, failed };
}

async function processEarlyWarnings() {
  return processWarningStage({
    windowMinDays: EARLY_WARNING_WINDOW_MIN_DAYS,
    windowMaxDays: EARLY_WARNING_WINDOW_MAX_DAYS,
    dedupeColumn: 'free_trial_unused_warning_sent_at',
    emailType: 'free_trial_unused_reminder',
    subject: "Haven't tried your Open Word free trial yet?",
    buildBody: buildEarlyNudgeEmailBody,
    label: 'never-used-trial early nudge',
  });
}

async function processFinalWarnings() {
  return processWarningStage({
    windowMinDays: FINAL_WARNING_WINDOW_MIN_DAYS,
    windowMaxDays: FINAL_WARNING_WINDOW_MAX_DAYS,
    dedupeColumn: 'free_trial_final_warning_sent_at',
    emailType: 'free_trial_final_warning',
    subject: 'Your Open Word trial will be removed soon',
    buildBody: buildFinalWarningEmailBody,
    label: 'never-used-trial final warning',
  });
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
    const earlyWarningResult = await processEarlyWarnings();
    const finalWarningResult = await processFinalWarnings();
    const deletionResult = await processDeletions();

    if (earlyWarningResult.failed > 0 || finalWarningResult.failed > 0 || deletionResult.failed > 0) {
      await sendWarningAlert(
        'Free-trial cleanup failures',
        `<p>${earlyWarningResult.failed} early warning email(s), ${finalWarningResult.failed} final warning email(s), and ${deletionResult.failed} deletion(s) failed. Check dashboard logs for details.</p>`
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
