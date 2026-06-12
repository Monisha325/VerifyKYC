import { cn } from '@/lib/utils';

interface CardProps {
  className?: string;
  children:   React.ReactNode;
  padding?:   boolean;
}

export default function Card({ className, children, padding = true }: CardProps) {
  return (
    <div className={cn(
      'bg-white rounded-2xl border border-gray-100 shadow-sm',
      padding && 'p-6',
      className,
    )}>
      {children}
    </div>
  );
}

export function CardHeader({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('flex items-center justify-between gap-4 mb-5', className)}>
      {children}
    </div>
  );
}

export function CardTitle({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <h3 className={cn('text-base font-semibold text-gray-900', className)}>
      {children}
    </h3>
  );
}
