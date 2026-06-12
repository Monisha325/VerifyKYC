'use client';
import React       from 'react';
import { Loader2 } from 'lucide-react';
import { cn }      from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size    = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?:    Size;
  loading?: boolean;
  asChild?: boolean;
}

const V: Record<Variant, string> = {
  primary:   'bg-brand-navy text-white hover:bg-[#162d4a] active:scale-[0.98] shadow-sm',
  secondary: 'bg-white text-brand-navy border border-brand-navy hover:bg-blue-50 active:scale-[0.98]',
  ghost:     'text-brand-navy hover:bg-blue-50 active:scale-[0.98]',
  danger:    'bg-rose-600 text-white hover:bg-rose-700 active:scale-[0.98] shadow-sm',
};

const S: Record<Size, string> = {
  sm: 'px-3.5 py-2 text-sm',
  md: 'px-5 py-2.5 text-sm',
  lg: 'px-6 py-3 text-base',
};

export default function Button({
  variant = 'primary', size = 'md', loading = false, asChild = false,
  disabled, className, children, ...props
}: ButtonProps) {
  const classes = cn(
    'inline-flex items-center justify-center gap-2 rounded-xl font-semibold',
    'transition-all duration-150 focus-visible:outline-none',
    'focus-visible:ring-2 focus-visible:ring-brand-navy focus-visible:ring-offset-2',
    'disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100',
    V[variant], S[size], className,
  );

  // asChild: render as the single child element, applying Button styles to it
  if (asChild && React.isValidElement(children)) {
    const child = children as React.ReactElement<{ className?: string }>;
    return React.cloneElement(child, {
      className: cn(classes, child.props.className),
    });
  }

  return (
    <button
      disabled={disabled || loading}
      className={classes}
      {...props}
    >
      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
      {children}
    </button>
  );
}
