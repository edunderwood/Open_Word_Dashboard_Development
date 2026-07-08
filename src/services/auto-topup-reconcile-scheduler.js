/**
 * Auto top-up reconcile scheduler.
 *
 * Once a day, asks the Control Panel to reconcile automatic top-ups: recover any
 * charge that succeeded but wasn't credited, and clear stale 'pending' state.
 * All credit writes stay in the Control Panel; this only triggers the run via a
 * protected internal endpoint. Mirrors trial-winback-scheduler.js.
 */

import cron from 'node-cron';

const CONTROL_URL = process.env.OPENWORD_SERVER_URL || 'https://server.openword.live';
const SECRET = process.env.INTERNAL_API_SECRET;

async function runReconcile() {
  if (!SECRET) {
    console.warn('⚠️ Auto top-up reconcile skipped: INTERNAL_API_SECRET not set');
    return;
  }
  try {
    const res = await fetch(`${CONTROL_URL}/api/credits/reconcile-autotopup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': SECRET },
    });
    const data = await res.json().catch(() => ({}));
    console.log('🔁 Auto top-up reconcile result:', JSON.stringify(data));
  } catch (e) {
    console.error('❌ Auto top-up reconcile call failed:', e.message);
  }
}

export function startAutoTopupReconcileScheduler() {
  console.log('📅 Starting auto top-up reconcile scheduler (runs daily at 10:00 AM UTC)');
  cron.schedule('0 10 * * *', async () => {
    console.log('\n⏰ Auto top-up reconcile triggered at', new Date().toISOString());
    await runReconcile();
  });
  // Catch up shortly after startup
  setTimeout(runReconcile, 25000);
}

export default { startAutoTopupReconcileScheduler };
