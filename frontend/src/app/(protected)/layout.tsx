'use client';
import { useEffect }  from 'react';
import { useRouter }  from 'next/navigation';
import { useAuth }    from '@/context/AuthContext';
import { PageLoader } from '@/components/ui/LoadingSpinner';
import AppShell       from '@/components/layout/AppShell';
import { ApplicationProvider } from '@/context/ApplicationContext';

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const { accessToken, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !accessToken) router.replace('/login');
  }, [loading, accessToken, router]);

  if (loading)      return <PageLoader />;
  if (!accessToken) return null;

  return (
    <ApplicationProvider>
      <AppShell>{children}</AppShell>
    </ApplicationProvider>
  );
}
