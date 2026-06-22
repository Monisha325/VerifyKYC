'use client';
import { useState } from 'react';
import Link             from 'next/link';
import { useForm }      from 'react-hook-form';
import { zodResolver }  from '@hookform/resolvers/zod';
import { z }            from 'zod';
import { ShieldCheck, Mail, ArrowRight, CheckCircle2 } from 'lucide-react';
import { authApi }      from '@/lib/api';
import Button           from '@/components/ui/Button';
import Input            from '@/components/ui/Input';

const schema = z.object({
  email: z.string().email('Enter a valid email'),
});
type FormData = z.infer<typeof schema>;

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const {
    register, handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  async function onSubmit(data: FormData) {
    setError('');
    try {
      await authApi.post('/auth/forgot-password', data);
      // Always show the same success state regardless of whether the email
      // exists — the backend already returns a generic message either way,
      // to avoid leaking account existence.
      setSent(true);
    } catch {
      setError('Something went wrong. Please try again.');
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
            Forgot your
            <br />
            <span className="text-brand-green">password?</span>
          </h1>
          <p className="text-blue-200 text-lg leading-relaxed max-w-sm">
            Enter your email and we&apos;ll send you a link to choose a new one.
          </p>
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

          {sent ? (
            <div className="text-center space-y-4">
              <div className="mx-auto w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
                <CheckCircle2 className="w-8 h-8 text-green-600" />
              </div>
              <h2 className="font-mono text-2xl font-bold text-gray-900">Check your inbox</h2>
              <p className="text-sm text-gray-500">
                If that email is registered, a password reset link is on its way.
                It expires in 30 minutes.
              </p>
              <Link href="/login" className="inline-block mt-4 text-sm font-semibold text-brand-navy hover:text-brand-blue">
                Back to sign in
              </Link>
            </div>
          ) : (
            <>
              <h2 className="text-2xl font-bold text-gray-900">Reset your password</h2>
              <p className="mt-1 text-sm text-gray-500">
                We&apos;ll email you a link to choose a new password.
              </p>

              <form onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-4">
                <Input
                  label="Email address"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  icon={<Mail className="w-4 h-4" />}
                  error={errors.email?.message}
                  {...register('email')}
                />

                {error && (
                  <div className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700">
                    {error}
                  </div>
                )}

                <Button type="submit" className="w-full mt-2" size="lg" loading={isSubmitting}>
                  Send reset link
                  {!isSubmitting && <ArrowRight className="w-4 h-4" />}
                </Button>
              </form>

              <p className="mt-6 text-center text-sm text-gray-500">
                Remembered your password?{' '}
                <Link href="/login" className="font-semibold text-brand-navy hover:text-brand-blue">
                  Sign in
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
