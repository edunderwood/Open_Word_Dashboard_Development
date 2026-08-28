/**
 * Azure Speech (AI Voice) Analytics Service
 *
 * Unlike Deepgram (which exposes a project-level usage API via the same API
 * key) or Google Cloud (via Cloud Monitoring with service-account
 * credentials), Azure Speech has no simple usage endpoint reachable with the
 * Speech subscription key alone - real usage/cost reporting requires the
 * Azure Cost Management API, which needs a separate Azure AD app
 * registration/service principal we don't have configured. Rather than wait
 * on that infrastructure work, this derives usage directly from our own
 * `tts_usage` table (populated by every real synthesis call in the Control
 * Panel's src/services/tts.js) - the same "derive from our own DB" pattern
 * supabase-analytics.js already uses for Supabase, and it's actually more
 * precise than Azure's own billing for our purposes since it's exactly what
 * we sent them, not an estimate.
 */

import { supabase } from './supabase.js';

// AI Voice is billed at the same rate as text translation (1 credit per
// 21,000 characters - see db/credits.js CHARS_PER_CREDIT in the Control
// Panel repo) and the base credit price (see reference_openword_credit_pricing).
const CHARS_PER_CREDIT = 21000;
const CREDIT_PRICE_GBP = 1.22;

/**
 * Get Azure Speech (AI Voice) usage analytics, derived from tts_usage.
 * @param {number} days - Number of days to look back
 */
export async function getAzureAnalytics(days = 30) {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  try {
    const [usageResult, recentUsageResult, orgsResult] = await Promise.all([
      supabase.from('tts_usage')
        .select('organisation_id, language, character_count, created_at')
        .gte('created_at', startDate),

      supabase.from('tts_usage')
        .select('id, created_at')
        .gte('created_at', last24h),

      // ai_audio_enabled is nullable - NULL means "use the tier default", not
      // "disabled" (see src/translate.js in the Control Panel repo:
      // org.ai_audio_enabled ?? tierConfig.aiAudioEnabled). A plain
      // .eq('ai_audio_enabled', true) undercounts every org relying on that
      // fallback (e.g. Enterprise-tier orgs, which default to enabled but
      // commonly have the column unset) - fetch tier alongside the flag and
      // resolve the same way the real gating logic does.
      supabase.from('organisations')
        .select('id, ai_audio_enabled, subscription_tier')
    ]);

    if (usageResult.error) throw usageResult.error;
    if (orgsResult.error) throw orgsResult.error;

    // Mirrors db/tiers.js's DEFAULT_TIERS aiAudioEnabled values (Control Panel
    // repo): false only for basic, true for everything else.
    const TIER_DEFAULT_AI_AUDIO_ENABLED = { basic: false };
    const orgsEnabled = (orgsResult.data || []).filter(org => {
      if (org.ai_audio_enabled != null) return org.ai_audio_enabled;
      return TIER_DEFAULT_AI_AUDIO_ENABLED[org.subscription_tier] ?? true;
    }).length;

    const usage = usageResult.data || [];
    const totalCharacters = usage.reduce((sum, u) => sum + (u.character_count || 0), 0);
    const totalRecords = usage.length;

    const byLanguage = {};
    const byOrg = new Set();
    usage.forEach(u => {
      if (u.language) byLanguage[u.language] = (byLanguage[u.language] || 0) + (u.character_count || 0);
      if (u.organisation_id) byOrg.add(u.organisation_id);
    });

    const topLanguages = Object.entries(byLanguage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([lang, chars]) => ({ language: lang, characters: chars }));

    const recentUsage = recentUsageResult.data || [];
    const last24hRecords = recentUsage.length;

    const activeOrgsWithUsage = byOrg.size;

    const totalCredits = totalCharacters / CHARS_PER_CREDIT;
    const estimatedCostGbp = totalCredits * CREDIT_PRICE_GBP;

    const avgDailyCharacters = Math.round(totalCharacters / days);

    // Informational only, not a page-worthy alert - AI Voice is a low-volume,
    // opt-in feature, so quiet periods are expected and not a health signal
    // the way "no database records at all" would be.
    const warnings = [];
    if (orgsEnabled > 0 && last24hRecords === 0) {
      warnings.push({
        level: 'info',
        message: `${orgsEnabled} org${orgsEnabled === 1 ? '' : 's'} have AI Voice enabled but none used it in the last 24 hours`
      });
    }

    return {
      success: true,
      data: {
        period: { days },
        summary: {
          orgsEnabled,
          activeOrgsWithUsage,
          totalRecords,
          last24hRecords
        },
        usage: {
          totalCharacters,
          totalCredits: Math.round(totalCredits * 10000) / 10000,
          estimatedCostGbp: Math.round(estimatedCostGbp * 100) / 100,
          avgDailyCharacters,
          last24hRecords
        },
        topLanguages,
        warnings
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}
