/**
 * API client — token stored IN MEMORY only (never localStorage).
 *
 * tokenStore.set() is called by AuthContext on login/register/refresh.
 * On a 401 the interceptor calls /auth/refresh once, retries, then emits
 * 'verikyc:logout' so AuthContext can clear state and redirect.
 */
import axios from 'axios';

// Use the same-origin proxy path by default so cookies work with SameSite=Strict.
// NEXT_PUBLIC_API_URL can override for direct-to-backend mode (e.g. non-Next.js consumers).
const BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api/v1';

// ── In-memory token (module-level; cleared on page close) ─────────────────────
let _token: string | null       = null;
let _refreshing: Promise<string> | null = null;

export const tokenStore = {
  get: ()               => _token,
  set: (t: string | null) => { _token = t; },
};

// ── Base client for auth routes (no token injection, no retry loop) ───────────
export const authApi = axios.create({ baseURL: BASE, withCredentials: true });

// ── Authenticated client ──────────────────────────────────────────────────────
export const api = axios.create({ baseURL: BASE, withCredentials: true, timeout: 120_000 });

api.interceptors.request.use((cfg) => {
  if (_token) cfg.headers.Authorization = `Bearer ${_token}`;
  return cfg;
});

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const cfg = err.config;

    if (err.response?.status !== 401 || cfg._retry) return Promise.reject(err);
    cfg._retry = true;

    try {
      if (!_refreshing) {
        _refreshing = authApi
          .post<{ accessToken: string }>('/auth/refresh')
          .then(({ data }) => { _token = data.accessToken; _refreshing = null; return data.accessToken; })
          .catch((e)       => { _refreshing = null; throw e; });
      }
      const newToken = await _refreshing;
      cfg.headers.Authorization = `Bearer ${newToken}`;
      return api(cfg);
    } catch {
      _token = null;
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('verikyc:logout'));
      return Promise.reject(err);
    }
  },
);
