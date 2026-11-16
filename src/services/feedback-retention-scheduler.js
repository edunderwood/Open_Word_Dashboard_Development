/**
 * Participant feedback retention.
 *
 * The Data Processing Agreement (clause 9) commits to keeping participant
 * feedback for 30 days. Feedback is free text typed by people attending a
 * service, so it can contain personal or sensitive details; nothing else
 * references the feedback table. A daily job deletes anything older than the
 * retention period (FEEDBACK_RETENTION_DAYS, default 30).
 */

import cron from 'node-cron';
import { supabase } from './supabase.js';

export const FEEDBACK_RETENTION_DAYS = parseInt(process.env.FEEDBACK_RETENTION_DAYS || '30', 10);

let isRunning = false;

export async function deleteExpiredFeedback() {
  if (isRunning) return { skipped: true };
  isRunning = true;
  try {
    const cutoff = new Date(Date.now() - FEEDBACK_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { error, count } = await supabase
      .from('feedback')
      .delete({ count: 'exact' })
      .lt('created_at', cutoff);
    if (error) throw error;
    console.log(`🧹 Feedback retention: deleted ${count || 0} feedback entr${count === 1 ? 'y' : 'ies'} older than ${FEEDBACK_RETENTION_DAYS} days`);
    return { deleted: count || 0, cutoff };
  } catch (error) {
    console.error('❌ Feedback retention failed:', error.message);
    return { error: error.message };
  } finally {
    isRunning = false;
  }
}

export function startFeedbackRetentionScheduler() {
  cron.schedule('0 4 * * *', async () => {
    await deleteExpiredFeedback();
  }, { timezone: 'UTC' });
  console.log(`🧹 Feedback retention scheduled (daily at 04:00 UTC, keeps ${FEEDBACK_RETENTION_DAYS} days)`);
}
