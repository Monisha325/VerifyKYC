'use client';
import { useEffect }  from 'react';
import { useRouter }  from 'next/navigation';
import { useAuth }    from '@/context/AuthContext';
import { PageLoader } from '@/components/ui/LoadingSpinner';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const { accessToken, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && accessToken) router.replace('/dashboard');
  }, [loading, accessToken, router]);

  // Block until session restore finishes. Without this, a user with a valid
  // refresh cookie can fill in the register form while loading=true, submit it,
  // and then get silently redirected to /dashboard when the cookie check
  // completes — the new account is created but the /verify-email redirect races
  // against the /dashboard redirect and loses.
  if (loading) return <PageLoader />;

  // Already logged in — redirect effect above will fire; render nothing to
  // prevent a flash of the auth form.
  if (accessToken) return null;

  return <>{children}</>;
}
