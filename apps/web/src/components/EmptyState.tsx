import type { ReactElement, ReactNode } from 'react';
import { ArrowUpRight, Sparkle } from '@phosphor-icons/react';
import { Button } from './ui/button';

/** Factual questions from the real eval corpus so examples return grounded answers. */
export const EXAMPLE_QUESTIONS = [
  'What is mobile development?',
  'What is the difference between React Native and Expo?',
  'What does the gyroscope sensor measure?',
] as const;

interface EmptyStateProps {
  onPickExample: (question: string) => void;
  children?: ReactNode;
}

export function EmptyState({ children, onPickExample }: EmptyStateProps): ReactElement {
  return (
    <section
      aria-labelledby="empty-state-heading"
      className="mx-auto flex w-full max-w-3xl flex-col items-center px-4 pt-10 text-center split:pt-20"
    >
      <div className="mb-5 flex size-10 items-center justify-center rounded-full bg-mark/[0.07] text-mark ring-1 ring-inset ring-mark/10">
        <Sparkle aria-hidden="true" size={18} weight="light" />
      </div>
      <h2
        id="empty-state-heading"
        className="max-w-[18ch] font-reading text-2xl leading-[1.12] tracking-[-0.025em] text-ink text-balance"
      >
        What would you like to learn?
      </h2>
      <p className="mt-3 max-w-[48ch] font-ui text-sm leading-relaxed text-graphite text-pretty">
        Ask anything covered in your class recordings and explore the exact moments behind
        each answer.
      </p>
      {children ? <div className="mt-10 w-full">{children}</div> : null}
      <p
        className={`${children ? 'mt-7' : 'mt-10'} font-ui text-xs font-medium uppercase tracking-[0.14em] text-graphite/75`}
      >
        Try asking
      </p>
      <ul className="mt-3 grid w-full grid-cols-1 gap-2 text-left split:grid-cols-3">
        {EXAMPLE_QUESTIONS.map((question) => (
          <li key={question} className="flex">
            <Button
              type="button"
              variant="outline"
              onClick={() => onPickExample(question)}
              className="h-auto min-h-16 w-full justify-between whitespace-normal rounded-[1.15rem] px-4 py-3.5 text-left font-reading text-sm font-normal leading-snug text-ink shadow-[0_8px_24px_-24px_rgba(25,29,26,0.7)] hover:-translate-y-0.5 hover:bg-page hover:shadow-[0_14px_30px_-24px_rgba(25,29,26,0.42)]"
            >
              <span className="min-w-0 break-words">{question}</span>
              <span className="ml-3 flex size-7 shrink-0 items-center justify-center rounded-full bg-ink/[0.045] text-graphite transition-[color,background-color,transform] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:-translate-y-px group-hover:translate-x-0.5 group-hover:bg-mark/[0.08] group-hover:text-mark">
                <ArrowUpRight aria-hidden="true" size={14} weight="light" />
              </span>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
