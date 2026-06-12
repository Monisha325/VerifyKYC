import { Loader2 } from 'lucide-react';
import { cn }      from '@/lib/utils';

interface Props { className?: string; size?: 'sm' | 'md' | 'lg'; label?: string; }

const sizes = { sm: 'w-4 h-4', md: 'w-8 h-8', lg: 'w-12 h-12' };

export default function LoadingSpinner({ className, size = 'md', label }: Props) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 text-brand-navy', className)}>
      <Loader2 className={cn('animate-spin', sizes[size])} />
      {label && <p className="text-sm text-gray-500">{label}</p>}
    </div>
  );
}

export function PageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <LoadingSpinner size="lg" label="Loading…" />
    </div>
  );
}

export function SkeletonLine({ className }: { className?: string }) {
  return <div className={cn('h-4 rounded-lg bg-gray-200 animate-pulse', className)} />;
}
