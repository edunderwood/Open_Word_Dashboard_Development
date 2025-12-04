/**
 * Charity Register Management Routes
 * Upload and manage OSCR (Scotland) and CCNI (Northern Ireland) charity registers
 */

import express from 'express';
import supabase from '../services/supabase.js';
import multer from 'multer';
import { parse } from 'csv-parse/sync';

const router = express.Router();

// Configure multer for file uploads (memory storage for CSV processing)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB limit
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
            cb(null, true);
        } else {
            cb(new Error('Only CSV files are allowed'), false);
        }
    }
});

/**
 * GET /api/charity-registers
 * Get charity register metadata and stats
 */
router.get('/', async (req, res) => {
    try {
        // Get metadata
        const { data: metadata, error: metaError } = await supabase
            .from('charity_register_metadata')
            .select('*');

        if (metaError) throw metaError;

        // Get record counts from actual tables
        const [scotlandCount, niCount] = await Promise.all([
            supabase.from('charity_register_scotland').select('id', { count: 'exact', head: true }),
            supabase.from('charity_register_ni').select('id', { count: 'exact', head: true })
        ]);

        const registers = {
            scotland: {
                ...(metadata?.find(r => r.register_name === 'scotland') || {}),
                actualRecordCount: scotlandCount.count || 0
            },
            northern_ireland: {
                ...(metadata?.find(r => r.register_name === 'northern_ireland') || {}),
                actualRecordCount: niCount.count || 0
            }
        };

        res.json({
            success: true,
            data: registers
        });

    } catch (error) {
        console.error('Error fetching register metadata:', error);
        res.status(500).json({ error: 'Failed to fetch register data' });
    }
});

/**
 * GET /api/charity-registers/search
 * Search charity registers
 */
router.get('/search', async (req, res) => {
    try {
        const { number, name } = req.query;

        if (!number && !name) {
            return res.status(400).json({
                error: 'Charity number or name required'
            });
        }

        let results = [];

        if (number) {
            const normalized = number.toUpperCase().trim();

            // Check Scotland register
            if (normalized.startsWith('SC')) {
                const { data } = await supabase
                    .from('charity_register_scotland')
                    .select('*')
                    .eq('charity_number', normalized);

                if (data && data.length > 0) {
                    results = data.map(r => ({ ...r, source: 'scotland' }));
                }
            }

            // Check NI register
            if (normalized.startsWith('NIC') || /^1\d{5}$/.test(normalized)) {
                const { data } = await supabase
                    .from('charity_register_ni')
                    .select('*')
                    .eq('charity_number', normalized);

                if (data && data.length > 0) {
                    results = [...results, ...data.map(r => ({ ...r, source: 'northern_ireland' }))];
                }
            }
        }

        if (name && name.length >= 3) {
            // Search by name in both registers (limit results)
            const searchTerm = `%${name}%`;

            const [scotlandResults, niResults] = await Promise.all([
                supabase
                    .from('charity_register_scotland')
                    .select('*')
                    .ilike('charity_name', searchTerm)
                    .limit(20),
                supabase
                    .from('charity_register_ni')
                    .select('*')
                    .ilike('charity_name', searchTerm)
                    .limit(20)
            ]);

            if (scotlandResults.data) {
                results = [...results, ...scotlandResults.data.map(r => ({ ...r, source: 'scotland' }))];
            }
            if (niResults.data) {
                results = [...results, ...niResults.data.map(r => ({ ...r, source: 'northern_ireland' }))];
            }
        }

        res.json({
            success: true,
            data: results,
            count: results.length
        });

    } catch (error) {
        console.error('Error searching charity registers:', error);
        res.status(500).json({ error: 'Failed to search registers' });
    }
});

/**
 * GET /api/charity-registers/reviews
 * Get pending charity review requests
 */
router.get('/reviews', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('organisations')
            .select('id, name, charity_number, charity_region, charity_review_reason, charity_review_requested_at, contact_name')
            .eq('charity_review_requested', true)
            .eq('charity_verified', false)
            .order('charity_review_requested_at', { ascending: true });

        if (error) throw error;

        res.json({
            success: true,
            data: data || []
        });

    } catch (error) {
        console.error('Error fetching charity reviews:', error);
        res.status(500).json({ error: 'Failed to fetch review requests' });
    }
});

/**
 * POST /api/charity-registers/reviews/:id/approve
 * Approve charity review request
 */
