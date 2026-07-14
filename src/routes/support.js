/**
 * Support Requests Routes (admin dashboard)
 *
 * Surfaces the in-app "Contact Support" requests customers submit from the control
 * panel (stored in the support_requests table by the control-panel server).
 */
import express from 'express';
import supabase from '../services/supabase.js';

const router = express.Router();

const VALID_STATUS = ['new', 'in_progress', 'resolved'];

/**
 * GET /api/support?status=new|in_progress|resolved|all&limit=200
 * List support requests, newest first.
 */
router.get('/', async (req, res) => {
  try {
    const { status, limit = 200 } = req.query;
    let query = supabase
      .from('support_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (status && status !== 'all') query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (e) {
    console.error('support list error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/support/stats
 * Counts by status (for the sidebar badge and filter tabs).
 */
router.get('/stats', async (req, res) => {
  try {
    const { data, error } = await supabase.from('support_requests').select('status');
    if (error) throw error;
    const counts = { new: 0, in_progress: 0, resolved: 0, total: (data || []).length };
    (data || []).forEach(r => { if (counts[r.status] !== undefined) counts[r.status]++; });
    res.json({ success: true, counts });
  } catch (e) {
    console.error('support stats error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/support/customer/:orgId
 * All requests for one organisation (used in the customer detail modal).
 */
router.get('/customer/:orgId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('support_requests')
      .select('*')
      .eq('organisation_id', req.params.orgId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (e) {
    console.error('support customer error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * PATCH /api/support/:id  { status }
 * Move a request through New -> In progress -> Resolved.
 */
router.patch('/:id', async (req, res) => {
  try {
    const status = String(req.body?.status || '');
    if (!VALID_STATUS.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status' });
    }
    const { error } = await supabase
      .from('support_requests')
      .update({ status })
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    console.error('support update error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
