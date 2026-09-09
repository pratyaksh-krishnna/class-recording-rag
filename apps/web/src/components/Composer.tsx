import {
  useEffect,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from 'react';

const MAX_COMPOSER_HEIGHT_PX = 192;

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  pending: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
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
    <form onSubmit={handleSubmit} className="border-t border-rule bg-page px-5 py-4 split:px-10">
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <label htmlFor="composer-input" className="sr-only">
            Ask about the recordings
          </label>
          <textarea
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
            placeholder="Ask about the recordings…"
            autoComplete="off"
            aria-describedby={hintId}
            className="block max-h-48 w-full resize-none overflow-y-auto bg-page font-reading text-base leading-[1.62] text-ink break-words placeholder:text-graphite"
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          aria-label={pending ? 'Asking' : 'Ask'}
          className="inline-flex h-10 min-w-16 shrink-0 items-center justify-center rounded-[3px] bg-mark px-4 font-ui text-sm font-medium text-page transition-[background-color,color,filter] duration-[120ms] hover:brightness-[0.92] active:brightness-[0.85] disabled:opacity-50"
        >
          {pending ? (
            <span
              className="inline-block size-4 animate-spin rounded-full border-2 border-page border-t-transparent"
              aria-hidden="true"
            />
          ) : (
            'Ask'
          )}
        </button>
      </div>
      <p id={hintId} className="mt-2 font-ui text-xs text-graphite">
        Press Enter to ask. Shift+Enter adds a new line.
      </p>
    </form>
  );
}
