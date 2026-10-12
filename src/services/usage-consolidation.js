/**
 * Usage Consolidation Service
 *
 * Consolidates old translation_usage rows to reduce Supabase storage.
 * Runs daily to consolidate sessions older than 60 days.
 *
 * Before: 400+ rows per session (one per transcript/translation chunk)
 * After: 3-5 rows per session (one per language)
 */

import cron from 'node-cron';
import supabase from './supabase.js';
import { fetchAllRows, ID_CHUNK_SIZE } from './pagination.js';

const CONSOLIDATION_AGE_DAYS = 60;
const BATCH_SIZE = 50; // Sessions read per page
const SESSIONS_PER_RUN = 60; // Sessions consolidated per nightly run

// PostgREST limits (see ./pagination.js): reads return at most 1000 rows per
// request, and an `.in('id', ...)` with hundreds of UUIDs makes a URL the
// gateway rejects (400). Found 2026-10-08: every session with >~300 rows
// failed to consolidate, nightly.
const MAX_SESSIONS_SCANNED = 2000; // per run - bounds the work of one night
const MAX_CONSECUTIVE_FAILURES = 3;  // a systemic error (e.g. schema change) stops the run

function aggregateByLanguage(rows) {
  const aggregates = {};
  for (const row of rows) {
    const lang = row.language || 'unknown';
    if (!aggregates[lang]) {
      aggregates[lang] = { character_count: 0, max_client_count: 0, row_count: 0 };
    }
    aggregates[lang].character_count += row.character_count || 0;
    aggregates[lang].max_client_count = Math.max(aggregates[lang].max_client_count, row.client_count || 0);
    aggregates[lang].row_count++;
  }
  return aggregates;
}

/**
 * Consolidate translation_usage rows for old sessions
 * Groups rows by language and creates single summary rows
 */
