-- Migration: Add usage consolidation support
-- Date: 2026-01-12
-- Purpose: Enable storage reduction by consolidating old translation_usage rows

-- =====================================================
-- 1. Add per-language breakdown to streaming_sessions
-- =====================================================
-- This stores character counts per language for fast reporting
-- Example: {"transcript": 45000, "es-ES": 52000, "fr-FR": 48000}

ALTER TABLE streaming_sessions
ADD COLUMN IF NOT EXISTS characters_per_language JSONB DEFAULT '{}';

COMMENT ON COLUMN streaming_sessions.characters_per_language IS
  'Character counts per language for this session. Keys are language codes (e.g., "es-ES", "transcript"), values are character counts.';

-- =====================================================
-- 2. Add consolidation flag to translation_usage
-- =====================================================
-- Marks rows that have been consolidated (aggregated from many rows into one per language)

ALTER TABLE translation_usage
ADD COLUMN IF NOT EXISTS is_consolidated BOOLEAN DEFAULT false;

COMMENT ON COLUMN translation_usage.is_consolidated IS
  'True if this row is a consolidated summary (one row per language per session). False for granular per-chunk rows.';

-- =====================================================
-- 3. Add indexes for efficient consolidation queries
-- =====================================================

-- Index for finding sessions to consolidate (by date)
CREATE INDEX IF NOT EXISTS idx_streaming_sessions_started_at
ON streaming_sessions(started_at);

-- Index for finding sessions by org and date (for reporting)
CREATE INDEX IF NOT EXISTS idx_streaming_sessions_org_started
ON streaming_sessions(organisation_id, started_at);

-- Index for consolidation queries (find unconsolidated rows by session)
CREATE INDEX IF NOT EXISTS idx_translation_usage_session_consolidated
ON translation_usage(session_id, is_consolidated)
WHERE is_consolidated = false;

-- =====================================================
-- 4. Backfill characters_per_language for existing sessions
-- =====================================================
-- This populates the new field for sessions that already have translation_usage data

UPDATE streaming_sessions ss
SET characters_per_language = COALESCE(
  (
    SELECT jsonb_object_agg(language, total_chars)
    FROM (
      SELECT
        tu.language,
        SUM(tu.character_count) as total_chars
      FROM translation_usage tu
      WHERE tu.session_id = ss.id
      GROUP BY tu.language
    ) lang_totals
  ),
  '{}'::jsonb
)
WHERE ss.characters_per_language = '{}'::jsonb
  AND ss.status IN ('completed', 'recovered')
  AND EXISTS (
    SELECT 1 FROM translation_usage tu WHERE tu.session_id = ss.id
  );

-- =====================================================
-- 5. Grant permissions (if using RLS)
-- =====================================================
-- Service role needs access for consolidation job

-- No additional grants needed - service role has full access

-- =====================================================
-- Verification queries (run manually after migration)
-- =====================================================

-- Check sessions with populated characters_per_language:
-- SELECT id, started_at, characters_per_language
-- FROM streaming_sessions
-- WHERE characters_per_language != '{}'::jsonb
-- LIMIT 10;

-- Check translation_usage consolidation flag:
-- SELECT is_consolidated, COUNT(*)
-- FROM translation_usage
-- GROUP BY is_consolidated;
