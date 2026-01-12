/**
 * Communications Routes
 *
 * Handles bulk and individual email communications to customers
 */

import express from 'express';
import supabase from '../services/supabase.js';
import { sendCustomerEmail, sendBulkCustomerEmail } from '../services/email.js';

const router = express.Router();

/**
 * GET /customers
 * Get all customers with their email addresses for selection
 */
router.get('/customers', async (req, res) => {
    try {
        // Get all organisations with user IDs
        const { data: orgs, error: orgsError } = await supabase
            .from('organisations')
            .select('id, name, subscription_tier, subscription_status, email_opt_out, user_id, created_at')
            .order('name');

        if (orgsError) throw orgsError;

        // Fetch auth user emails in parallel
        const customersWithEmails = await Promise.all(
            orgs.map(async (org) => {
                let email = null;
                if (org.user_id) {
                    try {
                        const { data: authUser } = await supabase.auth.admin.getUserById(org.user_id);
                        email = authUser?.user?.email || null;
                    } catch (e) {
                        console.error(`Failed to get auth user for org ${org.id}:`, e.message);
                    }
                }
                return {
                    id: org.id,
                    name: org.name,
                    email: email,
                    tier: org.subscription_tier || 'trial',
                    status: org.subscription_status || 'active',
                    emailOptOut: org.email_opt_out || false,
                    createdAt: org.created_at
                };
            })
        );

        // Filter out customers without emails
        const validCustomers = customersWithEmails.filter(c => c.email);

        res.json({
            success: true,
            customers: validCustomers,
            total: validCustomers.length,
            optedOut: validCustomers.filter(c => c.emailOptOut).length
        });
    } catch (error) {
        console.error('Error fetching customers for communications:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /send-bulk
 * Send email to multiple customers
 */
router.post('/send-bulk', async (req, res) => {
    try {
        const { customerIds, subject, body, emailType } = req.body;

        if (!customerIds || !Array.isArray(customerIds) || customerIds.length === 0) {
            return res.status(400).json({ success: false, error: 'No customers selected' });
        }

        if (!subject || !subject.trim()) {
            return res.status(400).json({ success: false, error: 'Subject is required' });
        }

        if (!body || !body.trim()) {
            return res.status(400).json({ success: false, error: 'Email body is required' });
        }

        // Get customer details
        const { data: orgs, error: orgsError } = await supabase
            .from('organisations')
            .select('id, name, user_id')
            .in('id', customerIds);

        if (orgsError) throw orgsError;

        // Fetch emails
        const recipients = [];
        for (const org of orgs) {
            if (org.user_id) {
                try {
                    const { data: authUser } = await supabase.auth.admin.getUserById(org.user_id);
                    if (authUser?.user?.email) {
                        recipients.push({
                            email: authUser.user.email,
                            name: org.name,
                            orgId: org.id
                        });
                    }
                } catch (e) {
                    console.error(`Failed to get email for org ${org.id}:`, e.message);
                }
            }
        }

        if (recipients.length === 0) {
            return res.status(400).json({ success: false, error: 'No valid email addresses found' });
        }

        // Convert plain text to HTML (preserve line breaks)
        const htmlBody = body
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');

        // Send emails
        const results = await sendBulkCustomerEmail(recipients, subject, `<p>${htmlBody}</p>`);

        // Log each email to database
        const emailLogs = recipients.map(r => ({
            organisation_id: r.orgId,
            recipient_email: r.email,
            recipient_name: r.name,
            subject: subject,
            body_preview: body.substring(0, 500),
            sent_by: req.session.user?.email || 'admin',
            status: results.errors.find(e => e.orgId === r.orgId) ? 'failed' : 'sent',
            email_type: emailType || 'bulk_announcement',
            error_message: results.errors.find(e => e.orgId === r.orgId)?.error || null
        }));

        // Insert logs
        const { error: logError } = await supabase
            .from('email_log')
            .insert(emailLogs);

        if (logError) {
            console.error('Failed to log emails:', logError);
        }

        res.json({
            success: true,
            sent: results.sent,
            failed: results.failed,
            errors: results.errors
        });
    } catch (error) {
        console.error('Error sending bulk email:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /send-individual/:id
 * Send email to a single customer
 */
router.post('/send-individual/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { subject, body, emailType } = req.body;

        if (!subject || !subject.trim()) {
            return res.status(400).json({ success: false, error: 'Subject is required' });
        }

        if (!body || !body.trim()) {
            return res.status(400).json({ success: false, error: 'Email body is required' });
        }

        // Get customer details
        const { data: org, error: orgError } = await supabase
            .from('organisations')
            .select('id, name, user_id')
            .eq('id', id)
            .single();

        if (orgError || !org) {
            return res.status(404).json({ success: false, error: 'Customer not found' });
        }

        if (!org.user_id) {
            return res.status(400).json({ success: false, error: 'Customer has no associated user account' });
        }

        // Get email
        const { data: authUser } = await supabase.auth.admin.getUserById(org.user_id);
        const email = authUser?.user?.email;

        if (!email) {
            return res.status(400).json({ success: false, error: 'No email address found for customer' });
        }

        // Convert plain text to HTML
        const htmlBody = body
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');

        // Send email
        const result = await sendCustomerEmail(email, subject, `<p>${htmlBody}</p>`, org.name);

        // Log to database
        const { error: logError } = await supabase
            .from('email_log')
            .insert({
                organisation_id: org.id,
                recipient_email: email,
                recipient_name: org.name,
                subject: subject,
                body_preview: body.substring(0, 500),
                sent_by: req.session.user?.email || 'admin',
                status: result.success ? 'sent' : 'failed',
                email_type: emailType || 'individual',
                error_message: result.error || null
            });

        if (logError) {
            console.error('Failed to log email:', logError);
        }

        if (result.success) {
            res.json({ success: true, message: `Email sent to ${email}` });
        } else {
            res.status(500).json({ success: false, error: result.error });
        }
    } catch (error) {
        console.error('Error sending individual email:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /history
 * Get email send history
 */
router.get('/history', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;

        const { data: logs, error, count } = await supabase
            .from('email_log')
            .select('*', { count: 'exact' })
            .order('sent_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw error;

        res.json({
            success: true,
            logs: logs,
            total: count,
            limit,
            offset
        });
    } catch (error) {
        console.error('Error fetching email history:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /templates
 * Get available email templates
 */
router.get('/templates', (req, res) => {
    const templates = [
        {
            id: 'maintenance',
            name: 'Scheduled Maintenance',
            subject: 'Scheduled Maintenance Notice - Open Word',
            body: `Dear Customer,

We will be performing scheduled maintenance on our systems.

Date: [DATE]
Time: [TIME] (GMT)
Expected Duration: [DURATION]

During this time, the Open Word service may be temporarily unavailable.

We apologise for any inconvenience and appreciate your patience.

Best regards,
The Open Word Team`
        },
        {
            id: 'feature_update',
            name: 'New Feature Announcement',
            subject: 'Exciting New Features at Open Word',
            body: `Dear Customer,

We're excited to announce new features now available in Open Word!

[FEATURE DETAILS]

Log in to your control panel to try these new capabilities.

If you have any questions, please don't hesitate to contact us.

Best regards,
The Open Word Team`
        },
        {
            id: 'pricing_change',
            name: 'Pricing Update Notice',
            subject: 'Important: Upcoming Pricing Changes - Open Word',
            body: `Dear Customer,

We're writing to inform you of upcoming changes to our pricing.

Effective Date: [DATE]

[PRICING DETAILS]

Your current plan will [IMPACT DETAILS].

If you have any questions about these changes, please contact our support team.

Best regards,
The Open Word Team`
        },
        {
            id: 'welcome',
            name: 'Welcome / Onboarding',
            subject: 'Welcome to Open Word!',
            body: `Dear Customer,

Thank you for choosing Open Word for your real-time translation needs!

Here are some tips to get started:
- Access your control panel at openword.onrender.com
- Set up your translation languages in Settings
- Generate QR codes for your participants

Need help? Visit openword.live or reply to this email.

Best regards,
The Open Word Team`
        },
        {
            id: 'custom',
            name: 'Custom Message',
            subject: '',
            body: ''
        }
    ];

    res.json({ success: true, templates });
});

export default router;
