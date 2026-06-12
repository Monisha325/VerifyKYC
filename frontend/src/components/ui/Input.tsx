'use client';
import { forwardRef } from 'react';
import { cn }         from '@/lib/utils';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?:  string;
  icon?:  React.ReactNode;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, icon, className, id, ...props }, ref) => {
    const htmlId = id ?? label?.toLowerCase().replace(/\s+/g, '-');
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={htmlId} className="text-sm font-medium text-gray-700">
            {label}
          </label>
        )}
        <div className="relative">
          {icon && (
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
              {icon}
            </span>
          )}
          <input
            ref={ref}
            id={htmlId}
            className={cn(
              'w-full rounded-xl border bg-white px-4 py-2.5 text-sm text-gray-900',
              'placeholder:text-gray-400 transition-colors duration-150',
              'focus:outline-none focus:ring-2 focus:border-transparent',
              error
                ? 'border-rose-400 focus:ring-rose-400'
                : 'border-gray-200 hover:border-gray-300 focus:ring-brand-navy',
              icon && 'pl-10',
              className,
            )}
            {...props}
          />
        </div>
        {error && <p className="text-xs text-rose-600 flex items-center gap-1">{error}</p>}
        {hint && !error && <p className="text-xs text-gray-500">{hint}</p>}
      </div>
    );
  },
);
Input.displayName = 'Input';
export default Input;