router.post('/reviews/:id/approve', async (req, res) => {
    try {
        const { id } = req.params;
        const { registeredName, notes } = req.body;

        const { data, error } = await supabase
            .from('organisations')
            .update({
                charity_review_requested: false,
                charity_verified: true,
                charity_verified_at: new Date().toISOString(),
                charity_discount_percent: 50,
                charity_registered_name: registeredName || null,
                charity_review_reason: notes || null
            })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        console.log(`🏛️  Charity review APPROVED for organisation ${id}: ${data.name}`);

        res.json({
            success: true,
            message: 'Charity status approved - 50% discount applied',
            data
        });

    } catch (error) {
        console.error('Error approving charity review:', error);
        res.status(500).json({ error: 'Failed to approve review' });
    }
});

/**
 * POST /api/charity-registers/reviews/:id/reject
 * Reject charity review request
 */
router.post('/reviews/:id/reject', async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        const { data, error } = await supabase
            .from('organisations')
            .update({
                charity_review_requested: false,
                charity_verified: false,
                charity_discount_percent: 0,
                charity_review_reason: reason || 'Review rejected'
            })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        console.log(`🏛️  Charity review REJECTED for organisation ${id}: ${data.name}`);

        res.json({
            success: true,
            message: 'Charity review rejected',
            data
        });

    } catch (error) {
        console.error('Error rejecting charity review:', error);
        res.status(500).json({ error: 'Failed to reject review' });
    }
});

/**
 * POST /api/charity-registers/scotland
 * Upload Scottish (OSCR) charity register CSV
 */
router.post('/scotland', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No CSV file uploaded' });
        }

        console.log(`📂 Processing Scotland charity register upload (${req.file.size} bytes)`);

        // Parse CSV
        const csvContent = req.file.buffer.toString('utf-8');
        const records = parse(csvContent, {
            columns: true,
            skip_empty_lines: true,
            trim: true
        });

        console.log(`   Found ${records.length} records in CSV`);

        // Map OSCR columns to our schema
        const charities = records.map(row => ({
            charity_number: (row['Charity Number'] || row['charity_number'] || '').toUpperCase().trim(),
            charity_name: row['Charity Name'] || row['charity_name'] || '',
            charity_status: row['Charity Status'] || row['charity_status'] || 'Registered',
            registered_date: parseDate(row['Registered Date'] || row['registered_date']),
            postcode: row['Postcode'] || row['postcode'] || ''
        })).filter(c => c.charity_number && c.charity_number.startsWith('SC'));

        console.log(`   Filtered to ${charities.length} valid Scottish charity records`);

        if (charities.length === 0) {
            return res.status(400).json({
                error: 'No valid Scottish charity records found in CSV. Expected column "Charity Number" with SC prefix.'
            });
        }

        // Clear existing records and insert new ones
        const { error: deleteError } = await supabase
            .from('charity_register_scotland')
            .delete()
            .neq('id', 0);

        if (deleteError) {
            console.error('Error clearing Scotland register:', deleteError);
            return res.status(500).json({ error: 'Error clearing existing records' });
        }

        // Insert in batches of 1000
        const batchSize = 1000;
        let insertedCount = 0;
        let errors = [];

        for (let i = 0; i < charities.length; i += batchSize) {
            const batch = charities.slice(i, i + batchSize);
            const { error: insertError } = await supabase
                .from('charity_register_scotland')
                .insert(batch);

            if (insertError) {
                console.error(`Error inserting batch ${i / batchSize + 1}:`, insertError);
                errors.push(insertError.message);
            } else {
                insertedCount += batch.length;
            }
        }

        // Update metadata
        await supabase
            .from('charity_register_metadata')
            .upsert({
                register_name: 'scotland',
                last_updated: new Date().toISOString(),
                record_count: insertedCount,
                source_url: 'https://www.oscr.org.uk/about-charities/search-the-register/charity-register-download/',
                notes: `Uploaded via dashboard on ${new Date().toLocaleDateString()}`
            }, { onConflict: 'register_name' });

        console.log(`✅ Scotland register updated: ${insertedCount} records`);

        res.json({
            success: true,
            message: `Scotland charity register updated successfully`,
            stats: {
                totalInCsv: records.length,
                validRecords: charities.length,
                insertedRecords: insertedCount,
                errors: errors.length > 0 ? errors : undefined
            }
        });

    } catch (error) {
        console.error('Error processing Scotland register:', error);
        res.status(500).json({ error: `Error processing CSV: ${error.message}` });
    }
});

