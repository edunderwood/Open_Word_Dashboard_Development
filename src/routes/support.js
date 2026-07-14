/**
 * Support Requests Routes (admin dashboard)
 *
 * Surfaces the in-app "Contact Support" requests customers submit from the control
 * panel (stored in the support_requests table by the control-panel server).
 */
import express from 'express';
import supabase from '../services/supabase.js';
import { sendCustomerEmail, logEmail } from '../services/email.js';

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

/**
 * GET /api/support/:id/notes
 * List internal notes for a request (oldest first).
 */
router.get('/:id/notes', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('support_notes')
      .select('*')
      .eq('request_id', req.params.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (e) {
    console.error('support notes list error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/support/:id/notes  { note }
 * Add an internal note to a request.
 */
router.post('/:id/notes', async (req, res) => {
  try {
    const note = String(req.body?.note || '').trim();
    if (note.length < 1 || note.length > 4000) {
      return res.status(400).json({ success: false, error: 'Note must be 1–4000 characters.' });
    }
    const { data, error } = await supabase
      .from('support_notes')
      .insert({ request_id: req.params.id, note, author: 'admin' })
      .select('*')
      .single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    console.error('support note add error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/support/:id/reply  { message, resolve }
 * Send a reply to the customer FROM support@openword.live (via SendGrid), so it
 * doesn't go from the admin's personal email. Optionally mark the request resolved.
 */
router.post('/:id/reply', async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    const resolve = req.body?.resolve === true || req.body?.resolve === 'true';
    if (message.length < 1 || message.length > 5000) {
      return res.status(400).json({ success: false, error: 'Reply must be 1–5000 characters.' });
    }

    const { data: reqRow, error: fetchErr } = await supabase
      .from('support_requests')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (fetchErr || !reqRow) return res.status(404).json({ success: false, error: 'Request not found' });
    if (!reqRow.contact_email) return res.status(400).json({ success: false, error: 'No customer email on this request' });

    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const refPrefix = reqRow.ticket_ref ? `[${reqRow.ticket_ref}] ` : '';
    const subject = `${refPrefix}Re: ${reqRow.subject || 'your support request'}`;
    const bodyHtml = `
      <p>Hi ${esc(reqRow.contact_name) || 'there'},</p>
      <p>Thanks for contacting Open Word support${reqRow.ticket_ref ? ` (reference <strong>${esc(reqRow.ticket_ref)}</strong>)` : ''}.</p>
      <div style="white-space:pre-wrap; margin:12px 0;">${esc(message)}</div>
      <p>You can reply to this email if you need anything else.</p>
      <p>Best regards,<br>The Open Word Support Team</p>`;

    const result = await sendCustomerEmail(reqRow.contact_email, subject, bodyHtml, reqRow.contact_name || 'Customer');
    if (!result.success) {
      return res.status(502).json({ success: false, error: result.error || 'Failed to send reply' });
    }

    // Log to email history (best-effort)
    logEmail({
      organisationId: reqRow.organisation_id,
      recipientEmail: reqRow.contact_email,
      recipientName: reqRow.contact_name,
      subject,
      emailType: 'individual',
      sentBy: 'admin',
    }).catch(() => {});

    // Replying moves 'new' -> 'in_progress'; the resolve option jumps to 'resolved'.
    const newStatus = resolve ? 'resolved' : (reqRow.status === 'new' ? 'in_progress' : reqRow.status);
    if (newStatus !== reqRow.status) {
      await supabase.from('support_requests').update({ status: newStatus }).eq('id', reqRow.id);
    }

    res.json({ success: true, status: newStatus });
  } catch (e) {
    console.error('support reply error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
