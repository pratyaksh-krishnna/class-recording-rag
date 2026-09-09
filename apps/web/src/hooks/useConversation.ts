import { useEffect, useRef } from 'react';
import type { ChatResponse } from '@rag/shared';
import { getConversation } from '../api/client';
import { ApiError } from '../api/errors';
import type { Turn } from './useChat';

interface UseConversationOptions {
  setTurns: (turns: Turn[]) => void;
  setConversationId: (id: string | null) => void;
}

function messagesToTurns(
  conversationId: string,
  messages: Awaited<ReturnType<typeof getConversation>>['messages'],
): Turn[] {
  const turns: Turn[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({ kind: 'question', id: message.id, text: message.content });
      continue;
    }

    const response: ChatResponse = {
      conversationId,
      messageId: message.id,
      answer: message.content,
      groundingStatus: message.groundingStatus ?? 'general_knowledge',
      sources: message.sources,
    };
    turns.push({ kind: 'answer', id: message.id, response });
  }

  return turns;
}

/**
 * Hydrates `?c=<uuid>` on mount (plan §A.10). A missing conversation clears
 * the URL param and starts fresh rather than blocking the UI with an error.
 */
export function useConversation({ setTurns, setConversationId }: UseConversationOptions): void {
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) {
      return;
    }
    loadedRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const conversationId = params.get('c');
    if (!conversationId) {
      return;
    }

    void (async (): Promise<void> => {
      try {
        const detail = await getConversation(conversationId);
        setConversationId(detail.conversationId);
        setTurns(messagesToTurns(detail.conversationId, detail.messages));
      } catch (err) {
        if (err instanceof ApiError && err.code === 'CONVERSATION_NOT_FOUND') {
          setConversationId(null);
          setTurns([]);
          return;
        }
        // Other load failures leave the app usable with an empty thread.
        setConversationId(null);
        setTurns([]);
      }
    })();
  }, [setConversationId, setTurns]);
}