/**
 * POST /api/charity-registers/northern-ireland
 * Upload Northern Ireland (CCNI) charity register CSV
 */
router.post('/northern-ireland', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No CSV file uploaded' });
        }

        console.log(`📂 Processing NI charity register upload (${req.file.size} bytes)`);

        // Parse CSV
        const csvContent = req.file.buffer.toString('utf-8');
        const records = parse(csvContent, {
            columns: true,
            skip_empty_lines: true,
            trim: true
        });

        console.log(`   Found ${records.length} records in CSV`);

        // Map CCNI columns to our schema
        const charities = records.map(row => {
            const charityNum = (
                row['Reg charity number'] ||
                row['Charity Number'] ||
                row['charity_number'] ||
                row['NIC Number'] ||
                ''
            ).toUpperCase().trim();

            return {
                charity_number: charityNum,
                charity_name: row['Charity name'] || row['Charity Name'] || row['charity_name'] || '',
                charity_status: row['Status'] || row['status'] || row['Charity Status'] || 'Registered',
                registered_date: parseDate(row['Date registered'] || row['Registered Date'] || row['registered_date']),
                postcode: row['Postcode'] || row['postcode'] || ''
            };
        }).filter(c => c.charity_number && (c.charity_number.startsWith('NIC') || /^1\d{5}$/.test(c.charity_number)));

        console.log(`   Filtered to ${charities.length} valid NI charity records`);

        if (charities.length === 0) {
            return res.status(400).json({
                error: 'No valid NI charity records found in CSV. Expected column "Reg charity number" with NIC prefix or 6 digits starting with 1.'
            });
        }

        // Clear existing records
        const { error: deleteError } = await supabase
            .from('charity_register_ni')
            .delete()
            .neq('id', 0);

        if (deleteError) {
            console.error('Error clearing NI register:', deleteError);
            return res.status(500).json({ error: 'Error clearing existing records' });
        }

        // Insert in batches of 1000
        const batchSize = 1000;
        let insertedCount = 0;
        let errors = [];

        for (let i = 0; i < charities.length; i += batchSize) {
            const batch = charities.slice(i, i + batchSize);
            const { error: insertError } = await supabase
                .from('charity_register_ni')
                .insert(batch);

            if (insertError) {
                console.error(`Error inserting batch ${i / batchSize + 1}:`, insertError);
                errors.push(insertError.message);
            } else {
                insertedCount += batch.length;
            }
        }

        // Update metadata
        await supabase
            .from('charity_register_metadata')
            .upsert({
                register_name: 'northern_ireland',
                last_updated: new Date().toISOString(),
                record_count: insertedCount,
                source_url: 'https://www.charitycommissionni.org.uk/charity-search/',
                notes: `Uploaded via dashboard on ${new Date().toLocaleDateString()}`
            }, { onConflict: 'register_name' });

        console.log(`✅ NI register updated: ${insertedCount} records`);

        res.json({
            success: true,
            message: `Northern Ireland charity register updated successfully`,
            stats: {
                totalInCsv: records.length,
                validRecords: charities.length,
                insertedRecords: insertedCount,
                errors: errors.length > 0 ? errors : undefined
            }
        });

    } catch (error) {
        console.error('Error processing NI register:', error);
        res.status(500).json({ error: `Error processing CSV: ${error.message}` });
    }
});

/**
 * Helper function to parse various date formats
 */
function parseDate(dateStr) {
    if (!dateStr) return null;

    const formats = [
        /^(\d{2})\/(\d{2})\/(\d{4})$/, // DD/MM/YYYY
        /^(\d{4})-(\d{2})-(\d{2})$/,   // YYYY-MM-DD
        /^(\d{2})-(\d{2})-(\d{4})$/    // DD-MM-YYYY
    ];

    for (const format of formats) {
        const match = dateStr.match(format);
        if (match) {
            if (format === formats[0]) {
                return `${match[3]}-${match[2]}-${match[1]}`;
            } else if (format === formats[1]) {
                return dateStr;
            } else if (format === formats[2]) {
                return `${match[3]}-${match[2]}-${match[1]}`;
            }
        }
    }

    try {
        const date = new Date(dateStr);
        if (!isNaN(date.getTime())) {
            return date.toISOString().split('T')[0];
        }
    } catch (e) {
        // Ignore parsing errors
    }

    return null;
}

export default router;
