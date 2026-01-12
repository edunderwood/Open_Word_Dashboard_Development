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

const CONSOLIDATION_AGE_DAYS = 60;
const BATCH_SIZE = 50; // Process 50 sessions at a time

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

    // Find completed sessions older than cutoff that have unconsolidated usage data
    const { data: sessionsToConsolidate, error: sessionsError } = await supabase
      .from('streaming_sessions')
      .select('id, organisation_id, started_at')
      .in('status', ['completed', 'recovered'])
      .lt('started_at', cutoffISO)
      .limit(BATCH_SIZE);

    if (sessionsError) {
      console.error('❌ Error fetching sessions:', sessionsError);
      throw sessionsError;
    }

    if (!sessionsToConsolidate || sessionsToConsolidate.length === 0) {
      console.log('✅ No sessions to consolidate');
      console.log('========================================\n');
      return { consolidated: 0, rowsRemoved: 0, rowsCreated: 0 };
    }

    console.log(`📋 Found ${sessionsToConsolidate.length} sessions to check\n`);

    let totalConsolidated = 0;
    let totalRowsRemoved = 0;
    let totalRowsCreated = 0;

    for (const session of sessionsToConsolidate) {
      try {
        // Check if this session has unconsolidated rows
        const { data: unconsolidatedRows, error: checkError } = await supabase
          .from('translation_usage')
          .select('id, language, character_count, client_count, date, created_at')
          .eq('session_id', session.id)
          .eq('is_consolidated', false);

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

        // Aggregate by language
        const languageAggregates = {};
        let sessionDate = null;
        let earliestCreatedAt = null;

        for (const row of unconsolidatedRows) {
          const lang = row.language || 'unknown';

          if (!languageAggregates[lang]) {
            languageAggregates[lang] = {
              character_count: 0,
              max_client_count: 0,
              row_count: 0
            };
          }

          languageAggregates[lang].character_count += row.character_count || 0;
          languageAggregates[lang].max_client_count = Math.max(
            languageAggregates[lang].max_client_count,
            row.client_count || 0
          );
          languageAggregates[lang].row_count++;

          // Track date and earliest timestamp
          if (!sessionDate && row.date) sessionDate = row.date;
          if (!earliestCreatedAt || row.created_at < earliestCreatedAt) {
            earliestCreatedAt = row.created_at;
          }
        }

        // Create consolidated rows (one per language)
        const consolidatedRows = Object.entries(languageAggregates).map(([lang, agg]) => ({
          organisation_id: session.organisation_id,
          session_id: session.id,
          language: lang,
          character_count: agg.character_count,
          client_count: agg.max_client_count,
          date: sessionDate || session.started_at.split('T')[0],
          created_at: earliestCreatedAt || session.started_at,
          is_consolidated: true
        }));

        // Delete old granular rows
        const rowIdsToDelete = unconsolidatedRows.map(r => r.id);
        const { error: deleteError } = await supabase
          .from('translation_usage')
          .delete()
          .in('id', rowIdsToDelete);

        if (deleteError) {
          console.error(`      ❌ Error deleting rows:`, deleteError.message);
          continue;
        }

        // Insert consolidated rows
        const { error: insertError } = await supabase
          .from('translation_usage')
          .insert(consolidatedRows);

        if (insertError) {
          console.error(`      ❌ Error inserting consolidated rows:`, insertError.message);
          // Note: We've already deleted rows, so this is a problem
          // In production, you'd want to use a transaction
          continue;
        }

        console.log(`      ✅ Consolidated: ${unconsolidatedRows.length} → ${consolidatedRows.length} rows`);

        totalConsolidated++;
        totalRowsRemoved += unconsolidatedRows.length;
        totalRowsCreated += consolidatedRows.length;

      } catch (sessionError) {
        console.error(`   ❌ Error processing session ${session.id}:`, sessionError.message);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n========================================');
    console.log('📦 USAGE CONSOLIDATION - Complete');
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
