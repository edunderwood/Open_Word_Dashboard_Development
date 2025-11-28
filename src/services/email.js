/**
 * Email Service for Admin Alerts
 */

import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

// Create transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Send alert email
 * @param {string} subject - Email subject
 * @param {string} message - Email body (HTML supported)
 * @param {string} priority - 'critical', 'warning', 'info'
 */
export async function sendAlert(subject, message, priority = 'info') {
  const alertEmail = process.env.ALERT_EMAIL || 'david@firmustech.com';

  // Priority prefixes
  const prefixes = {
    critical: '🚨 CRITICAL: ',
    warning: '⚠️ WARNING: ',
    info: 'ℹ️ INFO: '
  };

  const fullSubject = `${prefixes[priority] || ''}OpenWord Dashboard - ${subject}`;

  const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: ${priority === 'critical' ? '#dc2626' : priority === 'warning' ? '#f59e0b' : '#3b82f6'}; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
        .content { background: #f9fafb; padding: 20px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; }
        .footer { margin-top: 20px; font-size: 12px; color: #6b7280; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2 style="margin: 0;">${fullSubject}</h2>
        </div>
        <div class="content">
          ${message}
          <div class="footer">
            <p>This is an automated alert from OpenWord Dashboard</p>
            <p>Time: ${new Date().toISOString()}</p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      console.log(`📧 [Email disabled] Would send to ${alertEmail}: ${fullSubject}`);
      console.log(`   Message: ${message.replace(/<[^>]*>/g, '').substring(0, 200)}...`);
      return { success: true, simulated: true };
    }

    await transporter.sendMail({
      from: `"OpenWord Dashboard" <${process.env.SMTP_USER}>`,
      to: alertEmail,
      subject: fullSubject,
      html: htmlBody,
    });

    console.log(`📧 Alert sent to ${alertEmail}: ${subject}`);
    return { success: true };
  } catch (error) {
    console.error('❌ Failed to send alert email:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Send critical alert
 */
export async function sendCriticalAlert(subject, message) {
  return sendAlert(subject, message, 'critical');
}

/**
 * Send warning alert
 */
export async function sendWarningAlert(subject, message) {
  return sendAlert(subject, message, 'warning');
}

export default { sendAlert, sendCriticalAlert, sendWarningAlert };
