/**
 * Setup reminder scheduler
 *
 * People who create a login and confirm their email but never fill in their
 * organisation details stop one step before the pending-payment reminders
 * can reach them (those need an organisation row). Daily cron that sends two
 * gentle "finish setting up" emails:
 *   1st - at least 1 day after sign-up
 *   2nd - at least 7 days after sign-up and 3+ days after the 1st
 * Only logins created in the last 30 days and with a confirmed email. Never
 * emails anyone who has an organisation, is an enterprise user or is a
 * Dashboard admin. There's no organisation row to stamp, so each send is
 * recorded on the login's app_metadata (setup_reminder_{1,2}_sent_at); the
 * email_log type comes from Control Panel migrations/add-setup-reminder-email-type.sql.
 */
import cron from 'node-cron';
import { supabase } from './supabase.js';
import { fetchAllRows } from './pagination.js';
import { sendCustomerEmail, sendWarningAlert, logEmail } from './email.js';

let isRunning = false;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_DAYS = 30;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@openword.live';
const LOGIN_URL = (process.env.OPENWORD_SERVER_URL || 'https://server.openword.live') + '/login';

function buildEmailBody({ final }) {
  return `
    <p>Hi there,</p>
    ${final
      ? `<p>Just a final, gentle reminder: you confirmed your email for Open Word, but your organisation hasn't been set up yet, so you can't start a live translation session.</p>`
      : `<p>Thanks for signing up to Open Word and confirming your email. The next step, setting up your organisation, hasn't been completed yet, so you can't start a live translation session.</p>`}
    <p>It only takes a couple of minutes: your organisation's name, the language you speak in, and the languages you'd like to offer. Log in and you'll pick up where you left off:</p>
    <p style="text-align: center;">
      <a href="${LOGIN_URL}" class="button">Finish setting up Open Word</a>
    </p>
    <p>If you got stuck or have a question, just reply to this email or write to
    <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> and we'll help.${final ? ' If you’ve decided Open Word isn’t for you, no action is needed and we won’t send any more reminders.' : ''}</p>
    <p>Thanks,<br>
    The Open Word Team</p>
  `;
}

// Every login created in the window (the admin API pages at up to 1000)
async function listRecentUsers(sinceMs) {
  const users = [];
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const batch = data?.users || [];
    users.push(...batch.filter(u => new Date(u.created_at).getTime() >= sinceMs));
    if (batch.length < 1000) break;
  }
  return users;
}

/**
 * @param {{ dryRun?: boolean }} options - dryRun: log what would be sent, send/stamp nothing
 * @returns {Promise<{sent:number, skipped:number, failed:number, planned:Array}>}
 */
export async function processSetupReminders({ dryRun = false } = {}) {
  if (isRunning) {
    console.log('⏳ Setup reminder scheduler already running, skipping...');
    return { sent: 0, skipped: 0, failed: 0, planned: [] };
  }
  isRunning = true;
  const summary = { sent: 0, skipped: 0, failed: 0, planned: [] };

  try {
    const now = Date.now();
    const users = (await listRecentUsers(now - MAX_AGE_DAYS * DAY_MS))
      .filter(u => u.email && u.email_confirmed_at && new Date(u.created_at).getTime() <= now - DAY_MS)
      .filter(u => !u.app_metadata?.setup_reminder_2_sent_at);
    if (users.length === 0) {
      console.log(`   ✅ Setup reminders${dryRun ? ' (DRY RUN)' : ''}: nothing due`);
      return summary;
    }

    // Anyone already attached to an organisation, enterprise or the Dashboard is not a stalled sign-up
    const [orgs, entUsers, admins] = await Promise.all([
      fetchAllRows(() => supabase.from('organisations').select('id, user_id').order('id')),
      fetchAllRows(() => supabase.from('enterprise_users').select('id, auth_user_id').order('id')),
      supabase.from('dashboard_admins').select('user_id, email'),
    ]);
    if (orgs.error) throw orgs.error;
    if (entUsers.error) throw entUsers.error;
    const linked = new Set([
      ...(orgs.data || []).map(o => o.user_id),
      ...(entUsers.data || []).map(e => e.auth_user_id),
      ...((admins.data || []).map(a => a.user_id)),
    ].filter(Boolean));
    const adminEmails = new Set((admins.data || []).map(a => (a.email || '').toLowerCase()).filter(Boolean));

    for (const user of users) {
      if (linked.has(user.id) || adminEmails.has(user.email.toLowerCase())) {
        summary.skipped++;
        continue;
      }

      const ageDays = (now - new Date(user.created_at).getTime()) / DAY_MS;
      const r1 = user.app_metadata?.setup_reminder_1_sent_at;
      let which = null;
      if (!r1) {
        which = 1;
      } else if (ageDays >= 7 && now - new Date(r1).getTime() >= 3 * DAY_MS) {
        which = 2;
      }
      if (!which) continue;

      const subject = which === 1
        ? 'Finish setting up your Open Word account'
        : 'Reminder: your Open Word account is almost ready';
      summary.planned.push({ email: user.email, reminder: which, ageDays: Math.floor(ageDays) });
      if (dryRun) continue;

      // Re-check right before sending - they may have set up an organisation since
      const { data: freshOrg } = await supabase.from('organisations').select('id').eq('user_id', user.id).maybeSingle();
      if (freshOrg) {
        summary.skipped++;
        continue;
      }

      const result = await sendCustomerEmail(user.email, subject, buildEmailBody({ final: which === 2 }), 'there');
      await logEmail({
        recipientEmail: user.email,
        subject,
        emailType: 'setup_reminder',
        status: result.success ? 'sent' : 'failed',
        error: result.error,
      });

      if (result.success) {
        const key = which === 1 ? 'setup_reminder_1_sent_at' : 'setup_reminder_2_sent_at';
        const { error: updateErr } = await supabase.auth.admin.updateUserById(user.id, {
          app_metadata: { ...(user.app_metadata || {}), [key]: new Date().toISOString() },
        });
        if (updateErr) {
          console.error(`   ⚠️  Email sent but failed to record setup reminder ${which} for ${user.email}:`, updateErr.message);
        }
        summary.sent++;
      } else {
        summary.failed++;
      }
    }

    console.log(`   ✅ Setup reminders${dryRun ? ' (DRY RUN)' : ''}: ${summary.planned.length} due, ${summary.sent} sent, ${summary.skipped} skipped, ${summary.failed} failed`);
    if (summary.failed > 0) {
      await sendWarningAlert(
        'Setup reminder send failures',
        `<p>${summary.failed} setup reminder email(s) failed to send. Check dashboard logs for details.</p>`
      );
    }
  } catch (error) {
    console.error('❌ Setup reminder scheduler error:', error);
  } finally {
    isRunning = false;
  }
  return summary;
}

export function startSetupReminderScheduler() {
  console.log('📅 Starting setup reminder scheduler (runs daily at 9:30 AM UTC)');
  cron.schedule('30 9 * * *', async () => {
    console.log('\n⏰ Setup reminder scheduler triggered at', new Date().toISOString());
    await processSetupReminders();
  });
  // Catch up on startup in case the server was down at 9:30 AM
  setTimeout(async () => {
    console.log('\n🚀 Running initial setup reminder check...');
    await processSetupReminders();
  }, 25000);
}

export default { startSetupReminderScheduler, processSetupReminders };
