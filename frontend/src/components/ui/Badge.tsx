import { cn } from '@/lib/utils';

interface BadgeProps {
  className?: string;
  children:   React.ReactNode;
  dot?:       boolean;
}

export default function Badge({ className, children, dot }: BadgeProps) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold',
      className,
    )}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />}
      {children}
    </span>
  );
}
