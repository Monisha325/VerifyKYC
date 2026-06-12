'use client';
import {
  useState, useEffect, useRef, useCallback, KeyboardEvent, ClipboardEvent,
} from 'react';
import { useRouter }  from 'next/navigation';
import { ShieldCheck, CheckCircle2, Mail, RefreshCw } from 'lucide-react';
import { authApi }    from '@/lib/api';
import Button         from '@/components/ui/Button';

const OTP_LENGTH = 6;
const RESEND_COOLDOWN = 60;

export default function VerifyEmailPage() {
  const router = useRouter();

  const [email,      setEmail]      = useState('');
  const [digits,     setDigits]     = useState<string[]>(Array(OTP_LENGTH).fill(''));
  const [error,      setError]      = useState('');
  const [shaking,    setShaking]    = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [succeeded,  setSucceeded]  = useState(false);
  const [cooldown,   setCooldown]   = useState(0);
  const [resending,  setResending]  = useState(false);

  const inputRefs = useRef<Array<HTMLInputElement | null>>(Array(OTP_LENGTH).fill(null));

  // ── Guard: redirect to register if no pending email ──────────────────────
  useEffect(() => {
    const storedEmail = sessionStorage.getItem('verikyc_pending_email');
    if (!storedEmail) {
      // No pending registration — send back to register rather than showing a
      // broken OTP form with an empty email address.
      router.replace('/register');
      return;
    }
    setEmail(storedEmail);
    inputRefs.current[0]?.focus();
  }, [router]);

  // ── Resend countdown ───────────────────────────────────────────────────────
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  // ── Auto-submit when all 6 digits filled ──────────────────────────────────
  const allFilled = digits.every(d => d !== '');
  useEffect(() => {
    if (allFilled && !submitting && !succeeded) handleVerify();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allFilled]);

  // ── Shake on wrong OTP ────────────────────────────────────────────────────
  const triggerShake = useCallback(() => {
    setShaking(true);
    setDigits(Array(OTP_LENGTH).fill(''));
    setTimeout(() => { setShaking(false); inputRefs.current[0]?.focus(); }, 500);
  }, []);

  // ── Submit ─────────────────────────────────────────────────────────────────
  async function handleVerify() {
    const otp = digits.join('');
    if (otp.length < OTP_LENGTH) return;
    setSubmitting(true);
    setError('');
    try {
      await authApi.post('/auth/verify-email', { email, otp });
      setSucceeded(true);
      sessionStorage.removeItem('verikyc_pending_email');
      setTimeout(() => router.replace('/login?verified=1'), 1500);
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      setError(err.response?.data?.error ?? 'Invalid or expired OTP. Please try again.');
      triggerShake();
    } finally {
      setSubmitting(false);
    }
  }

  // ── Resend ─────────────────────────────────────────────────────────────────
  async function handleResend() {
    if (cooldown > 0 || resending) return;
    setResending(true);
    setError('');
    try {
      const { data } = await authApi.post<{ message: string }>(
        '/auth/resend-otp', { email }
      );
      setCooldown(RESEND_COOLDOWN);
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      setError(err.response?.data?.error ?? 'Could not resend code. Please try again.');
    } finally {
      setResending(false);
    }
  }

  // ── Input handlers ─────────────────────────────────────────────────────────
  function handleChange(index: number, value: string) {
    const digit = value.replace(/\D/g, '').slice(-1);
    const next  = [...digits];
    next[index] = digit;
    setDigits(next);
    setError('');
    if (digit && index < OTP_LENGTH - 1) inputRefs.current[index + 1]?.focus();
  }

  function handleKeyDown(index: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace') {
      if (digits[index]) {
        const next = [...digits]; next[index] = ''; setDigits(next);
      } else if (index > 0) {
        const next = [...digits]; next[index - 1] = ''; setDigits(next);
        inputRefs.current[index - 1]?.focus();
      }
    }
    if (e.key === 'ArrowLeft'  && index > 0)              inputRefs.current[index - 1]?.focus();
    if (e.key === 'ArrowRight' && index < OTP_LENGTH - 1) inputRefs.current[index + 1]?.focus();
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH);
    if (!pasted) return;
    const next = [...digits];
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i];
    setDigits(next);
    inputRefs.current[Math.min(pasted.length, OTP_LENGTH - 1)]?.focus();
  }

  const maskedEmail = email
    ? email.replace(/(.{2})(.*)(@.*)/, (_, a, b, c) => a + b.replace(/./g, '•') + c)
    : '...';

  return (
    <div className="min-h-screen flex">

      {/* ── Left: brand panel ──────────────────────────────────────────────── */}
      <div className="hidden lg:flex lg:w-[44%] bg-navy-gradient flex-col justify-between p-10 xl:p-14">
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="w-8 h-8 text-brand-green" />
          <span className="font-mono text-xl font-bold text-white tracking-tight">VeriKYC</span>
        </div>

        <div className="space-y-8">
          <div>
            <h1 className="font-mono text-4xl xl:text-5xl font-bold text-white leading-tight">
              One step away.
              <br />
              <span className="text-brand-green">Verify your inbox.</span>
            </h1>
            <p className="mt-4 text-blue-200 text-lg leading-relaxed max-w-sm">
              We send a one-time code to confirm you own this address before granting access.
            </p>
          </div>

          <ul className="space-y-3">
            {[
              'Code expires in 10 minutes',
              'Check your spam folder if not received',
              'Request a new code if it expires',
            ].map(t => (
              <li key={t} className="flex items-center gap-3 text-blue-100 text-sm">
                <CheckCircle2 className="w-5 h-5 text-brand-green flex-shrink-0" />
                {t}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-blue-300 text-xs">
          © {new Date().getFullYear()} VeriKYC. Secure &amp; Compliant.
        </p>
      </div>

      {/* ── Right: OTP form ────────────────────────────────────────────────── */}
      <div className="flex-1 flex items-center justify-center bg-gray-50 px-6 py-12">
        <div className="w-full max-w-sm animate-fade-up">

          {/* Mobile logo */}
          <div className="flex items-center gap-2 mb-8 lg:hidden">
            <ShieldCheck className="w-7 h-7 text-brand-navy" />
            <span className="font-mono text-lg font-bold text-brand-navy">VeriKYC</span>
          </div>

          {succeeded ? (
            <div className="text-center space-y-4">
              <div className="mx-auto w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
                <CheckCircle2 className="w-8 h-8 text-green-600" />
              </div>
              <h2 className="font-mono text-2xl font-bold text-gray-900">Email verified!</h2>
              <p className="text-sm text-gray-500">Redirecting you to sign in…</p>
            </div>
          ) : (
            <>
              {/* Icon */}
              <div className="mb-6 w-14 h-14 rounded-2xl bg-brand-navy/10 flex items-center justify-center">
                <Mail className="w-7 h-7 text-brand-navy" />
              </div>

              <h2 className="font-mono text-2xl font-bold text-gray-900">Check your inbox</h2>
              <p className="mt-2 text-sm text-gray-500 leading-relaxed">
                We sent a 6-digit code to{' '}
                <span className="font-semibold text-gray-700">{maskedEmail}</span>.
                Check your inbox and spam folder.
              </p>

              {/* OTP boxes */}
              <div
                className={`mt-8 flex gap-3 justify-center ${shaking ? 'animate-shake' : ''}`}
                aria-label="One-time password input"
              >
                {digits.map((d, i) => (
                  <input
                    key={i}
                    ref={el => { inputRefs.current[i] = el; }}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    value={d}
                    onChange={e  => handleChange(i, e.target.value)}
                    onKeyDown={e => handleKeyDown(i, e)}
                    onPaste={handlePaste}
                    disabled={submitting || succeeded}
                    aria-label={`Digit ${i + 1}`}
                    className={[
                      'w-11 h-14 rounded-xl border-2 text-center font-mono text-xl font-bold',
                      'transition-all duration-150 outline-none',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                      error
                        ? 'border-rose-400 bg-rose-50 text-rose-700'
                        : d
                          ? 'border-brand-navy bg-brand-navy/5 text-brand-navy'
                          : 'border-gray-200 bg-white text-gray-900 focus:border-brand-navy focus:ring-2 focus:ring-brand-navy/20',
                    ].join(' ')}
                  />
                ))}
              </div>

              {error && (
                <p className="mt-4 text-center text-sm text-rose-600 font-medium">{error}</p>
              )}

              <Button
                className="w-full mt-6"
                size="lg"
                loading={submitting}
                disabled={!allFilled || submitting}
                onClick={handleVerify}
              >
                Verify code
              </Button>

              <div className="mt-5 text-center">
                {cooldown > 0 ? (
                  <p className="text-sm text-gray-500">
                    Resend available in{' '}
                    <span className="font-mono font-semibold text-brand-navy">{cooldown}s</span>
                  </p>
                ) : (
                  <button
                    onClick={handleResend}
                    disabled={resending}
                    className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-navy hover:text-brand-blue disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${resending ? 'animate-spin' : ''}`} />
                    {resending ? 'Sending…' : 'Resend code'}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
