'use client';
import { useEffect }  from 'react';
import { useRouter }  from 'next/navigation';
import { useAuth }    from '@/context/AuthContext';
import { PageLoader } from '@/components/ui/LoadingSpinner';
import AppShell       from '@/components/layout/AppShell';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, accessToken, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!accessToken)                    { router.replace('/login');     return; }
    if (user && user.role === 'APPLICANT') { router.replace('/dashboard');        }
  }, [loading, accessToken, user, router]);

  if (loading) return <PageLoader />;
  if (!accessToken) return null;
  if (user && user.role === 'APPLICANT') return null;

  return <AppShell wide>{children}</AppShell>;
}
