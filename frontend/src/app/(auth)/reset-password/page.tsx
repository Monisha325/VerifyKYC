'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link              from 'next/link';
import { useForm }       from 'react-hook-form';
import { zodResolver }   from '@hookform/resolvers/zod';
import { z }             from 'zod';
import { ShieldCheck, Lock, ArrowRight, CheckCircle2 } from 'lucide-react';
import { authApi }       from '@/lib/api';
import Button            from '@/components/ui/Button';
import Input             from '@/components/ui/Input';

const schema = z.object({
  newPassword:     z.string().min(8, 'Password must be at least 8 characters'),
  confirmPassword: z.string(),
}).refine(data => data.newPassword === data.confirmPassword, {
  message: 'Passwords do not match',
  path:    ['confirmPassword'],
});
type FormData = z.infer<typeof schema>;

function ResetPasswordInner() {
  const router       = useRouter();
  const searchParams  = useSearchParams();
  // The token is long enough that it could plausibly pick up stray whitespace
  // from wherever it transited — strip all of it defensively, same as the
  // backend already does, since a valid JWT never legitimately contains any.
  const token = (searchParams.get('token') ?? '').replace(/\s+/g, '');

  const [succeeded, setSucceeded] = useState(false);
  const [error,     setError]     = useState('');

  const {
    register, handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  async function onSubmit(data: FormData) {
    setError('');
    try {
      await authApi.post('/auth/reset-password', {
        resetToken:  token,
        newPassword: data.newPassword,
      });
      setSucceeded(true);
      setTimeout(() => router.replace('/login'), 1800);
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      setError(err.response?.data?.error ?? 'This link is invalid or has expired. Please request a new one.');
    }
  }

  return (
    <div className="min-h-screen flex">
      <div className="hidden lg:flex lg:w-[44%] bg-navy-gradient flex-col justify-between p-10 xl:p-14">
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="w-8 h-8 text-brand-green" />
          <span className="font-mono text-xl font-bold text-white tracking-tight">VeriKYC</span>
        </div>
        <div className="space-y-8">
          <h1 className="font-mono text-4xl xl:text-5xl font-bold text-white leading-tight">
            Choose a new
            <br />
            <span className="text-brand-green">password.</span>
          </h1>
        </div>
        <p className="text-blue-300 text-xs">
          © {new Date().getFullYear()} VeriKYC. Secure &amp; Compliant.
        </p>
      </div>

      <div className="flex-1 flex items-center justify-center bg-gray-50 px-6 py-12">
        <div className="w-full max-w-sm animate-fade-up">
          <div className="flex items-center gap-2 mb-8 lg:hidden">
            <ShieldCheck className="w-7 h-7 text-brand-navy" />
            <span className="font-mono text-lg font-bold text-brand-navy">VeriKYC</span>
          </div>

          {!token ? (
            <div className="text-center space-y-4">
              <h2 className="text-2xl font-bold text-gray-900">Missing reset link</h2>
              <p className="text-sm text-gray-500">
                This page needs a valid reset link from your email.
              </p>
              <Link href="/forgot-password" className="inline-block mt-2 text-sm font-semibold text-brand-navy hover:text-brand-blue">
                Request a new link
              </Link>
            </div>
          ) : succeeded ? (
            <div className="text-center space-y-4">
              <div className="mx-auto w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
                <CheckCircle2 className="w-8 h-8 text-green-600" />
              </div>
              <h2 className="font-mono text-2xl font-bold text-gray-900">Password reset!</h2>
              <p className="text-sm text-gray-500">Redirecting you to sign in…</p>
            </div>
          ) : (
            <>
              <h2 className="text-2xl font-bold text-gray-900">Choose a new password</h2>
              <p className="mt-1 text-sm text-gray-500">
                This will sign you out everywhere else.
              </p>

              <form onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-4">
                <Input
                  label="New password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="••••••••"
                  icon={<Lock className="w-4 h-4" />}
                  error={errors.newPassword?.message}
                  {...register('newPassword')}
                />
                <Input
                  label="Confirm new password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="••••••••"
                  icon={<Lock className="w-4 h-4" />}
                  error={errors.confirmPassword?.message}
                  {...register('confirmPassword')}
                />

                {error && (
                  <div className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700">
                    {error}
                  </div>
                )}

                <Button type="submit" className="w-full mt-2" size="lg" loading={isSubmitting}>
                  Reset password
                  {!isSubmitting && <ArrowRight className="w-4 h-4" />}
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordInner />
    </Suspense>
  );
}
