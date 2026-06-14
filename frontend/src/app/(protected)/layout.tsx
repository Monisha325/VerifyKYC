'use client';
import { useEffect }  from 'react';
import { useRouter }  from 'next/navigation';
import { useAuth }    from '@/context/AuthContext';
import { PageLoader } from '@/components/ui/LoadingSpinner';
import AppShell       from '@/components/layout/AppShell';
import { ApplicationProvider } from '@/context/ApplicationContext';

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const { user, accessToken, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !accessToken) router.replace('/login');
  }, [loading, accessToken, router]);

  useEffect(() => {
    if (!loading && user && (user.role === 'REVIEWER' || user.role === 'ADMIN')) {
      router.replace('/admin/queue');
    }
  }, [loading, user, router]);

  if (loading)      return <PageLoader />;
  if (!accessToken) return null;
  if (user && (user.role === 'REVIEWER' || user.role === 'ADMIN')) return null;

  return (
    <ApplicationProvider>
      <AppShell>{children}</AppShell>
    </ApplicationProvider>
  );
}
