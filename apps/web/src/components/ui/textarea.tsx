import type { ComponentProps, ReactElement } from 'react';
import { cn } from '../../lib/utils';

export function Textarea({ className, ...props }: ComponentProps<'textarea'>): ReactElement {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex min-h-12 w-full resize-none bg-transparent px-0 py-2 font-reading text-base leading-[1.55] text-ink outline-none transition-[color,opacity] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] placeholder:text-graphite/70 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
