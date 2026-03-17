/**
 * Notifications Routes
 *
 * Handles sending in-app notifications to customers and viewing history
 */

import express from 'express';
import supabase from '../services/supabase.js';

const router = express.Router();

/**
 * GET /customers
 * Get all customers for notification recipient selection
 */
router.get('/customers', async (req, res) => {
    try {
        const { data: orgs, error: orgsError } = await supabase
            .from('organisations')
            .select('id, name, subscription_tier, subscription_status, user_id, created_at')
            .order('name');

        if (orgsError) throw orgsError;

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
                    createdAt: org.created_at
                };
            })
        );

        const validCustomers = customersWithEmails.filter(c => c.name);

        res.json({
            success: true,
            customers: validCustomers,
            total: validCustomers.length
        });
    } catch (error) {
        console.error('Error fetching customers for notifications:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /send
 * Send notification to selected customers or all
 */
router.post('/send', async (req, res) => {
    try {
        const { customerIds, title, message, type, sendToAll } = req.body;

        if (!title || !title.trim()) {
            return res.status(400).json({ success: false, error: 'Title is required' });
        }

        if (!message || !message.trim()) {
            return res.status(400).json({ success: false, error: 'Message is required' });
        }

        const notificationType = type || 'general';
        const sentBy = req.session.user?.email || 'admin';

        if (sendToAll) {
            // Send as broadcast notification (single row, all orgs see it)
            const { data, error } = await supabase
                .from('notifications')
                .insert({
                    organisation_id: null,
                    title: title.trim(),
                    message: message.trim(),
                    type: notificationType,
                    sent_by: sentBy,
                    is_broadcast: true
                })
                .select()
                .single();

            if (error) throw error;

            // Get count of all orgs for response
            const { count } = await supabase
                .from('organisations')
                .select('id', { count: 'exact', head: true });

            res.json({
                success: true,
                sent: count || 0,
                message: `Broadcast notification sent to all customers`
            });
        } else {
            // Send individual notifications
            if (!customerIds || !Array.isArray(customerIds) || customerIds.length === 0) {
                return res.status(400).json({ success: false, error: 'No customers selected' });
            }

            const notifications = customerIds.map(orgId => ({
                organisation_id: orgId,
                title: title.trim(),
                message: message.trim(),
                type: notificationType,
                sent_by: sentBy,
                is_broadcast: false
            }));

            const { data, error } = await supabase
                .from('notifications')
                .insert(notifications)
                .select();

            if (error) throw error;

            res.json({
                success: true,
                sent: data.length,
                message: `Notification sent to ${data.length} customer(s)`
            });
        }
    } catch (error) {
        console.error('Error sending notification:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /history
 * Get notification send history
 */
router.get('/history', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;

        // Get targeted notifications with org names
        const { data: targeted, error: targetedError } = await supabase
            .from('notifications')
            .select(`
                id, title, message, type, sent_by, is_broadcast, created_at,
                organisation_id,
                organisations(name)
            `)
            .eq('is_broadcast', false)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (targetedError) throw targetedError;

        // Get broadcast notifications
        const { data: broadcasts, error: broadcastError } = await supabase
            .from('notifications')
            .select('id, title, message, type, sent_by, is_broadcast, created_at')
            .eq('is_broadcast', true)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (broadcastError) throw broadcastError;

        // Merge and sort by date
        const allNotifications = [
            ...targeted.map(n => ({
                ...n,
                recipientName: n.organisations?.name || 'Unknown',
                organisations: undefined
            })),
            ...broadcasts.map(n => ({
                ...n,
                recipientName: 'All Customers (Broadcast)'
            }))
        ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        // Get total count
        const { count } = await supabase
            .from('notifications')
            .select('id', { count: 'exact', head: true });

        res.json({
            success: true,
            notifications: allNotifications.slice(0, limit),
            total: count,
            limit,
            offset
        });
    } catch (error) {
        console.error('Error fetching notification history:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /:id
 * Delete a notification (admin)
 */
router.delete('/:id', async (req, res) => {
    try {
        const { error } = await supabase
            .from('notifications')
            .delete()
            .eq('id', req.params.id);

        if (error) throw error;

        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting notification:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