async function consolidateOldSessions() {
  const startTime = Date.now();

  console.log('\n========================================');
  console.log('📦 USAGE CONSOLIDATION - Starting');
  console.log(`   Age threshold: ${CONSOLIDATION_AGE_DAYS} days`);
  console.log('========================================\n');

  try {
    // Calculate cutoff date
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - CONSOLIDATION_AGE_DAYS);
    const cutoffISO = cutoffDate.toISOString();

    console.log(`📅 Cutoff date: ${cutoffDate.toLocaleDateString()}`);

    let totalConsolidated = 0;
    let sessionsAttempted = 0;
    let consecutiveFailures = 0;
    let totalRowsRemoved = 0;
    let totalRowsCreated = 0;
    let sessionsScanned = 0;

    // Page through old completed sessions (oldest first) until SESSIONS_PER_RUN
    // sessions have actually been consolidated. Previously only the first 50
    // sessions were ever looked at, so once those were done nothing moved on.
    for (let from = 0; sessionsAttempted < SESSIONS_PER_RUN && sessionsScanned < MAX_SESSIONS_SCANNED && consecutiveFailures < MAX_CONSECUTIVE_FAILURES; from += BATCH_SIZE) {
      const { data: sessionsPage, error: sessionsError } = await supabase
        .from('streaming_sessions')
        .select('id, organisation_id, service_id, started_at')
        .in('status', ['completed', 'recovered'])
        .lt('started_at', cutoffISO)
        .order('started_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + BATCH_SIZE - 1);

      if (sessionsError) {
        console.error('❌ Error fetching sessions:', sessionsError);
        throw sessionsError;
      }
      if (!sessionsPage || sessionsPage.length === 0) break;
      sessionsScanned += sessionsPage.length;

      for (const session of sessionsPage) {
        if (sessionsAttempted >= SESSIONS_PER_RUN || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
        try {
          // All unconsolidated rows for this session (paged)
          const { data: unconsolidatedRows, error: checkError } = await fetchAllRows(() => supabase
            .from('translation_usage')
            .select('id, service_id, language, character_count, client_count, date, created_at')
            .eq('session_id', session.id)
            .eq('is_consolidated', false)
            .order('id'));

          if (checkError) {
            console.error(`   ❌ Error checking session ${session.id}:`, checkError.message);
            continue;
          }

          if (!unconsolidatedRows || unconsolidatedRows.length <= 5) {
            // Already consolidated or too few rows to bother
            continue;
          }

          console.log(`   🔄 Consolidating session ${session.id}`);
          console.log(`      Rows to consolidate: ${unconsolidatedRows.length}`);
          sessionsAttempted++;

          const serviceId = session.service_id || unconsolidatedRows.find(r => r.service_id)?.service_id;
          if (!serviceId) {
            console.error(`      ❌ No service_id for session ${session.id} - skipping (translation_usage.service_id is NOT NULL)`);
            consecutiveFailures++;
            continue;
          }

          let sessionDate = null;
          let earliestCreatedAt = null;
          for (const row of unconsolidatedRows) {
            if (!sessionDate && row.date) sessionDate = row.date;
            if (!earliestCreatedAt || row.created_at < earliestCreatedAt) earliestCreatedAt = row.created_at;
          }
          const buildSummary = (rows) => Object.entries(aggregateByLanguage(rows)).map(([lang, agg]) => ({
            organisation_id: session.organisation_id,
            service_id: serviceId,
            session_id: session.id,
            language: lang,
            character_count: agg.character_count,
            client_count: agg.max_client_count,
            date: sessionDate || session.started_at.split('T')[0],
            created_at: earliestCreatedAt || session.started_at,
            is_consolidated: true,
            // These sessions are past the billing window (no back-billing), so
            // reconciliation must never pick summary rows up as new usage.
            credited: true
          }));

          // 1. Save the summary FIRST. If this fails nothing has been deleted,
          //    so no usage history can be lost (the old delete-then-insert
          //    order silently lost rows whenever the insert failed).
          const consolidatedRows = buildSummary(unconsolidatedRows);
          const { data: insertedSummary, error: insertError } = await supabase
            .from('translation_usage')
            .insert(consolidatedRows)
            .select('id, language');

          if (insertError) {
            console.error(`      ❌ Error inserting consolidated rows for session ${session.id} (nothing deleted):`, insertError.message);
            consecutiveFailures++;
            continue;
          }

          // 2. Delete the granular rows in chunks (a single .in() with
          //    hundreds of ids is rejected by the gateway).
          const undeletedRows = [];
          for (let i = 0; i < unconsolidatedRows.length; i += ID_CHUNK_SIZE) {
            const chunk = unconsolidatedRows.slice(i, i + ID_CHUNK_SIZE);
            const { error: deleteError } = await supabase
              .from('translation_usage')
              .delete()
              .in('id', chunk.map(r => r.id));
            if (deleteError) {
              console.error(`      ❌ Error deleting rows (chunk ${i / ID_CHUNK_SIZE + 1}):`, deleteError.message);
              undeletedRows.push(...chunk);
            }
          }

          // 3. If some granular rows couldn't be deleted, shrink the summary to
          //    cover only the rows that WERE deleted, so nothing is counted twice.
          if (undeletedRows.length > 0) {
            const undeletedIds = new Set(undeletedRows.map(r => r.id));
            const deletedOnly = aggregateByLanguage(unconsolidatedRows.filter(r => !undeletedIds.has(r.id)));
            for (const summaryRow of insertedSummary || []) {
              const agg = deletedOnly[summaryRow.language];
              const fix = agg
                ? supabase.from('translation_usage').update({ character_count: agg.character_count, client_count: agg.max_client_count }).eq('id', summaryRow.id)
                : supabase.from('translation_usage').delete().eq('id', summaryRow.id);
              const { error: fixError } = await fix;
              if (fixError) {
                console.error(`      ⚠️ Could not correct summary row ${summaryRow.id} for session ${session.id} - ${undeletedRows.length} rows may be counted twice:`, fixError.message);
              }
            }
            console.warn(`      ⚠️ ${undeletedRows.length} rows left granular after delete errors (summary adjusted to match)`);
          }

          const removed = unconsolidatedRows.length - undeletedRows.length;
          console.log(`      ✅ Consolidated: ${removed} → ${consolidatedRows.length} rows`);

          consecutiveFailures = 0;
          totalConsolidated++;
          totalRowsRemoved += removed;
          totalRowsCreated += consolidatedRows.length;

        } catch (sessionError) {
          console.error(`   ❌ Error processing session ${session.id}:`, sessionError.message);
        }
      }

      if (sessionsPage.length < BATCH_SIZE) break;
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n========================================');
    console.log('📦 USAGE CONSOLIDATION - Complete');
    console.log(`   Sessions scanned: ${sessionsScanned}`);
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error(`   🛑 Stopped early after ${consecutiveFailures} consecutive failures`);
    }
    console.log(`   Sessions consolidated: ${totalConsolidated}`);
    console.log(`   Rows removed: ${totalRowsRemoved}`);
    console.log(`   Rows created: ${totalRowsCreated}`);
    console.log(`   Net reduction: ${totalRowsRemoved - totalRowsCreated} rows`);
    console.log(`   Duration: ${duration}s`);
    console.log('========================================\n');

    return {
      consolidated: totalConsolidated,
      rowsRemoved: totalRowsRemoved,
      rowsCreated: totalRowsCreated
    };

  } catch (error) {
    console.error('❌ Critical error in consolidateOldSessions:', error);
    throw error;
  }
}

/**
 * Start the consolidation cron job
 * Runs daily at 3:00 AM UTC
 */
export function startConsolidationCron() {
  // Run daily at 3:00 AM UTC
  cron.schedule('0 3 * * *', async () => {
    console.log(`\n⏰ Scheduled consolidation triggered at ${new Date().toISOString()}`);
    try {
      await consolidateOldSessions();
    } catch (error) {
      console.error('❌ Scheduled consolidation failed:', error.message);
    }
  });

  console.log('📦 Usage consolidation cron scheduled (daily at 3:00 AM UTC)');
}

/**
 * Run consolidation manually (for testing or immediate cleanup)
 */
export async function runConsolidationNow() {
  return await consolidateOldSessions();
}

export default {
  startConsolidationCron,
  runConsolidationNow
};
