import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, ReactElement } from 'react';
import { cn } from '../../lib/utils';

export const buttonVariants = cva(
  'group inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full font-ui text-sm font-medium transition-[color,background-color,box-shadow,opacity,transform] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] outline-none focus-visible:ring-[3px] focus-visible:ring-mark/20 disabled:pointer-events-none disabled:opacity-45 active:scale-[0.97] [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-ink text-page shadow-[0_1px_2px_rgba(25,29,26,0.18),0_5px_16px_rgba(25,29,26,0.08)] hover:bg-mark',
        secondary: 'bg-ink/[0.055] text-ink hover:bg-ink/[0.09]',
        outline:
          'bg-page text-ink ring-1 ring-inset ring-ink/[0.1] hover:bg-ink/[0.035] hover:ring-ink/[0.16]',
        ghost: 'text-graphite hover:bg-ink/[0.05] hover:text-ink',
        link: 'rounded-none text-mark underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-5',
        sm: 'h-8 px-3 text-xs',
        lg: 'h-12 px-6',
        icon: 'size-10 p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export function Button({
  className,
  variant,
  size,
  type = 'button',
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants>): ReactElement {
  return (
    <button
      data-slot="button"
      type={type}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
