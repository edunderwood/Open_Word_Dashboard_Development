/**
 * Participant Feedback Routes (admin dashboard)
 *
 * Lists the feedback participants send from the participant app's Feedback
 * option (stored in the `feedback` table by the control-panel server). Each
 * organisation can only see its own in the control panel ("View Feedback");
 * this is the cross-customer view for admins.
 */
import express from 'express';
import supabase from '../services/supabase.js';
import { fetchAllRows, chunkArray } from '../services/pagination.js';

const router = express.Router();

/**
 * GET /api/feedback?org=<organisation id>&days=<30|90|365|all>&q=<text>
 * Feedback newest first, with organisation and language names, plus the list
 * of organisations that have feedback (for the filter).
 */
router.get('/', async (req, res) => {
  try {
    const { org, q } = req.query;
    const days = req.query.days === 'all' ? null : Math.max(1, parseInt(req.query.days, 10) || 365);
    const search = typeof q === 'string' ? q.trim().slice(0, 200) : '';

    const { data: rows, error } = await fetchAllRows(() => {
      let query = supabase
        .from('feedback')
        .select('id, created_at, organisation_id, service_id, user_language, feedback_text')
        .order('created_at', { ascending: false })
        .order('id', { ascending: true });
      if (org) query = query.eq('organisation_id', org);
      if (days) query = query.gte('created_at', new Date(Date.now() - days * 86400000).toISOString());
      if (search) query = query.ilike('feedback_text', `%${search.replace(/[%_\\]/g, (c) => '\\' + c)}%`);
      return query;
    });
    if (error) throw error;

    // Older feedback can lack organisation_id but still carry the service ID -
    // resolve the owning organisation from services / Pro session slots /
    // enterprise bookings (display only; the stored row is not changed).
    const missingServiceIds = [...new Set(rows.filter((r) => !r.organisation_id && r.service_id).map((r) => String(r.service_id)))];
    const orgByService = {};
    for (const table of ['services', 'organisation_sessions', 'enterprise_sessions']) {
      const pending = missingServiceIds.filter((id) => !orgByService[id]);
      if (pending.length === 0) break;
      const { data: found } = await supabase.from(table).select('service_id, organisation_id').in('service_id', pending);
      (found || []).forEach((f) => { if (f.organisation_id) orgByService[String(f.service_id)] = f.organisation_id; });
    }
    rows.forEach((r) => { if (!r.organisation_id && orgByService[String(r.service_id)]) r.organisation_id = orgByService[String(r.service_id)]; });

    // Organisation names - for these rows, and for every org that has any feedback (filter list)
    const { data: allOrgIdsRows, error: idsError } = await fetchAllRows(() => supabase
      .from('feedback')
      .select('organisation_id')
      .order('id', { ascending: true }));
    if (idsError) throw idsError;
    const countsByOrg = {};
    for (const r of allOrgIdsRows) {
      const key = r.organisation_id || 'none';
      countsByOrg[key] = (countsByOrg[key] || 0) + 1;
    }
    const orgIds = [...new Set([...Object.keys(countsByOrg).filter((id) => id !== 'none'), ...Object.values(orgByService)])];
    const orgNames = {};
    for (const idChunk of chunkArray(orgIds)) {
      const { data: orgs, error: orgError } = await supabase
        .from('organisations')
        .select('id, name')
        .in('id', idChunk);
      if (orgError) throw orgError;
      (orgs || []).forEach((o) => { orgNames[o.id] = o.name; });
    }

    // Language display names (e.g. am-ET -> Amharic)
    const { data: languages } = await supabase.from('languages').select('locale, english_name');
    const languageNames = {};
    (languages || []).forEach((l) => { languageNames[l.locale] = l.english_name; });

    res.json({
      success: true,
      data: {
        feedback: rows.map((r) => ({
          id: r.id,
          createdAt: r.created_at,
          organisationId: r.organisation_id,
          organisationName: r.organisation_id ? (orgNames[r.organisation_id] || 'Unknown organisation') : 'Unknown (deleted customer?)',
          serviceId: r.service_id,
          language: r.user_language,
          languageName: languageNames[r.user_language] || null,
          text: r.feedback_text
        })),
        organisations: Object.entries(countsByOrg)
          .map(([id, count]) => ({ id: id === 'none' ? null : id, name: id === 'none' ? 'No organisation' : (orgNames[id] || 'Unknown organisation'), count }))
          .filter((o) => o.id)
          .sort((a, b) => a.name.localeCompare(b.name)),
        total: allOrgIdsRows.length
      }
    });
  } catch (error) {
    console.error('Error fetching feedback:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
