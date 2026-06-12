'use client';
import { useState }    from 'react';
import { useRouter }   from 'next/navigation';
import { useForm }     from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z }           from 'zod';
import Link            from 'next/link';
import { ShieldCheck, User, Mail, Lock, ArrowRight, CheckCircle2, XCircle } from 'lucide-react';
import { useAuth }     from '@/context/AuthContext';
import Button          from '@/components/ui/Button';
import Input           from '@/components/ui/Input';

const schema = z.object({
  fullName: z.string().min(2,  'Enter your full name'),
  email: z.string()
    .email('Enter a valid email')
    .refine((v) => v.trim().toLowerCase().endsWith('@gmail.com'), {
      message: 'Only Gmail addresses are allowed.',
    }),
  password: z.string()
    .min(8,  'At least 8 characters')
    .max(128, 'Password too long'),
});
type FormData = z.infer<typeof schema>;

const STEPS = [
  { num: '01', label: 'Create account' },
  { num: '02', label: 'Upload documents' },
  { num: '03', label: 'AI verification' },
  { num: '04', label: 'Approved' },
];

const PASSWORD_RULES = [
  { id: 'length',    label: 'At least 8 characters',          test: (p: string) => p.length >= 8 },
  { id: 'uppercase', label: 'At least one uppercase letter',  test: (p: string) => /[A-Z]/.test(p) },
  { id: 'lowercase', label: 'At least one lowercase letter',  test: (p: string) => /[a-z]/.test(p) },
  { id: 'number',    label: 'At least one number',            test: (p: string) => /[0-9]/.test(p) },
  { id: 'special',   label: 'At least one special character', test: (p: string) => /[^A-Za-z0-9]/.test(p) },
];

export default function RegisterPage() {
  const { register: registerUser } = useAuth();
  const router    = useRouter();
  const [error, setError] = useState('');
  const [passwordFocused, setPasswordFocused] = useState(false);

  const {
    register, handleSubmit, watch, setError: setFieldError,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  const passwordField = register('password');
  const passwordValue = watch('password') ?? '';

  async function onSubmit(data: FormData) {
    setError('');

    const allRulesPassed = PASSWORD_RULES.every(r => r.test(passwordValue));
    if (!allRulesPassed) {
      setFieldError('password', { message: 'Password does not meet all requirements above.' });
      return;
    }

    try {
      await registerUser(data.email, data.password, data.fullName);
      sessionStorage.setItem('verikyc_pending_email', data.email);
      router.replace('/verify-email');
    } catch (e: unknown) {
      // Clear any stale pending-email so verify-email doesn't open with the
      // wrong address if the user previously got redirected mid-registration.
      sessionStorage.removeItem('verikyc_pending_email');
      const err = e as {
        response?: {
          data?: { error?: string; details?: { fieldErrors?: Record<string, string[]> } };
          status?: number;
        };
      };
      const status = err.response?.status;
      const serverMsg = err.response?.data?.error;
      const fieldErrors = err.response?.data?.details?.fieldErrors;
      const firstFieldError = fieldErrors ? Object.values(fieldErrors).flat()[0] : undefined;
      const msg = !err.response
        ? 'Cannot reach the server. Make sure you are online and try again.'
        : status === 409
          ? 'This email is already registered. Try signing in instead.'
          : status && status >= 500
            ? 'Something went wrong on our end. Please try again in a moment.'
            : firstFieldError ?? serverMsg ?? 'Registration failed. Please try again.';
      setError(msg);
    }
  }

  return (
    <div className="min-h-screen flex">

      {/* ── Left: brand hero ── */}
      <div className="hidden lg:flex lg:w-[44%] bg-navy-gradient flex-col justify-between p-10 xl:p-14">
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="w-8 h-8 text-brand-green" />
          <span className="text-xl font-bold text-white tracking-tight">VeriKYC</span>
        </div>

        <div className="space-y-10">
          <div>
            <h1 className="text-4xl xl:text-5xl font-bold text-white leading-tight">
              Get verified in
              <br />
              <span className="text-brand-green">4 simple steps.</span>
            </h1>
            <p className="mt-4 text-blue-200 text-base max-w-sm">
              Create your account and complete identity verification entirely online — no branch visits, no waiting.
            </p>
          </div>

          <ol className="space-y-4">
            {STEPS.map((s, i) => (
              <li key={s.num} className="flex items-center gap-4">
                <span className={`
                  flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold
                  ${i === 0 ? 'bg-brand-green text-white' : 'bg-white/10 text-blue-300'}
                `}>
                  {i === 0 ? <CheckCircle2 className="w-5 h-5" /> : s.num}
                </span>
                <span className={`text-sm ${i === 0 ? 'text-white font-semibold' : 'text-blue-300'}`}>
                  {s.label}
                </span>
              </li>
            ))}
          </ol>
        </div>

        <p className="text-blue-300 text-xs">
          © {new Date().getFullYear()} VeriKYC. Secure & Compliant.
        </p>
      </div>

      {/* ── Right: form ── */}
      <div className="flex-1 flex items-center justify-center bg-gray-50 px-6 py-12">
        <div className="w-full max-w-sm animate-fade-up">

          {/* Mobile logo */}
          <div className="flex items-center gap-2 mb-8 lg:hidden">
            <ShieldCheck className="w-7 h-7 text-brand-navy" />
            <span className="text-lg font-bold text-brand-navy">VeriKYC</span>
          </div>

          <h2 className="text-2xl font-bold text-gray-900">Create your account</h2>
          <p className="mt-1 text-sm text-gray-500">Start your identity verification today</p>

          <form onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-4">
            <Input
              label="Full name"
              type="text"
              autoComplete="name"
              placeholder="Rahul Kumar"
              icon={<User className="w-4 h-4" />}
              error={errors.fullName?.message}
              {...register('fullName')}
            />
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
              autoComplete="new-password"
              placeholder="Min. 8 characters"
              icon={<Lock className="w-4 h-4" />}
              error={errors.password?.message}
              {...passwordField}
              onFocus={() => setPasswordFocused(true)}
              onBlur={(e) => {
                passwordField.onBlur(e);
                setPasswordFocused(false);
              }}
            />
            {(passwordFocused || passwordValue.length > 0) && (
              <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
                {PASSWORD_RULES.map(rule => {
                  const passed = rule.test(passwordValue);
                  return (
                    <li key={rule.id} className="flex items-center gap-1.5 text-xs">
                      {passed
                        ? <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />
                        : <XCircle      className="w-3 h-3 text-gray-300    flex-shrink-0" />}
                      <span className={passed ? 'text-emerald-600' : 'text-gray-400'}>
                        {rule.label}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}

            {error && (
              <div className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700">
                {error}
              </div>
            )}

            <Button type="submit" className="w-full mt-2" size="lg" loading={isSubmitting}>
              Create account
              {!isSubmitting && <ArrowRight className="w-4 h-4" />}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-gray-500">
            Already have an account?{' '}
            <Link href="/login" className="font-semibold text-brand-navy hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
