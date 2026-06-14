'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams }               from 'next/navigation';
import { Clock, Search, User }           from 'lucide-react';
import { api }                           from '@/lib/api';
import Button                            from '@/components/ui/Button';
import { PageLoader }                    from '@/components/ui/LoadingSpinner';
import { cn }                            from '@/lib/utils';

interface AuditActor {
  id:       string;
  fullName: string;
  email:    string;
  role:     string;
}

interface AuditEvent {
  id:            string;
  action:        string;
  entity:        string;
  entityId:      string | null;
  actorId:       string | null;
  applicationId: string | null;
  meta:          Record<string, unknown> | null;
  ipAddress:     string | null;
  createdAt:     string;
  actor:         AuditActor | null;
}

interface AuditResponse {
  entity:   string;
  entityId: string;
  count:    number;
  events:   AuditEvent[];
}

const ROLE_COLORS: Record<string, string> = {
  ADMIN:     'bg-rose-100 text-rose-700',
  REVIEWER:  'bg-amber-100 text-amber-700',
  APPLICANT: 'bg-blue-100 text-blue-700',
};

function AuditPage() {
  const searchParams               = useSearchParams();
  const [inputValue,  setInput]    = useState(searchParams.get('entityId') ?? '');
  const [data,        setData]     = useState<AuditResponse | null>(null);
  const [loading,     setLoading]  = useState(false);
  const [error,       setError]    = useState('');

  async function fetchAudit(id: string) {
    const trimmed = id.trim();
    if (!trimmed) return;
    setLoading(true);
    setError('');
    try {
      const { data: res } = await api.get<AuditResponse>(`/audit/KycApplication/${trimmed}`);
      setData(res);
    } catch (e: unknown) {
      setError(
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'Could not load audit trail.',
      );
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const id = searchParams.get('entityId');
    if (id) fetchAudit(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="animate-fade-up space-y-6">

      {/* ── Header ── */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Audit Trail</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Full event history for a KYC application. Admin access only.
        </p>
      </div>

      {/* ── Search bar ── */}
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
            Application ID
          </label>
          <input
            type="text"
            value={inputValue}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && fetchAudit(inputValue)}
            placeholder="e.g. clxxx123…"
            className={cn(
              'w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-mono',
              'focus:outline-none focus:ring-2 focus:ring-brand-navy/20 focus:border-brand-navy',
            )}
          />
        </div>
        <Button
          onClick={() => fetchAudit(inputValue)}
          loading={loading}
          disabled={!inputValue.trim()}
        >
          <Search className="w-4 h-4" />
          Fetch
        </Button>
      </div>

      {error && (
        <div className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* ── Results ── */}
      {loading && <PageLoader />}

      {data && !loading && (
        <div className="space-y-4">

          {/* Meta row */}
          <div className="flex items-center gap-3">
            <code className="text-xs text-gray-400 font-mono bg-gray-50 border border-gray-100 px-2 py-1 rounded-lg">
              {data.entityId}
            </code>
            <span className="text-sm text-gray-500">
              {data.count} event{data.count !== 1 ? 's' : ''}
            </span>
          </div>

          {data.events.length === 0 ? (
            <div className="text-center py-16 text-sm text-gray-400">
              No events found for this application.
            </div>
          ) : (
            <div className="relative">
              {/* Vertical spine */}
              <div className="absolute left-[19px] top-5 bottom-0 w-px bg-gray-100" />

              <div className="space-y-0">
                {data.events.map(evt => (
                  <div key={evt.id} className="relative flex gap-4 pb-5">

                    {/* Timeline dot */}
                    <div className="flex-shrink-0 w-10 h-10 rounded-full bg-white border-2 border-gray-200 flex items-center justify-center z-10 mt-0.5">
                      <Clock className="w-4 h-4 text-gray-400" />
                    </div>

                    {/* Event card */}
                    <div className="flex-1 min-w-0 bg-white rounded-2xl border border-gray-100 shadow-sm px-4 py-3 space-y-2">

                      {/* Action + timestamp */}
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-gray-900 font-mono">
                          {evt.action}
                        </span>
                        <span className="text-xs text-gray-400">
                          {new Date(evt.createdAt).toLocaleString()}
                        </span>
                      </div>

                      {/* Actor */}
                      {evt.actor && (
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
                          <User className="w-3 h-3 flex-shrink-0" />
                          <span className="font-medium text-gray-700">{evt.actor.fullName}</span>
                          <span className="text-gray-300">·</span>
                          <span>{evt.actor.email}</span>
                          <span className={cn(
                            'text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider',
                            ROLE_COLORS[evt.actor.role] ?? 'bg-gray-100 text-gray-500',
                          )}>
                            {evt.actor.role}
                          </span>
                        </div>
                      )}
                      {!evt.actor && evt.actorId && (
                        <p className="text-xs text-gray-400 font-mono">actor: {evt.actorId}</p>
                      )}

                      {/* Meta payload */}
                      {evt.meta && Object.keys(evt.meta).length > 0 && (
                        <pre className="text-xs text-gray-600 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 overflow-x-auto font-mono whitespace-pre-wrap break-words leading-relaxed">
                          {JSON.stringify(evt.meta, null, 2)}
                        </pre>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {!data && !loading && !error && (
        <div className="flex flex-col items-center justify-center py-20 text-center text-gray-400 space-y-2">
          <Clock className="w-10 h-10 text-gray-200" />
          <p className="text-sm">Enter an application ID above to view its audit trail.</p>
        </div>
      )}
    </div>
  );
}

export default function AuditTrailPage() {
  return (
    <Suspense fallback={<PageLoader />}>
      <AuditPage />
    </Suspense>
  );
}
