import type { ReactElement } from 'react';

/** Factual questions from the real eval corpus so examples return grounded answers. */
export const EXAMPLE_QUESTIONS = [
  'What is mobile development?',
  'What is the difference between React Native and Expo?',
  'What does the gyroscope sensor measure?',
] as const;

interface EmptyStateProps {
  onPickExample: (question: string) => void;
}

export function EmptyState({ onPickExample }: EmptyStateProps): ReactElement {
  return (
    <div className="max-w-[66ch]">
      <p className="font-reading text-lg leading-[1.62] text-ink text-pretty">
        Ask about anything covered in the recordings.
      </p>
      <ul className="mt-6 flex flex-col items-start gap-3">
        {EXAMPLE_QUESTIONS.map((question) => (
          <li key={question}>
            <button
              type="button"
              onClick={() => onPickExample(question)}
              className="break-words text-left font-reading text-base leading-[1.62] text-mark underline decoration-mark underline-offset-4 transition-[color] duration-[120ms] hover:text-ink"
            >
              {question}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
