import type { ReactElement } from 'react';
import type { Turn } from '../hooks/useChat';
import { MessageTurn } from './MessageTurn';

export interface TurnGroup {
  question: Extract<Turn, { kind: 'question' }>;
  follow: Extract<Turn, { kind: 'answer' | 'pending' | 'error' }> | null;
}

export function groupTurns(turns: Turn[]): TurnGroup[] {
  const groups: TurnGroup[] = [];

  for (const turn of turns) {
    if (turn.kind === 'question') {
      groups.push({ question: turn, follow: null });
      continue;
    }

    const current = groups.at(-1);
    if (current && current.follow === null) {
      current.follow = turn;
    }
  }

  return groups;
}

interface MessageListProps {
  turns: Turn[];
  arrivingAnswerIds: ReadonlySet<string>;
  onRetry: () => void;
}

export function MessageList({
  turns,
  arrivingAnswerIds,
  onRetry,
}: MessageListProps): ReactElement {
  const groups = groupTurns(turns);

  return (
    <div className="mx-auto flex w-full max-w-[56rem] flex-col gap-12 pb-4 md:gap-16">
      {groups.map((group) => (
        <MessageTurn
          key={group.question.id}
          question={group.question}
          follow={group.follow}
          animate={group.follow?.kind === 'answer' && arrivingAnswerIds.has(group.follow.id)}
          onRetry={onRetry}
        />
      ))}
    </div>
  );
}
