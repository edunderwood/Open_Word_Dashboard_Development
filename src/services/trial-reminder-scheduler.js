/**
 * Trial-ending reminder scheduler
 *
 * Daily cron that finds organisations whose free trial ends in roughly one
 * week (now+6d to now+8d) and have not yet been reminded, then sends them a
 * friendly reminder email. Stamps trial_reminder_sent_at on success so a
 * second cron tick (or the Stripe trial_will_end webhook in the control
 * panel) does not double-send.
 */

import cron from 'node-cron';
import { supabase } from './supabase.js';
import { sendCustomerEmail, sendWarningAlert } from './email.js';

let isRunning = false;

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@openword.live';
const LOGIN_URL = (process.env.OPENWORD_SERVER_URL || 'https://server.openword.live') + '/login';

function buildEmailBody({ name, daysRemaining, trialEndsAt, tier }) {
  const friendlyDate = new Date(trialEndsAt).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const tierLabel = tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : 'paid';

  return `
    <p>Hi ${name || 'there'},</p>

    <p>This is a friendly reminder that your Open Word free trial ends
    <strong>in ${daysRemaining} days</strong> (${friendlyDate}).</p>

    <p>When the trial ends, your subscription will automatically continue
    on the <strong>${tierLabel}</strong> plan and your card on file will be
    charged. You don't need to do anything if you'd like to keep using Open
    Word — everything carries on as normal.</p>

    <p>If you'd like to make any changes before then, just log in:</p>
    <p style="text-align: center;">
      <a href="${LOGIN_URL}" class="button">Open Word Control Panel</a>
    </p>

    <ul>
      <li><strong>Change plan:</strong> Settings → Billing</li>
      <li><strong>Update payment method:</strong> Settings → Billing</li>
      <li><strong>Cancel:</strong> Purchase Credits modal → "Cancel Subscription"</li>
    </ul>

    <p>Any questions, just reply to this email or write to
    <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> — we're happy to help.</p>

    <p>Thanks for trying Open Word,<br>
    The Open Word Team</p>
  `;
}

async function processTrialReminders() {
  if (isRunning) {
    console.log('⏳ Trial reminder scheduler already running, skipping...');
    return;
  }
  isRunning = true;

  try {
    const { data: orgs, error } = await supabase
      .from('organisations')
      .select('id, name, user_id, trial_ends_at, subscription_tier, email_opt_out')
      .gte('trial_ends_at', new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString())
      .lte('trial_ends_at', new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString())
      .is('trial_reminder_sent_at', null);

    if (error) throw error;

    if (!orgs || orgs.length === 0) {
      console.log('   No trial reminders due in the 6–8 day window');
      return;
    }

    console.log(`📧 Sending trial-ending reminders to ${orgs.length} organisation(s)`);

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

      const trialEnd = new Date(org.trial_ends_at);
      const daysRemaining = Math.max(1, Math.round((trialEnd - Date.now()) / (24 * 60 * 60 * 1000)));

      const result = await sendCustomerEmail(
        email,
        `Your Open Word free trial ends in ${daysRemaining} days`,
        buildEmailBody({
          name: org.name,
          daysRemaining,
          trialEndsAt: org.trial_ends_at,
          tier: org.subscription_tier,
        }),
        org.name || 'Customer'
      );

      if (result.success) {
        const { error: updateErr } = await supabase
          .from('organisations')
          .update({ trial_reminder_sent_at: new Date().toISOString() })
          .eq('id', org.id);
        if (updateErr) {
          console.error(`   ⚠️  Email sent but failed to stamp reminder for ${org.name}:`, updateErr.message);
        }
        sent++;
      } else {
        failed++;
      }
    }

    console.log(`   ✅ Trial reminders: ${sent} sent, ${skipped} skipped, ${failed} failed`);

    if (failed > 0) {
      await sendWarningAlert(
        'Trial reminder send failures',
        `<p>${failed} of ${orgs.length} trial reminder emails failed to send. Check dashboard logs for details.</p>`
      );
    }
  } catch (error) {
    console.error('❌ Trial reminder scheduler error:', error);
  } finally {
    isRunning = false;
  }
}

export function startTrialReminderScheduler() {
  console.log('📅 Starting trial reminder scheduler (runs daily at 8:00 AM UTC)');

  cron.schedule('0 8 * * *', async () => {
    console.log('\n⏰ Trial reminder scheduler triggered at', new Date().toISOString());
    await processTrialReminders();
  });

  // Catch up on startup in case the server was down at 8:00 AM
  setTimeout(async () => {
    console.log('\n🚀 Running initial trial reminder check...');
    await processTrialReminders();
  }, 15000);
}

export default { startTrialReminderScheduler };
