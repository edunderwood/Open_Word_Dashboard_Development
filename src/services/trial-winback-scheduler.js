/**
 * Trial-ended win-back scheduler
 *
 * Daily cron that finds organisations whose free trial ended recently WITHOUT
 * converting to a paying subscription (3–30 days ago, never paid, not active),
 * and sends them a one-off win-back email: it shows their remaining credit
 * balance, invites them to reactivate and claim those credits, and asks the main
 * reason they didn't continue. Stamps winback_sent_at on success so it only ever
 * sends once per organisation.
 *
 * Mirrors trial-reminder-scheduler.js.
 */

import cron from 'node-cron';
import { supabase } from './supabase.js';
import { sendCustomerEmail, sendWarningAlert } from './email.js';

let isRunning = false;

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@openword.live';
const CONTROL_URL = (process.env.OPENWORD_SERVER_URL || 'https://server.openword.live') + '/login';

const DAY_MS = 24 * 60 * 60 * 1000;

function formatCredits(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function buildEmailBody({ name, trialEndsAt, credits }) {
  const friendlyDate = new Date(trialEndsAt).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const creditsLine = credits > 0
    ? `<p>You still have <strong>${formatCredits(credits)} credits</strong> available — they don't expire, and you can claim them by reactivating your account.</p>`
    : '';

  return `
    <p>Hi ${name || 'there'},</p>

    <p>Your Open Word free trial ended on <strong>${friendlyDate}</strong>.</p>

    ${creditsLine}

    <p>You can reactivate your account at any time and pick up right where you left off:</p>
    <p style="text-align: center;">
      <a href="${CONTROL_URL}" class="button">Reactivate my account</a>
    </p>

    <p>Before you go — we'd really value your feedback. <strong>What was the main
    reason you didn't continue with Open Word?</strong> Just reply to this email and
    let us know; it genuinely helps us improve.</p>

    <p>Thanks for giving Open Word a try,<br>
    The Open Word Team</p>

    <p style="font-size: 12px; color: #6b7280;">Any questions? Write to
    <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
  `;
}

async function processTrialWinbacks() {
  if (isRunning) {
    console.log('⏳ Trial win-back scheduler already running, skipping...');
    return;
  }
  isRunning = true;

  try {
    // Trials that ended 3–30 days ago, never paid, not currently active, not yet emailed.
    const { data: orgs, error } = await supabase
      .from('organisations')
      .select('id, name, user_id, trial_ends_at, email_opt_out')
      .gte('trial_ends_at', new Date(Date.now() - 30 * DAY_MS).toISOString())
      .lte('trial_ends_at', new Date(Date.now() - 3 * DAY_MS).toISOString())
      .is('payment_completed_at', null)
      .not('subscription_status', 'in', '(active,past_due)')
      .is('winback_sent_at', null);

    if (error) throw error;

    if (!orgs || orgs.length === 0) {
      console.log('   No trial win-backs due (no lapsed, non-converted trials)');
      return;
    }

    console.log(`📧 Sending trial win-back emails to ${orgs.length} organisation(s)`);

    // Batch-fetch credit balances for the candidate orgs.
    const creditMap = {};
    const ids = orgs.map(o => o.id);
    const { data: balances } = await supabase
      .from('credit_balances')
      .select('organisation_id, current_balance')
      .in('organisation_id', ids);
    balances?.forEach(b => {
      creditMap[b.organisation_id] = parseFloat(b.current_balance) || 0;
    });

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const org of orgs) {
      if (org.email_opt_out) {
        skipped++;
        continue;
      }
      if (!org.user_id) {
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

      const credits = creditMap[org.id] || 0;
      const subject = credits > 0
        ? `Your Open Word trial has ended — your ${formatCredits(credits)} credits are still available`
        : 'Your Open Word trial has ended — reactivate anytime';

      const result = await sendCustomerEmail(
        email,
        subject,
        buildEmailBody({ name: org.name, trialEndsAt: org.trial_ends_at, credits }),
        org.name || 'Customer'
      );

      if (result.success) {
        const { error: updateErr } = await supabase
          .from('organisations')
          .update({ winback_sent_at: new Date().toISOString() })
          .eq('id', org.id);
        if (updateErr) {
          console.error(`   ⚠️  Email sent but failed to stamp win-back for ${org.name}:`, updateErr.message);
        }
        sent++;
      } else {
        failed++;
      }
    }

    console.log(`   ✅ Trial win-backs: ${sent} sent, ${skipped} skipped, ${failed} failed`);

    if (failed > 0) {
      await sendWarningAlert(
        'Trial win-back send failures',
        `<p>${failed} of ${orgs.length} trial win-back emails failed to send. Check dashboard logs for details.</p>`
      );
    }
  } catch (error) {
    console.error('❌ Trial win-back scheduler error:', error);
  } finally {
    isRunning = false;
  }
}

export function startTrialWinbackScheduler() {
  console.log('📅 Starting trial win-back scheduler (runs daily at 9:00 AM UTC)');

  cron.schedule('0 9 * * *', async () => {
    console.log('\n⏰ Trial win-back scheduler triggered at', new Date().toISOString());
    await processTrialWinbacks();
  });

  // Catch up on startup in case the server was down at 9:00 AM
  setTimeout(async () => {
    console.log('\n🚀 Running initial trial win-back check...');
    await processTrialWinbacks();
  }, 20000);
}

export default { startTrialWinbackScheduler };
