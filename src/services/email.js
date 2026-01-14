/**
 * Email Service for Admin Alerts and Customer Communications
 *
 * Uses SendGrid via SMTP (recommended) or any SMTP provider
 *
 * Required env vars:
 *   SMTP_HOST=smtp.sendgrid.net
 *   SMTP_PORT=587
 *   SMTP_USER=apikey
 *   SMTP_PASS=SG.your_api_key
 *   SENDER_EMAIL=alerts@yourdomain.com (must be verified in SendGrid)
 *   SUPPORT_EMAIL=support@openword.live (for customer communications)
 *   ALERT_EMAIL=recipient@example.com
 */

import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

// Create transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.sendgrid.net',
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

    // SENDER_EMAIL must be verified in SendGrid (or use SMTP_USER for other providers)
    const senderEmail = process.env.SENDER_EMAIL || process.env.SMTP_USER;

    await transporter.sendMail({
      from: `"OpenWord Dashboard" <${senderEmail}>`,
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

/**
 * Send email to a customer
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} bodyHtml - Email body (HTML)
 * @param {string} recipientName - Customer/org name for personalization
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function sendCustomerEmail(to, subject, bodyHtml, recipientName = 'Customer') {
  const supportEmail = process.env.SUPPORT_EMAIL || 'support@openword.live';
  const serverUrl = process.env.OPENWORD_SERVER_URL || 'https://openword.onrender.com';

  const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f5f5f5; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .email-wrapper { background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .header { background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: white; padding: 20px 25px; }
        .content { padding: 30px 25px; background: white; }
        .content p { margin: 0 0 15px 0; }
        .footer { background: #f9fafb; padding: 20px 25px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280; text-align: center; }
        .footer a { color: #2563eb; text-decoration: none; }
        .button { display: inline-block; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin: 10px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="email-wrapper">
          <div class="header">
            <table cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr>
                <td width="80" valign="middle" style="padding-right: 15px;">
                  <div style="background: white; padding: 8px; border-radius: 8px; display: inline-block;">
                    <img src="https://openword.live/images/logo.png" alt="Open Word" width="60" height="60" style="display: block;">
                  </div>
                </td>
                <td valign="middle">
                  <h1 style="margin: 0; font-size: 24px; font-weight: 600; color: white;">Open Word</h1>
                  <p style="margin: 5px 0 0 0; opacity: 0.9; font-size: 14px; color: white;">Real-time Translation for Live Events</p>
                </td>
              </tr>
            </table>
          </div>
          <div class="content">
            ${bodyHtml}
          </div>
          <div class="footer">
            <p>This email was sent by Open Word</p>
            <p><a href="https://openword.live">openword.live</a> | <a href="mailto:${supportEmail}">${supportEmail}</a></p>
            <p style="margin-top: 15px; font-size: 11px; color: #9ca3af;">
              If you no longer wish to receive these emails, please contact us at ${supportEmail}
            </p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      console.log(`📧 [Email disabled] Would send to ${to}: ${subject}`);
      console.log(`   Body preview: ${bodyHtml.replace(/<[^>]*>/g, '').substring(0, 200)}...`);
      return { success: true, simulated: true };
    }

    await transporter.sendMail({
      from: `"Open Word Support" <${supportEmail}>`,
      replyTo: supportEmail,
      to: to,
      subject: subject,
      html: htmlBody,
    });

    console.log(`📧 Customer email sent to ${to}: ${subject}`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Failed to send customer email to ${to}:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Send bulk emails to multiple customers
 * @param {Array<{email: string, name: string, orgId: string}>} recipients - List of recipients
 * @param {string} subject - Email subject
 * @param {string} bodyHtml - Email body (HTML)
 * @param {number} delayMs - Delay between emails to avoid rate limiting (default 100ms)
 * @returns {Promise<{sent: number, failed: number, errors: Array}>}
 */
export async function sendBulkCustomerEmail(recipients, subject, bodyHtml, delayMs = 100) {
  const results = {
    sent: 0,
    failed: 0,
    errors: []
  };

  console.log(`📧 Starting bulk email to ${recipients.length} recipients...`);

  for (const recipient of recipients) {
    try {
      const result = await sendCustomerEmail(
        recipient.email,
        subject,
        bodyHtml,
        recipient.name
      );

      if (result.success) {
        results.sent++;
      } else {
        results.failed++;
        results.errors.push({
          email: recipient.email,
          orgId: recipient.orgId,
          error: result.error
        });
      }

      // Delay between emails to avoid rate limiting
      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    } catch (error) {
      results.failed++;
      results.errors.push({
        email: recipient.email,
        orgId: recipient.orgId,
        error: error.message
      });
    }
  }

  console.log(`📧 Bulk email complete: ${results.sent} sent, ${results.failed} failed`);
  return results;
}

export default { sendAlert, sendCriticalAlert, sendWarningAlert, sendCustomerEmail, sendBulkCustomerEmail };
