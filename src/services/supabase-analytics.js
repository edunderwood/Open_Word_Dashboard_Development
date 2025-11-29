/**
 * Supabase Analytics Service
 * Fetches database metrics and usage statistics from Supabase
 */

import { supabase } from './supabase.js';

/**
 * Get Supabase database analytics
 * @param {number} days - Number of days to look back
 */
export async function getSupabaseAnalytics(days = 30) {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    // Fetch all stats in parallel
    const [
      organisationsResult,
      servicesResult,
      usageResult,
      recentUsageResult,
      sessionsResult,
      feedbackResult
    ] = await Promise.all([
      // Total organisations count
      supabase.from('organisations').select('id, created_at, subscription_status', { count: 'exact' }),

      // Total services count
      supabase.from('services').select('id, status, created_at', { count: 'exact' }),

      // Usage statistics for period
      supabase.from('translation_usage')
        .select('character_count, language, type, created_at')
        .gte('created_at', startDate),

      // Recent usage (last 24 hours) for activity check
      supabase.from('translation_usage')
        .select('id, created_at')
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),

      // Sessions count
      supabase.from('sessions').select('id', { count: 'exact' }),

      // Feedback count
      supabase.from('feedback').select('id, rating, created_at', { count: 'exact' })
        .gte('created_at', startDate)
    ]);

    // Process organisations
    const organisations = organisationsResult.data || [];
    const totalOrganisations = organisationsResult.count || 0;
    const activeOrganisations = organisations.filter(o => o.subscription_status === 'active' || o.subscription_status === 'trialing').length;
    const newOrganisations = organisations.filter(o => new Date(o.created_at) >= new Date(startDate)).length;

    // Process services
    const services = servicesResult.data || [];
    const totalServices = servicesResult.count || 0;
    const activeServices = services.filter(s => s.status === 'active').length;

    // Process usage
    const usage = usageResult.data || [];
    const totalCharacters = usage.reduce((sum, u) => sum + (u.character_count || 0), 0);
    const totalRecords = usage.length;

    // Group by type (transcript vs translation)
    const transcriptChars = usage.filter(u => u.type === 'transcript').reduce((sum, u) => sum + (u.character_count || 0), 0);
    const translationChars = usage.filter(u => u.type === 'translation').reduce((sum, u) => sum + (u.character_count || 0), 0);

    // Group by language
    const byLanguage = {};
    usage.forEach(u => {
      if (u.language) {
        byLanguage[u.language] = (byLanguage[u.language] || 0) + (u.character_count || 0);
      }
    });

    // Sort languages by usage
    const topLanguages = Object.entries(byLanguage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([lang, chars]) => ({ language: lang, characters: chars }));

    // Recent activity
    const recentUsage = recentUsageResult.data || [];
    const last24hRecords = recentUsage.length;

    // Sessions
    const totalSessions = sessionsResult.count || 0;

    // Feedback
    const feedback = feedbackResult.data || [];
    const totalFeedback = feedbackResult.count || 0;
    const avgRating = feedback.length > 0
      ? (feedback.reduce((sum, f) => sum + (f.rating || 0), 0) / feedback.length).toFixed(1)
      : 'N/A';

    // Calculate daily averages
    const avgDailyCharacters = Math.round(totalCharacters / days);
    const avgDailyRecords = Math.round(totalRecords / days);

    // Health indicators
    const warnings = [];

    if (last24hRecords === 0) {
      warnings.push({
        level: 'warning',
        message: 'No usage records in the last 24 hours'
      });
    }

    if (activeOrganisations === 0) {
      warnings.push({
        level: 'warning',
        message: 'No active organisations'
      });
    }

    return {
      success: true,
      data: {
        period: { days },
        summary: {
          totalOrganisations,
          activeOrganisations,
          newOrganisations,
          totalServices,
          activeServices,
          totalSessions,
          totalFeedback,
          avgRating
        },
        usage: {
          totalCharacters,
          totalRecords,
          transcriptChars,
          translationChars,
          avgDailyCharacters,
          avgDailyRecords,
          last24hRecords
        },
        topLanguages,
        warnings,
        errors: {
          organisations: organisationsResult.error?.message,
          services: servicesResult.error?.message,
          usage: usageResult.error?.message
        }
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Get database connection health check
 */
export async function checkSupabaseHealth() {
  try {
    const start = Date.now();
    const { data, error } = await supabase.from('organisations').select('id').limit(1);
    const latency = Date.now() - start;

    if (error) {
      return {
        healthy: false,
        latency: null,
        error: error.message
      };
    }

    return {
      healthy: true,
      latency,
      status: latency < 200 ? 'good' : latency < 500 ? 'slow' : 'degraded'
    };
  } catch (error) {
    return {
      healthy: false,
      latency: null,
      error: error.message
    };
  }
}

export default {
  getSupabaseAnalytics,
  checkSupabaseHealth
};
