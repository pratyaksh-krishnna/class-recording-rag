import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiErrorCode, ChatResponse } from '@rag/shared';
import { postChat } from '../api/client';
import { ApiError, userFacingError } from '../api/errors';

export type Turn =
  | { kind: 'question'; id: string; text: string }
  | { kind: 'answer'; id: string; response: ChatResponse }
  | { kind: 'pending'; id: string; startedAt: number }
  | {
      kind: 'error';
      id: string;
      code: ApiErrorCode;
      message: string;
      retry: string | null;
      questionText: string;
    };

export interface UseChatResult {
  turns: Turn[];
  pending: boolean;
  error: Turn | null;
  conversationId: string | null;
  send: (question: string) => Promise<void>;
  retry: () => Promise<void>;
  setTurns: (turns: Turn[]) => void;
  setConversationId: (id: string | null) => void;
}

function readConversationIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('c');
}

function syncConversationIdToUrl(conversationId: string | null): void {
  const url = new URL(window.location.href);
  if (conversationId) {
    url.searchParams.set('c', conversationId);
  } else {
    url.searchParams.delete('c');
  }
  window.history.replaceState({}, '', url);
}

function newId(): string {
  return crypto.randomUUID();
}

/** Owns the turn state machine (plan §B.2); one in-flight request at a time. */
export function useChat(): UseChatResult {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationIdState] = useState<string | null>(() =>
    readConversationIdFromUrl(),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Turn | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const lastQuestionRef = useRef<string | null>(null);

  const setConversationId = useCallback((id: string | null): void => {
    setConversationIdState(id);
    syncConversationIdToUrl(id);
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const executeSend = useCallback(
    async (question: string, existingTurns?: Turn[]): Promise<void> => {
      if (pending) {
        return;
      }

      lastQuestionRef.current = question;
      const questionId = newId();
      const pendingId = newId();

      const baseTurns = existingTurns ?? turns;
      setTurns([
        ...baseTurns,
        { kind: 'question', id: questionId, text: question },
        { kind: 'pending', id: pendingId, startedAt: Date.now() },
      ]);
      setPending(true);
      setError(null);

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await postChat(
          {
            question,
            ...(conversationId ? { conversationId } : {}),
          },
          { signal: controller.signal },
        );

        setConversationId(response.conversationId);

        setTurns((current) =>
          current
            .filter((turn) => turn.id !== pendingId)
            .concat({ kind: 'answer', id: response.messageId, response }),
        );
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }

        const apiError =
          err instanceof ApiError
            ? err
            : new ApiError('INTERNAL_ERROR', 'Unexpected error.', 500, null);
        const copy = userFacingError(apiError.code);

        const errorTurn: Turn = {
          kind: 'error',
          id: newId(),
          code: apiError.code,
          message: copy.message,
          retry: copy.retry,
          questionText: question,
        };

        setTurns((current) =>
          current.filter((turn) => turn.id !== pendingId).concat(errorTurn),
        );
        setError(errorTurn);
      } finally {
        setPending(false);
        abortRef.current = null;
      }
    },
    [conversationId, pending, setConversationId, turns],
  );

  const send = useCallback(
    async (question: string): Promise<void> => {
      const trimmed = question.trim();
      if (trimmed.length === 0 || pending) {
        return;
      }
      await executeSend(trimmed);
    },
    [executeSend, pending],
  );

  const retry = useCallback(async (): Promise<void> => {
    const question = lastQuestionRef.current;
    if (!question || pending) {
      return;
    }

    setTurns((current) => {
      const withoutError = current.filter((turn) => turn.kind !== 'error');
      void executeSend(question, withoutError);
      return withoutError;
    });
    setError(null);
  }, [executeSend, pending]);

  return {
    turns,
    pending,
    error,
    conversationId,
    send,
    retry,
    setTurns,
    setConversationId,
  };
}
