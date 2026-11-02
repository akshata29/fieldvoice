import { forwardRef, type ButtonHTMLAttributes, type ComponentType, type ReactNode, type SVGProps } from 'react';
import { cn } from '@/lib/cn';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'dark';
export type ButtonSize = 'sm' | 'md' | 'lg';
export type IconComponent = ComponentType<SVGProps<SVGSVGElement> & { title?: string; titleId?: string }>;

const base =
  'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg border font-semibold transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300 disabled:cursor-not-allowed disabled:opacity-50 ' +
  'field:border-2 field:ring-offset-2';

const variants: Record<ButtonVariant, string> = {
  primary: 'border-brand-700 bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 field:bg-brand-800 field:border-black',
  secondary: 'border-line bg-surface text-ink hover:bg-slate-50 active:bg-slate-100 field:border-black',
  ghost: 'border-transparent bg-transparent text-ink hover:bg-slate-200/70 active:bg-slate-200 field:border-transparent',
  danger: 'border-red-700 bg-red-600 text-white hover:bg-red-700 active:bg-red-800 field:bg-red-800 field:border-black',
  success: 'border-emerald-700 bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800 field:bg-emerald-800 field:border-black',
  dark: 'border-slate-900 bg-slate-900 text-white hover:bg-slate-800 active:bg-black field:border-black',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'min-h-[36px] px-3 text-sm field:min-h-[48px] field:text-base',
  md: 'min-h-tap px-4 text-base',
  lg: 'min-h-[56px] px-6 text-lg field:min-h-[64px]',
};

export function buttonClasses(opts: { variant?: ButtonVariant; size?: ButtonSize; fullWidth?: boolean; className?: string } = {}): string {
  return cn(base, variants[opts.variant ?? 'secondary'], sizes[opts.size ?? 'md'], opts.fullWidth && 'w-full', opts.className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconComponent;
  iconRight?: IconComponent;
  loading?: boolean;
  fullWidth?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon: Icon, iconRight: IconRight, loading, fullWidth, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClasses({ variant, size, fullWidth, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner className="h-4 w-4" /> : Icon ? <Icon className="h-5 w-5 shrink-0" aria-hidden="true" /> : null}
      {children}
      {IconRight && !loading ? <IconRight className="h-5 w-5 shrink-0" aria-hidden="true" /> : null}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: IconComponent;
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, variant = 'ghost', size = 'md', className, type = 'button', ...rest },
  ref,
) {
  const square = size === 'sm' ? 'min-w-[36px] !px-0 field:min-w-[48px]' : 'min-w-tap !px-0';
  return (
    <button ref={ref} type={type} aria-label={label} title={label} className={buttonClasses({ variant, size, className: cn(square, className) })} {...rest}>
      <Icon className="h-5 w-5" aria-hidden="true" />
    </button>
  );
});
