/**
 * Price Migration Scheduler
 *
 * Runs a daily cron job to automatically execute price migrations
 * that have passed their scheduled execution date.
 */

import cron from 'node-cron';
import { getPendingMigrations, executeMigration } from './price-migration.js';
import { sendAlert } from './email.js';

let isRunning = false;

/**
 * Process pending price migrations
 * Called by the cron job
 */
async function processPendingMigrations() {
    if (isRunning) {
        console.log('⏳ Price migration scheduler already running, skipping...');
        return;
    }

    isRunning = true;
    console.log('🔄 Checking for pending price migrations...');

    try {
        const { success, migrations, error } = await getPendingMigrations();

        if (!success) {
            console.error('Failed to get pending migrations:', error);
            return;
        }

        if (!migrations || migrations.length === 0) {
            console.log('   No pending migrations ready for execution');
            return;
        }

        console.log(`📋 Found ${migrations.length} migration(s) ready for execution`);

        for (const migration of migrations) {
            console.log(`🔄 Executing price migration: ${migration.name}`);

            try {
                const result = await executeMigration(migration.id);

                if (result.success) {
                    console.log(`✅ Migration completed: ${result.completed} subscriptions updated, ${result.failed} failed`);

                    // Send success notification
                    await sendAlert(
                        'Price Migration Completed',
                        `<p>The price migration "<strong>${migration.name}</strong>" has been completed.</p>
                         <p>Results:</p>
                         <ul>
                           <li>Subscriptions updated: ${result.completed}</li>
                           <li>Failed: ${result.failed}</li>
                         </ul>
                         ${result.failed > 0 ? `<p style="color: #dc2626;">Please review failed migrations in the dashboard.</p>` : ''}`,
                        result.failed > 0 ? 'warning' : 'info'
                    );
                } else {
                    console.error(`❌ Migration failed: ${result.error}`);

                    // Send failure notification
                    await sendAlert(
                        'Price Migration Failed',
                        `<p>The price migration "<strong>${migration.name}</strong>" failed to execute.</p>
                         <p>Error: ${result.error}</p>
                         <p>Please check the dashboard for details.</p>`,
                        'critical'
                    );
                }
            } catch (migrationError) {
                console.error(`❌ Error executing migration ${migration.name}:`, migrationError.message);

                await sendAlert(
                    'Price Migration Error',
                    `<p>An error occurred while executing price migration "<strong>${migration.name}</strong>".</p>
                     <p>Error: ${migrationError.message}</p>`,
                    'critical'
                );
            }
        }
    } catch (error) {
        console.error('Error in price migration scheduler:', error);
    } finally {
        isRunning = false;
    }
}

/**
 * Start the price migration scheduler
 * Runs daily at 3:00 AM
 */
export function startPriceMigrationScheduler() {
    console.log('📅 Starting price migration scheduler (runs daily at 3:00 AM)');

    // Run at 3:00 AM every day
    cron.schedule('0 3 * * *', async () => {
        console.log('\n⏰ Price migration scheduler triggered at', new Date().toISOString());
        await processPendingMigrations();
    });

    // Also run immediately on startup to catch any missed migrations
    // (in case the server was down when a migration was due)
    setTimeout(async () => {
        console.log('\n🚀 Running initial price migration check...');
        await processPendingMigrations();
    }, 10000); // Wait 10 seconds after startup
}

export default { startPriceMigrationScheduler };
