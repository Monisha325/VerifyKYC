import crypto from 'crypto';
import { BrevoClient } from '@getbrevo/brevo';
import { prisma }   from '../../utils/prisma';
import { AppError } from '../../middleware/errorHandler';

// Brevo's Transactional Email API (HTTPS) — not SMTP. Render's free tier
// blocks outbound SMTP ports (25/465/587), so OTP delivery goes through
// Brevo's REST API instead, authenticated with an API key.
//
// NB: @getbrevo/brevo v5 replaced the old `TransactionalEmailsApi` class
// (new TransactionalEmailsApi() + setApiKey()) with a single `BrevoClient`
// exposing `.transactionalEmails.sendTransacEmail(...)` — the method name
// survived the redesign, the class/instantiation pattern did not.
let _brevo: BrevoClient | null = null;
function getBrevoClient(): BrevoClient | null {
  if (!process.env.BREVO_API_KEY) return null;
  if (!_brevo) _brevo = new BrevoClient({ apiKey: process.env.BREVO_API_KEY });
  return _brevo;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function generateOtp(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashOtp(otp: string): string {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

// ── HTML template ─────────────────────────────────────────────────────────────

function buildHtml(otp: string): string {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Inter,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding:40px 0;">
        <table width="480" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:12px;
                      overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background:#1B4F72;padding:32px;text-align:center;">
              <h1 style="color:#ffffff;margin:0;font-size:24px;
                         font-weight:700;letter-spacing:1px;">VeriKYC</h1>
              <p style="color:#2874A6;margin:8px 0 0;font-size:13px;">
                AI-Powered Identity Verification
              </p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px 32px;">
              <h2 style="color:#1B4F72;margin:0 0 8px;font-size:20px;">
                Your verification code
              </h2>
              <p style="color:#666;margin:0 0 24px;font-size:15px;line-height:1.5;">
                Enter this code to verify your email address and
                activate your VeriKYC account.
              </p>
              <!-- OTP Box -->
              <div style="background:#f0f4f8;border:2px solid #1B4F72;
                          border-radius:12px;padding:28px;text-align:center;
                          margin:0 0 24px;">
                <p style="margin:0 0 8px;font-size:13px;color:#666;
                          text-transform:uppercase;letter-spacing:1px;">
                  Verification Code
                </p>
                <span style="font-size:42px;font-weight:700;
                             letter-spacing:12px;color:#1B4F72;
                             font-family:'Courier New',monospace;">
                  ${otp}
                </span>
              </div>
              <!-- Warning -->
              <div style="background:#fff3cd;border-left:4px solid #D35400;
                          border-radius:4px;padding:12px 16px;margin:0 0 24px;">
                <p style="margin:0;font-size:13px;color:#856404;">
                  &#9888;&#65039; This code expires in <strong>10 minutes</strong>.
                  Never share it with anyone.
                </p>
              </div>
              <p style="color:#999;font-size:12px;margin:0;line-height:1.6;">
                If you did not create a VeriKYC account, you can safely
                ignore this email.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f8f9fa;padding:20px 32px;
                       border-top:1px solid #e9ecef;text-align:center;">
              <p style="margin:0;font-size:12px;color:#999;">
                &copy; ${new Date().getFullYear()} VeriKYC. Secure &amp; Compliant.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function sendOtpEmail(email: string, otp: string): Promise<void> {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔑 OTP for:', email);
  console.log('📟 Code:   ', otp);
  console.log('⏰ Expires:  10 minutes');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const brevo = getBrevoClient();
  if (!brevo) {
    console.log('[OTP] ⚠️  BREVO_API_KEY not set — email not sent.');
    return;
  }
  if (!process.env.BREVO_FROM_EMAIL) {
    console.error('[OTP] ❌ BREVO_FROM_EMAIL not set — cannot send without a sender address.');
    return;
  }

  try {
    const result = await brevo.transactionalEmails.sendTransacEmail({
      sender:      { email: process.env.BREVO_FROM_EMAIL, name: 'VeriKYC' },
      to:          [{ email }],
      subject:     'Your VeriKYC Verification Code',
      htmlContent: buildHtml(otp),
    });

    console.log('[OTP] ✅ OTP email sent to:', email);
    console.log('[OTP] 📨 Message ID:', result.messageId);
  } catch (err: unknown) {
    const e = err as { message?: string };
    console.error('[OTP] ❌ sendOtpEmail failed:', e.message ?? String(err));
    // OTP is still valid in DB — user can retry. Don't throw so registration succeeds.
  }
}

export async function createOtpRecord(userId: string, otp: string): Promise<void> {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  console.log(`[OTP] 💾 Storing OTP hash for userId: ${userId}`);
  await prisma.emailVerification.upsert({
    where:  { userId },
    create: { userId, otp: hashOtp(otp), expiresAt, verified: false },
    update: { otp: hashOtp(otp), expiresAt, verified: false },
  });
}

export async function verifyOtp(userId: string, otp: string): Promise<void> {
  const record = await prisma.emailVerification.findUnique({ where: { userId } });

  if (!record || record.expiresAt < new Date() || record.otp !== hashOtp(otp)) {
    throw new AppError(401, 'Invalid or expired OTP');
  }
  if (record.verified) {
    throw new AppError(409, 'Email already verified');
  }

  await prisma.$transaction([
    prisma.emailVerification.update({ where: { userId }, data: { verified: true } }),
    prisma.user.update({ where: { id: userId }, data: { emailVerified: true } }),
  ]);
}
