/**
 * Charity Register Management Routes
 * Upload and manage OSCR (Scotland) and CCNI (Northern Ireland) charity registers
 */

import express from 'express';
import supabase from '../services/supabase.js';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import AdmZip from 'adm-zip';
import * as XLSX from 'xlsx';

const router = express.Router();

// Configure multer for file uploads (memory storage for CSV/ZIP/Excel processing)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB limit
    },
    fileFilter: (req, file, cb) => {
        const isCSV = file.mimetype === 'text/csv' || file.originalname.endsWith('.csv');
        const isZIP = file.mimetype === 'application/zip' ||
                      file.mimetype === 'application/x-zip-compressed' ||
                      file.originalname.endsWith('.zip');
        const isExcel = file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
                        file.mimetype === 'application/vnd.ms-excel' ||
                        file.originalname.endsWith('.xlsx') ||
                        file.originalname.endsWith('.xls');
        if (isCSV || isZIP || isExcel) {
            cb(null, true);
        } else {
            cb(new Error('Only CSV, ZIP or Excel files are allowed'), false);
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
        const [scotlandCount, niCount, irelandCount] = await Promise.all([
            supabase.from('charity_register_scotland').select('id', { count: 'exact', head: true }),
            supabase.from('charity_register_ni').select('id', { count: 'exact', head: true }),
            supabase.from('charity_register_ireland').select('id', { count: 'exact', head: true })
        ]);

        const registers = {
            scotland: {
                ...(metadata?.find(r => r.register_name === 'scotland') || {}),
                actualRecordCount: scotlandCount.count || 0
            },
            northern_ireland: {
                ...(metadata?.find(r => r.register_name === 'northern_ireland') || {}),
                actualRecordCount: niCount.count || 0
            },
            ireland: {
                ...(metadata?.find(r => r.register_name === 'ireland') || {}),
                actualRecordCount: irelandCount.count || 0
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

            // Check England/Wales via Charity Commission API (6-7 digit numbers)
            if (/^\d{6,7}$/.test(normalized) || /^\d{6,7}-\d{1,2}$/.test(normalized)) {
                const apiKey = process.env.CHARITY_COMMISSION_API_KEY;
                if (apiKey) {
                    try {
                        const url = `https://api.charitycommission.gov.uk/register/api/allcharitydetails/${normalized}/0`;
                        const response = await fetch(url, {
                            headers: {
                                'Ocp-Apim-Subscription-Key': apiKey,
                                'Accept': 'application/json'
                            }
                        });

                        if (response.ok) {
                            const data = await response.json();
                            const charity = Array.isArray(data) ? data[0] : data;
                            if (charity) {
                                results.push({
                                    charity_number: charity.reg_charity_number?.toString() || normalized,
                                    charity_name: charity.charity_name,
                                    charity_status: charity.reg_status,
                                    registered_date: charity.date_of_registration,
                                    source: 'england_wales'
                                });
                            }
                        }
                    } catch (apiError) {
                        console.error('Charity Commission API error:', apiError.message);
                    }
                }
            }

            // Check Scotland register
            if (normalized.startsWith('SC')) {
                const { data } = await supabase
                    .from('charity_register_scotland')
                    .select('*')
                    .eq('charity_number', normalized);

                if (data && data.length > 0) {
                    results = [...results, ...data.map(r => ({ ...r, source: 'scotland' }))];
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

            // Check Ireland register (8 digits starting with 20, or CHY prefix)
            if (/^20\d{6}$/.test(normalized) || normalized.startsWith('CHY')) {
                const { data } = await supabase
                    .from('charity_register_ireland')
                    .select('*')
                    .eq('charity_number', normalized);

                if (data && data.length > 0) {
                    results = [...results, ...data.map(r => ({ ...r, source: 'ireland' }))];
                }
            }
        }

        if (name && name.length >= 3) {
            // Search by name in all database registers (limit results)
            const searchTerm = `%${name}%`;

            const [scotlandResults, niResults, irelandResults] = await Promise.all([
                supabase
                    .from('charity_register_scotland')
                    .select('*')
                    .ilike('charity_name', searchTerm)
                    .limit(20),
                supabase
                    .from('charity_register_ni')
                    .select('*')
                    .ilike('charity_name', searchTerm)
                    .limit(20),
                supabase
                    .from('charity_register_ireland')
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
            if (irelandResults.data) {
                results = [...results, ...irelandResults.data.map(r => ({ ...r, source: 'ireland' }))];
            }

            // Note: England/Wales name search not supported via API (number lookup only)
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
 * POST /api/charity-registers/scotland/sync
 * Sync Scottish charity register from OSCR API
 */
router.post('/scotland/sync', async (req, res) => {
    try {
        const oscrApiKey = process.env.OSCR_API_KEY;

        if (!oscrApiKey) {
            return res.status(400).json({
                error: 'OSCR API key not configured. Add OSCR_API_KEY to environment variables.'
            });
        }

        console.log('🔄 Starting OSCR API sync...');

        // Fetch all charities from OSCR API (paginated)
        const allCharities = [];
        let skip = 0;
        const top = 1000; // OSCR API maximum
        let hasMore = true;

        while (hasMore) {
            const url = `https://oscrapi.azurewebsites.net/api/all_charities?$top=${top}&$skip=${skip}`;
            console.log(`   Fetching records ${skip} to ${skip + top}...`);

            const response = await fetch(url, {
                headers: {
                    'x-functions-key': oscrApiKey,
                    'Accept': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OSCR API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            if (result.data && result.data.length > 0) {
                allCharities.push(...result.data);
                skip += top;

                // Safety limit to prevent infinite loops
                if (skip > 100000) {
                    console.warn('⚠️  Reached safety limit of 100,000 records');
                    hasMore = false;
                }
            } else {
                hasMore = false;
            }

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        console.log(`   Retrieved ${allCharities.length} charities from OSCR API`);

        if (allCharities.length === 0) {
            return res.status(500).json({
                error: 'No charities retrieved from OSCR API. Check API key and connectivity.'
            });
        }

        // Map OSCR API response to our schema
        const charities = allCharities.map(charity => ({
            charity_number: (charity.charityNumber || '').toUpperCase().trim(),
            charity_name: charity.charityName || '',
            charity_status: charity.charityStatus || 'Registered',
            registered_date: charity.registeredDate ? charity.registeredDate.split('T')[0] : null,
            postcode: charity.postcode || ''
        })).filter(c => c.charity_number && c.charity_number.startsWith('SC'));

        console.log(`   Filtered to ${charities.length} valid Scottish charity records`);

        // Clear existing records
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
                source_url: 'https://oscrapi.azurewebsites.net/api/all_charities',
                notes: `Synced from OSCR API on ${new Date().toLocaleDateString()}`
            }, { onConflict: 'register_name' });

        console.log(`✅ Scotland register synced from API: ${insertedCount} records`);

        res.json({
            success: true,
            message: 'Scotland charity register synced from OSCR API',
            stats: {
                fetchedFromApi: allCharities.length,
                validRecords: charities.length,
                insertedRecords: insertedCount,
                errors: errors.length > 0 ? errors : undefined
            }
        });

    } catch (error) {
        console.error('Error syncing from OSCR API:', error);
        res.status(500).json({ error: `Error syncing from API: ${error.message}` });
    }
});

/**
 * POST /api/charity-registers/scotland
 * Upload Scottish (OSCR) charity register CSV or ZIP file
 */
router.post('/scotland', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        console.log(`📂 Processing Scotland charity register upload (${req.file.size} bytes, ${req.file.originalname})`);

        // Extract CSV content - handle both ZIP and CSV files
        let csvContent;
        const isZip = req.file.originalname.endsWith('.zip') ||
                      req.file.mimetype === 'application/zip' ||
                      req.file.mimetype === 'application/x-zip-compressed';

        if (isZip) {
            console.log('   Extracting CSV from ZIP file...');
            const zip = new AdmZip(req.file.buffer);
            const zipEntries = zip.getEntries();

            // Find the CSV file in the ZIP
            const csvEntry = zipEntries.find(entry =>
                entry.entryName.endsWith('.csv') && !entry.entryName.startsWith('__MACOSX')
            );

            if (!csvEntry) {
                return res.status(400).json({
                    error: 'No CSV file found in ZIP archive'
                });
            }

            console.log(`   Found CSV: ${csvEntry.entryName}`);
            csvContent = zip.readAsText(csvEntry);
        } else {
            csvContent = req.file.buffer.toString('utf-8');
        }

        // Parse CSV
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
                source_url: 'https://www.oscr.org.uk/about-charities/search-the-register/download-the-scottish-charity-register/',
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
 * POST /api/charity-registers/ireland
 * Upload Ireland (CRA) charity register Excel/CSV
 */
router.post('/ireland', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        console.log(`📂 Processing Ireland charity register upload (${req.file.size} bytes, ${req.file.originalname})`);

        // Determine file type and parse accordingly
        let records = [];
        const fileName = req.file.originalname.toLowerCase();
        const isZip = fileName.endsWith('.zip');
        const isExcel = fileName.endsWith('.xlsx') || fileName.endsWith('.xls');

        if (isZip) {
            console.log('   Extracting from ZIP file...');
            const zip = new AdmZip(req.file.buffer);
            const zipEntries = zip.getEntries();

            // Look for CSV or Excel in the ZIP
            const csvEntry = zipEntries.find(entry =>
                (entry.entryName.endsWith('.csv') || entry.entryName.endsWith('.xlsx') || entry.entryName.endsWith('.xls')) &&
                !entry.entryName.startsWith('__MACOSX')
            );

            if (!csvEntry) {
                return res.status(400).json({
                    error: 'No CSV or Excel file found in ZIP archive'
                });
            }

            console.log(`   Found file: ${csvEntry.entryName}`);

            if (csvEntry.entryName.endsWith('.xlsx') || csvEntry.entryName.endsWith('.xls')) {
                // Parse Excel from ZIP
                const workbook = XLSX.read(zip.readFile(csvEntry), { type: 'buffer' });
                const sheetName = workbook.SheetNames[0];
                records = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
            } else {
                // Parse CSV from ZIP
                const csvContent = zip.readAsText(csvEntry);
                records = parse(csvContent, {
                    columns: true,
                    skip_empty_lines: true,
                    trim: true,
                    relax_column_count: true
                });
            }
        } else if (isExcel) {
            console.log('   Parsing Excel file...');
            const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            records = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
            console.log(`   Sheet: ${sheetName}`);
        } else {
            // Assume CSV
            console.log('   Parsing CSV file...');
            const csvContent = req.file.buffer.toString('utf-8');
            records = parse(csvContent, {
                columns: true,
                skip_empty_lines: true,
                trim: true,
                relax_column_count: true
            });
        }

        console.log(`   Found ${records.length} records in file`);

        // Log first record columns for debugging
        if (records.length > 0) {
            console.log(`   Columns found: ${Object.keys(records[0]).join(', ')}`);
        }

        // Map CRA columns to our schema
        // Expected columns: Registered Charity Number (RCN), Charity Name, Status, etc.
        const charities = records.map(row => {
            const charityNum = (
                row['Registered Charity Number'] ||
                row['RCN'] ||
                row['Charity Number'] ||
                row['charity_number'] ||
                ''
            ).toString().toUpperCase().trim();

            return {
                charity_number: charityNum,
                charity_name: row['Charity Name'] || row['charity_name'] || row['Name'] || '',
                charity_status: row['Status'] || row['status'] || row['Charity Status'] || 'Registered',
                registered_date: parseDate(row['Date Registered'] || row['Registered Date'] || row['registered_date']),
                charitable_purpose: row['Charitable Purpose'] || row['charitable_purpose'] || row['Main Charitable Purpose'] || ''
            };
        }).filter(c => c.charity_number && (/^20\d{6}$/.test(c.charity_number) || c.charity_number.startsWith('CHY')));

        console.log(`   Filtered to ${charities.length} valid Ireland charity records`);

        if (charities.length === 0) {
            return res.status(400).json({
                error: 'No valid Ireland charity records found. Expected "Registered Charity Number" column with 8-digit numbers starting with 20, or CHY prefix.'
            });
        }

        // Clear existing records
        const { error: deleteError } = await supabase
            .from('charity_register_ireland')
            .delete()
            .neq('id', 0);

        if (deleteError) {
            console.error('Error clearing Ireland register:', deleteError);
            return res.status(500).json({ error: 'Error clearing existing records' });
        }

        // Insert in batches of 1000
        const batchSize = 1000;
        let insertedCount = 0;
        let errors = [];

        for (let i = 0; i < charities.length; i += batchSize) {
            const batch = charities.slice(i, i + batchSize);
            const { error: insertError } = await supabase
                .from('charity_register_ireland')
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
                register_name: 'ireland',
                last_updated: new Date().toISOString(),
                record_count: insertedCount,
                source_url: 'https://www.charitiesregulator.ie/en/information-for-the-public/search-the-register-of-charities',
                notes: `Uploaded via dashboard on ${new Date().toLocaleDateString()}`
            }, { onConflict: 'register_name' });

        console.log(`✅ Ireland register updated: ${insertedCount} records`);

        res.json({
            success: true,
            message: `Ireland charity register updated successfully`,
            stats: {
                totalInCsv: records.length,
                validRecords: charities.length,
                insertedRecords: insertedCount,
                errors: errors.length > 0 ? errors : undefined
            }
        });

    } catch (error) {
        console.error('Error processing Ireland register:', error);
        res.status(500).json({ error: `Error processing file: ${error.message}` });
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
