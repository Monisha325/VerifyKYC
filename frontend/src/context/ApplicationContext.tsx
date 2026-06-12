'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api }             from '@/lib/api';
import type { Application } from '@/lib/types';

interface AppCtx {
  app:     Application | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AppCtx>({ app: null, loading: true, refresh: async () => {} });

export function ApplicationProvider({ children }: { children: React.ReactNode }) {
  const [app,     setApp]     = useState<Application | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get<Application[]>('/applications');
      const latest   = [...data].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )[0] ?? null;
      setApp(latest);
    } catch {
      setApp(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return <Ctx.Provider value={{ app, loading, refresh }}>{children}</Ctx.Provider>;
}

export const useApplication = () => useContext(Ctx);
