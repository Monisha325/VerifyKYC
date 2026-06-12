'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth }   from '@/context/AuthContext';
import { PageLoader } from '@/components/ui/LoadingSpinner';

export default function Home() {
  const { accessToken, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    router.replace(accessToken ? '/dashboard' : '/login');
  }, [loading, accessToken, router]);

  return <PageLoader />;
}
