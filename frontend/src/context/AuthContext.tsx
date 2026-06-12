'use client';

import {
  createContext, useCallback, useContext, useEffect, useState,
} from 'react';
import { authApi, api, tokenStore }          from '@/lib/api';
import type { User, AuthResponse, RegisterResponse } from '@/lib/types';

interface AuthCtx {
  user:        User | null;
  accessToken: string | null;
  loading:     boolean;
  login:    (email: string, password: string)                         => Promise<void>;
  register: (email: string, password: string, fullName: string)       => Promise<RegisterResponse>;
  logout:   ()                                                        => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user,        setUser]        = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loading,     setLoading]     = useState(true);

  const applyToken = useCallback((token: string | null, newUser?: User | null) => {
    tokenStore.set(token);
    setAccessToken(token);
    if (newUser !== undefined) setUser(newUser);
  }, []);

  // ── Restore session on page load ──────────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    authApi.post<{ accessToken: string }>('/auth/refresh')
      .then(async ({ data }) => {
        // Set token synchronously in the store so the next api call can use it
        tokenStore.set(data.accessToken);
        if (mounted) setAccessToken(data.accessToken);
        // Fetch user profile (role, fullName) using the new token
        const { data: me } = await api.get<User>('/auth/me');
        if (mounted) setUser(me);
      })
      .catch(() => {})
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Listen for logout events from the api-client interceptor ─────────────
  useEffect(() => {
    const handler = () => applyToken(null, null);
    window.addEventListener('verikyc:logout', handler);
    return () => window.removeEventListener('verikyc:logout', handler);
  }, [applyToken]);

  const login = useCallback(async (email: string, password: string) => {
    const { data } = await authApi.post<AuthResponse>('/auth/login', { email, password });
    applyToken(data.accessToken, data.user);
  }, [applyToken]);

  const register = useCallback(async (email: string, password: string, fullName: string): Promise<RegisterResponse> => {
    const { data } = await authApi.post<RegisterResponse>('/auth/register', { email, password, fullName });
    // No token yet — user must verify email first
    return data;
  }, []);

  const logout = useCallback(async () => {
    try { await authApi.post('/auth/logout'); } catch {}
    applyToken(null, null);
  }, [applyToken]);

  return (
    <Ctx.Provider value={{ user, accessToken, loading, login, register, logout }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
