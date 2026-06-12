'use client';
import { Suspense, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm }       from 'react-hook-form';
import { zodResolver }   from '@hookform/resolvers/zod';
import { z }             from 'zod';
import Link              from 'next/link';
import { ShieldCheck, Mail, Lock, ArrowRight, CheckCircle2, RefreshCw } from 'lucide-react';
import { useAuth }       from '@/context/AuthContext';
import { authApi }       from '@/lib/api';
import Button            from '@/components/ui/Button';
import Input             from '@/components/ui/Input';

const schema = z.object({
  email: z.string()
    .email('Enter a valid email')
    .refine((v) => v.trim().toLowerCase().endsWith('@gmail.com'), {
      message: 'Only Gmail addresses are allowed.',
    }),
  password: z.string().min(1, 'Password is required'),
});
type FormData = z.infer<typeof schema>;

const TRUST = [
  'AI-powered identity analysis',
  'Bank-grade security & encryption',
  'Verification in minutes, not days',
];

function LoginInner() {
  const { login }      = useAuth();
  const router         = useRouter();
  const searchParams   = useSearchParams();

  const [error,           setError]           = useState('');
  const [showResend,      setShowResend]      = useState(false);
  const [unverifiedEmail, setUnverifiedEmail] = useState('');
  const [resending,       setResending]       = useState(false);
  const [resendSent,      setResendSent]      = useState(false);
  const [verifiedBanner,  setVerifiedBanner]  = useState(false);

  // Show success banner if redirected from /verify-email
  useEffect(() => {
    if (searchParams.get('verified') === '1') setVerifiedBanner(true);
  }, [searchParams]);

  const {
    register, handleSubmit, getValues,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  async function onSubmit(data: FormData) {
    setError('');
    setShowResend(false);
    setUnverifiedEmail('');
    setResendSent(false);
    try {
      await login(data.email, data.password);
      router.replace('/dashboard');
    } catch (e: unknown) {
      const err = e as {
        response?: {
          data?: { error?: string; code?: string; details?: { fieldErrors?: Record<string, string[]> } };
          status?: number;
        };
        code?: string; message?: string;
      };
      const status    = err.response?.status;
      const errorCode = err.response?.data?.code;

      if (!err.response) {
        setError('Cannot reach the server — check that the core service is running.');
        setShowResend(false);
      } else if (status === 403 && errorCode === 'EMAIL_NOT_VERIFIED') {
        setUnverifiedEmail(data.email);
        setError('Please verify your email first.');
        setShowResend(true);
      } else if (status === 401) {
        setError(err.response?.data?.error ?? 'Invalid email or password.');
        setShowResend(false);
      } else if (status && status >= 500) {
        setError(`Server error (${status}) — check core service logs.`);
        setShowResend(false);
      } else {
        const fieldErrors = err.response?.data?.details?.fieldErrors;
        const firstFieldError = fieldErrors ? Object.values(fieldErrors).flat()[0] : undefined;
        setError(firstFieldError ?? err.response?.data?.error ?? 'Login failed. Please try again.');
        setShowResend(false);
      }
    }
  }

  async function handleResendOtp() {
    if (resending) return;
    setResending(true);
    setError('');
    try {
      const email = unverifiedEmail || getValues('email');
      await authApi.post('/auth/resend-otp', { email });
      sessionStorage.setItem('verikyc_pending_email', email);
      setResendSent(true);
      setTimeout(() => router.push('/verify-email'), 800);
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      setError(err.response?.data?.error ?? 'Could not resend code. Please try again.');
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="min-h-screen flex">

      {/* ── Left: brand hero ── */}
      <div className="hidden lg:flex lg:w-[44%] bg-navy-gradient flex-col justify-between p-10 xl:p-14">
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="w-8 h-8 text-brand-green" />
          <span className="font-mono text-xl font-bold text-white tracking-tight">VeriKYC</span>
        </div>

        <div className="space-y-8">
          <div>
            <h1 className="font-mono text-4xl xl:text-5xl font-bold text-white leading-tight">
              Identity verified.
              <br />
              <span className="text-brand-green">Trust established.</span>
            </h1>
            <p className="mt-4 text-blue-200 text-lg leading-relaxed max-w-sm">
              The AI-powered KYC platform that processes government IDs in minutes with bank-grade accuracy.
            </p>
          </div>

          <ul className="space-y-3">
            {TRUST.map((t) => (
              <li key={t} className="flex items-center gap-3 text-blue-100 text-sm">
                <CheckCircle2 className="w-5 h-5 text-brand-green flex-shrink-0" />
                {t}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-blue-300 text-xs">
          © {new Date().getFullYear()} VeriKYC. Powered by AI.
        </p>
      </div>

      {/* ── Right: form ── */}
      <div className="flex-1 flex items-center justify-center bg-gray-50 px-6 py-12">
        <div className="w-full max-w-sm animate-fade-up">

          {/* Mobile logo */}
          <div className="flex items-center gap-2 mb-8 lg:hidden">
            <ShieldCheck className="w-7 h-7 text-brand-navy" />
            <span className="font-mono text-lg font-bold text-brand-navy">VeriKYC</span>
          </div>

          <h2 className="text-2xl font-bold text-gray-900">Welcome back</h2>
          <p className="mt-1 text-sm text-gray-500">Sign in to your account to continue</p>

          {/* Verified success banner */}
          {verifiedBanner && (
            <div className="mt-4 rounded-xl bg-green-50 border border-green-200 px-4 py-3 flex items-center gap-2 text-sm text-green-700">
              <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
              Email verified! You can now sign in.
            </div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-4">
            <Input
              label="Email address"
              type="email"
              autoComplete="email"
              placeholder="you@gmail.com"
              icon={<Mail className="w-4 h-4" />}
              error={errors.email?.message}
              {...register('email')}
            />
            <Input
              label="Password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              icon={<Lock className="w-4 h-4" />}
              error={errors.password?.message}
              {...register('password')}
            />

            {error && (
              <div className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700 space-y-2">
                <p>{error}</p>
                {showResend && (
                  <button
                    type="button"
                    onClick={handleResendOtp}
                    disabled={resending || resendSent}
                    className="inline-flex items-center gap-1.5 font-semibold text-brand-navy hover:text-brand-blue disabled:opacity-50 transition-colors"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${resending ? 'animate-spin' : ''}`} />
                    {resendSent ? 'Code sent — redirecting…' : resending ? 'Sending…' : 'Resend verification code'}
                  </button>
                )}
              </div>
            )}

            <Button type="submit" className="w-full mt-2" size="lg" loading={isSubmitting}>
              Sign in
              {!isSubmitting && <ArrowRight className="w-4 h-4" />}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-gray-500">
            Don&apos;t have an account?{' '}
            <Link href="/register" className="font-semibold text-brand-navy hover:underline">
              Create one
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
