'use client';
import { useEffect, useState } from 'react';
import { useRouter }           from 'next/navigation';
import {
  RefreshCw, Lock, ChevronRight, Clock, AlertTriangle,
  Flag, Users, CheckCircle2,
} from 'lucide-react';
import { api }       from '@/lib/api';
import { useAuth }   from '@/context/AuthContext';
import Badge         from '@/components/ui/Badge';
import Button        from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/LoadingSpinner';
import { cn, formatDate, scoreTextColor, scoreBarColor, boostScore } from '@/lib/utils';
import type { QueueItem } from '@/lib/types';

// ── Band pill ─────────────────────────────────────────────────────────────────

function BandPill({ band }: { band: string | null }) {
  if (!band) return <span className="text-xs text-gray-400">—</span>;
  const cfg = {
    FLAGGED:    'bg-rose-100 text-rose-700 ring-1 ring-rose-200',
    STANDARD:   'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
    FAST_TRACK: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  }[band] ?? 'bg-gray-100 text-gray-600';
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full', cfg)}>
      {band === 'FLAGGED' && <AlertTriangle className="w-3 h-3" />}
      {band.replace('_', ' ')}
    </span>
  );
}

// ── Score chip ────────────────────────────────────────────────────────────────

function ScoreChip({ score }: { score: number | null }) {
  const s = boostScore(score);
  if (s == null) return <span className="text-xs text-gray-400 tabular-nums">—</span>;
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 rounded-full bg-gray-100 overflow-hidden">
        <div className={cn('h-full rounded-full', scoreBarColor(s))}
             style={{ width: `${s}%` }} />
      </div>
      <span className={cn('text-xs font-bold tabular-nums w-6 text-right', scoreTextColor(s))}>
        {s}
      </span>
    </div>
  );
}

// ── Summary stats ─────────────────────────────────────────────────────────────

function StatCard({ label, value, icon: Icon, color }: {
  label: string; value: number; icon: React.ElementType; color: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm px-5 py-4 flex items-center gap-4">
      <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0', color)}>
        <Icon className="w-5 h-5" />
      </div>
      <div>
        <p className="text-2xl font-bold text-gray-900 leading-none">{value}</p>
        <p className="text-xs text-gray-500 mt-0.5 font-medium">{label}</p>
      </div>
    </div>
  );
}

// ── Main queue page ───────────────────────────────────────────────────────────

export default function ReviewQueuePage() {
  const { user }  = useAuth();
  const router    = useRouter();
  const [items,      setItems]      = useState<QueueItem[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState('');

  async function load(quiet = false) {
    if (!quiet) setLoading(true);
    else setRefreshing(true);
    setError('');
    try {
      const { data } = await api.get<{ count: number; items: QueueItem[] }>('/review/');
      setItems(data.items);
    } catch (e: unknown) {
      setError(
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'Could not load the review queue.',
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { load(); }, []);

  if (loading) return <PageLoader />;

  const flagged   = items.filter(i => i.scoreBand === 'FLAGGED').length;
  const unclaimed = items.filter(i => !i.claimedById).length;
  const mine      = items.filter(i => i.claimedById === user?.id).length;

  return (
    <div className="animate-fade-up space-y-6">

      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Review Queue</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Applications awaiting human review, newest and flagged first.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => load(true)} loading={refreshing}>
          <RefreshCw className="w-4 h-4" />
          Refresh
        </Button>
      </div>

      {/* ── Stats row ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Total pending"  value={items.length} icon={Clock}        color="bg-amber-50 text-amber-600"   />
        <StatCard label="Flagged"        value={flagged}      icon={AlertTriangle} color="bg-rose-50 text-rose-600"     />
        <StatCard label="Unclaimed"      value={unclaimed}    icon={Users}         color="bg-blue-50 text-blue-600"     />
        <StatCard label="Claimed by you" value={mine}         icon={CheckCircle2}  color="bg-emerald-50 text-emerald-600" />
      </div>

      {error && (
        <div className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* ── Table ── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-2xl bg-emerald-50 flex items-center justify-center mb-4">
              <CheckCircle2 className="w-8 h-8 text-emerald-400" />
            </div>
            <p className="text-base font-semibold text-gray-700">Queue is clear</p>
            <p className="text-sm text-gray-400 mt-1">No applications are pending review right now.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/60">
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Applicant</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider hidden sm:table-cell">Submitted</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Score</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Band</th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider hidden md:table-cell">Flags</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider hidden lg:table-cell">Claimed</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {items.map(item => {
                  const claimedByMe    = item.claimedById === user?.id;
                  const claimedByOther = !!item.claimedById && !claimedByMe;

                  return (
                    <tr
                      key={item.id}
                      onClick={() => router.push(`/admin/${item.id}`)}
                      className={cn(
                        'cursor-pointer transition-colors group',
                        item.scoreBand === 'FLAGGED'
                          ? 'hover:bg-rose-50/50'
                          : 'hover:bg-blue-50/30',
                      )}
                    >
                      {/* Applicant */}
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-brand-navy/8 flex items-center justify-center flex-shrink-0">
                            <span className="text-xs font-bold text-brand-navy">
                              {item.user.fullName.charAt(0).toUpperCase()}
                            </span>
                          </div>
                          <div className="min-w-0">
                            <p className="font-semibold text-gray-900 truncate">{item.user.fullName}</p>
                            <p className="text-xs text-gray-400 truncate hidden sm:block">{item.user.email}</p>
                          </div>
                        </div>
                      </td>

                      {/* Submitted */}
                      <td className="px-4 py-4 text-gray-500 hidden sm:table-cell whitespace-nowrap">
                        {formatDate(item.submittedAt)}
                      </td>

                      {/* Score */}
                      <td className="px-4 py-4">
                        <ScoreChip score={item.overallScore} />
                      </td>

                      {/* Band */}
                      <td className="px-4 py-4">
                        <BandPill band={item.scoreBand} />
                      </td>

                      {/* Flag count */}
                      <td className="px-4 py-4 text-center hidden md:table-cell">
                        {item.flagCount > 0 ? (
                          <span className={cn(
                            'inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full',
                            item.flagCount >= 3
                              ? 'bg-rose-100 text-rose-700'
                              : 'bg-amber-100 text-amber-700',
                          )}>
                            <Flag className="w-3 h-3" />
                            {item.flagCount}
                          </span>
                        ) : (
                          <span className="text-xs text-emerald-600 font-medium">Clean</span>
                        )}
                      </td>

                      {/* Claimed */}
                      <td className="px-4 py-4 hidden lg:table-cell">
                        {claimedByMe ? (
                          <Badge className="bg-brand-navy/5 text-brand-navy" dot>You</Badge>
                        ) : claimedByOther ? (
                          <span className="flex items-center gap-1 text-xs text-gray-400">
                            <Lock className="w-3 h-3" /> Locked
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">Available</span>
                        )}
                      </td>

                      {/* Chevron */}
                      <td className="px-4 py-4 text-right">
                        <ChevronRight className="w-4 h-4 text-gray-300 group-hover:text-brand-navy transition-colors" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
