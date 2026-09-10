import {
  useEffect,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import { ArrowUp, CircleNotch } from '@phosphor-icons/react';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';

const MAX_COMPOSER_HEIGHT_PX = 192;

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  pending: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  variant?: 'hero' | 'docked';
}

function resizeTextarea(el: HTMLTextAreaElement | null): void {
  if (!el) {
    return;
  }
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT_PX)}px`;
}

export function Composer({
  value,
  onChange,
  onSubmit,
  pending,
  textareaRef,
  variant = 'docked',
}: ComposerProps): ReactElement {
  const hintId = 'composer-hint';

  useEffect(() => {
    resizeTextarea(textareaRef.current);
  }, [value, textareaRef]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (pending || value.trim().length === 0) {
      return;
    }
    onSubmit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!pending && value.trim().length > 0) {
        onSubmit();
      }
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className={cn(
        'w-full',
        variant === 'hero'
          ? 'mx-auto max-w-3xl px-4 pb-2'
          : 'sticky bottom-0 bg-page/95 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-18px_36px_-32px_rgba(25,29,26,0.35)] split:px-10',
      )}
    >
      <div className="mx-auto w-full max-w-3xl">
        <div
          className={cn(
            'rounded-[1.75rem] bg-ink/[0.035] p-1 ring-1 ring-inset ring-ink/[0.06] transition-[background-color,box-shadow,transform] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] focus-within:bg-mark/[0.045] focus-within:shadow-[0_18px_50px_-28px_rgba(14,92,85,0.36)] focus-within:ring-mark/15',
            variant === 'hero' &&
              'shadow-[0_16px_45px_-28px_rgba(25,29,26,0.28)] focus-within:-translate-y-0.5',
          )}
        >
          <div
            className={cn(
              'flex items-end gap-3 rounded-[calc(1.75rem-0.25rem)] bg-page px-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]',
              variant === 'hero' ? 'py-3.5 pl-5' : 'py-2.5',
            )}
          >
            <div className="min-w-0 flex-1">
              <label htmlFor="composer-input" className="sr-only">
                Ask about the recordings
              </label>
              <Textarea
                id="composer-input"
                name="question"
                ref={textareaRef}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={handleKeyDown}
                onInput={(event) => {
                  resizeTextarea(event.currentTarget);
                }}
                rows={1}
                placeholder="Ask anything…"
                autoComplete="off"
                aria-describedby={hintId}
                className={cn(
                  'max-h-48 overflow-y-auto break-words',
                  variant === 'hero' && 'min-h-14 py-3 text-lg leading-[1.5]',
                )}
              />
            </div>
            <Button
              type="submit"
              size="icon"
              disabled={pending}
              aria-busy={pending}
              aria-label={pending ? 'Asking' : 'Ask'}
              className={cn(
                'mb-1 [&_svg]:size-[18px]',
                variant === 'hero' && 'size-11 [&_svg]:size-5',
              )}
            >
              {pending ? (
                <CircleNotch aria-hidden="true" weight="light" className="animate-spin" />
              ) : (
                <ArrowUp
                  aria-hidden="true"
                  weight="light"
                  className="transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:-translate-y-0.5"
                />
              )}
            </Button>
          </div>
        </div>
        <p
          id={hintId}
          className={cn(
            'mt-2.5 font-ui text-xs text-graphite/80',
            variant === 'hero' && 'text-center',
          )}
        >
          Press Enter to ask. Shift+Enter adds a new line.
        </p>
      </div>
    </form>
  );
}
