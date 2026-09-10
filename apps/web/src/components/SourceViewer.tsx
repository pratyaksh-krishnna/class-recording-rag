import { Clock, VideoCamera, X } from '@phosphor-icons/react';
import type { Source } from '@rag/shared';
import { useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react';
import { formatTimecode } from '../lib/time';
import { Button } from './ui/button';

interface SourceViewerProps {
  turnId: string;
  source: Source | null;
  onClose: () => void;
}

export function fullChunkText(source: Source): string {
  return source.content ?? source.excerpt;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

export function SourceViewer({
  turnId,
  source,
  onClose,
}: SourceViewerProps): ReactElement | null {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (source === null) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();

    const handleEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, [source, onClose]);

  if (source === null) return null;

  const titleId = `source-viewer-title-${turnId}-${source.id}`;
  const detailId = `source-viewer-detail-${turnId}-${source.id}`;
  const start = formatTimecode(source.startMs);
  const end = formatTimecode(source.endMs);

  const keepFocusInside = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab' || dialogRef.current === null) return;
    const focusable = focusableElements(dialogRef.current);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-ink/35 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={detailId}
        tabIndex={-1}
        onKeyDown={keepFocusInside}
        className="flex max-h-[88dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-[1.4rem] bg-page shadow-[0_28px_90px_-28px_rgba(25,29,26,0.5)] ring-1 ring-ink/10 sm:rounded-[1.4rem]"
      >
        <div className="flex items-start justify-between gap-5 border-b border-rule/70 px-5 py-4 sm:px-6 sm:py-5">
          <div className="min-w-0">
            <div className="mb-2 flex min-w-0 items-center gap-2 font-ui text-xs font-medium text-graphite">
              <VideoCamera size={16} weight="light" className="shrink-0 text-mark" aria-hidden="true" />
              <span className="truncate">{source.moduleName}</span>
            </div>
            <h2 id={titleId} className="font-ui text-lg font-semibold leading-snug tracking-[-0.015em] text-ink text-pretty">
              {source.className}
            </h2>
            <p id={detailId} className="mt-2 flex items-center gap-1.5 font-ui text-xs font-medium tabular-nums text-graphite">
              <Clock size={14} weight="light" aria-hidden="true" />
              Transcript chunk, {start}–{end}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="-mr-2 -mt-1 size-9"
            aria-label="Close full chunk"
            onClick={onClose}
          >
            <X size={18} weight="light" aria-hidden="true" />
          </Button>
        </div>
        <div className="overflow-y-auto overscroll-contain px-5 py-5 sm:px-6 sm:py-6 [scrollbar-color:var(--color-rule)_transparent] [scrollbar-width:thin]">
          <p className="whitespace-pre-wrap break-words font-reading text-[0.98rem] leading-[1.8] text-ink">
            {fullChunkText(source)}
          </p>
        </div>
      </div>
    </div>
  );
}
