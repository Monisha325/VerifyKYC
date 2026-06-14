'use client';
import Link        from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  ShieldCheck, LayoutDashboard, FileCheck,
  LogOut, ChevronRight, User, ClipboardList, Bot, ScrollText,
} from 'lucide-react';
import { useAuth }        from '@/context/AuthContext';
import { useApplication } from '@/context/ApplicationContext';
import { cn }             from '@/lib/utils';

const ACTIVE_STATUSES = ['SUBMITTED', 'PROCESSING', 'PENDING_REVIEW'] as const;

export default function AppShell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  const { user, logout }               = useAuth();
  const { app: latestApp, loading: appLoading } = useApplication();
  const pathname                       = usePathname();
  const router                         = useRouter();

  const isReviewer = user?.role === 'REVIEWER' || user?.role === 'ADMIN';
  const isAdmin    = user?.role === 'ADMIN';

  const applyNavItem = (() => {
    if (isReviewer) return null;
    if (appLoading || !latestApp || latestApp.status === 'REJECTED')
      return { href: '/apply', icon: FileCheck, label: 'Apply' };
    if (latestApp.status === 'APPROVED')
      return null; // verified — link not needed
    if ((ACTIVE_STATUSES as readonly string[]).includes(latestApp.status))
      return { href: '/dashboard', icon: FileCheck, label: 'My Application' };
    // DRAFT
    return { href: '/apply', icon: FileCheck, label: 'Apply' };
  })();

  const NAV = isReviewer
    ? [
        { href: '/admin/queue', icon: ClipboardList, label: 'Review Queue' },
        ...(isAdmin ? [{ href: '/admin/audit', icon: ScrollText, label: 'Audit Trail' }] : []),
        { href: '/chat', icon: Bot, label: 'Agent Chat' },
      ]
    : [
        { href: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
        ...(applyNavItem && applyNavItem.href !== '/dashboard' ? [applyNavItem] : []),
        { href: '/chat', icon: Bot, label: 'Agent Chat' },
      ];

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">

      {/* ── Top nav ── */}
      <header className="sticky top-0 z-30 bg-white border-b border-gray-100 shadow-sm">
        <div className={cn(wide ? 'max-w-7xl' : 'max-w-6xl', 'mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-6')}>

          <Link href={isReviewer ? '/admin/queue' : '/dashboard'}
            className="flex items-center gap-2.5 flex-shrink-0">
            <div className="w-8 h-8 rounded-lg bg-brand-navy flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-brand-green" />
            </div>
            <span className="text-base font-bold text-brand-navy tracking-tight">VeriKYC</span>
          </Link>

          <nav className="hidden sm:flex items-center gap-1">
            {NAV.map(({ href, icon: Icon, label }) => {
              const active = pathname === href || pathname.startsWith(href + '/');
              return (
                <Link key={href} href={href} className={cn(
                  'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                  active
                    ? 'bg-brand-navy/5 text-brand-navy'
                    : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100',
                )}>
                  <Icon className="w-4 h-4" />
                  {label}
                </Link>
              );
            })}
          </nav>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2 text-sm text-gray-600">
              <div className="w-7 h-7 rounded-full bg-brand-navy/10 flex items-center justify-center">
                <User className="w-4 h-4 text-brand-navy" />
              </div>
              <span className="font-medium">{user?.fullName ?? 'Account'}</span>
              {isReviewer && (
                <span className="text-[10px] font-bold bg-brand-navy text-white px-1.5 py-0.5 rounded uppercase tracking-wider">
                  {user?.role}
                </span>
              )}
            </div>
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-gray-500
                         hover:text-rose-600 hover:bg-rose-50 transition-colors"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>

        <div className="sm:hidden flex border-t border-gray-100">
          {NAV.map(({ href, icon: Icon, label }) => {
            const active = pathname === href;
            return (
              <Link key={href} href={href} className={cn(
                'flex-1 flex flex-col items-center gap-1 py-2 text-xs font-medium transition-colors',
                active ? 'text-brand-navy' : 'text-gray-400 hover:text-gray-700',
              )}>
                <Icon className="w-5 h-5" />
                {label}
              </Link>
            );
          })}
        </div>
      </header>

      <main className={cn('flex-1 w-full mx-auto px-4 sm:px-6 py-8', wide ? 'max-w-7xl' : 'max-w-6xl')}>
        {children}
      </main>
    </div>
  );
}

export function Breadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav className="flex items-center gap-1.5 text-sm text-gray-500 mb-6">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-gray-300" />}
          {item.href
            ? <Link href={item.href} className="hover:text-brand-navy transition-colors">{item.label}</Link>
            : <span className="text-gray-900 font-medium">{item.label}</span>
          }
        </span>
      ))}
    </nav>
  );
}
