/**
 * Helpers for Supabase/PostgREST size limits (mirrors
 * Open_Word_Control_Panel/db/supabase-pagination.js).
 *
 * 1. Reads: PostgREST returns at most 1000 rows per request, silently - no
 *    error, just a truncated result. Any query that can match more than that
 *    must be paged with .range(). translation_usage gains ~38k rows a month.
 * 2. Writes/filters with `.in(column, ids)`: the ids go in the URL, and a few
 *    hundred UUIDs exceed the API gateway's URL limit (400). Chunk them.
 */

const PAGE_SIZE = 1000;
export const ID_CHUNK_SIZE = 100;

/**
 * Fetch every row matching a query, page by page.
 * @param {() => object} buildQuery - returns a FRESH query each call, with a
 *   deterministic .order() (e.g. .order('id')) so pages neither overlap nor skip.
 * @returns {Promise<{data: Array|null, error: object|null}>}
 */
export async function fetchAllRows(buildQuery) {
  const all = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
    if (error) return { data: null, error };
    if (data && data.length) all.push(...data);
    if (!data || data.length < PAGE_SIZE) break;
  }
  return { data: all, error: null };
}

export function chunkArray(items, size = ID_CHUNK_SIZE) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
