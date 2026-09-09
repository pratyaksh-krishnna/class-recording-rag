import type { ChatResponse, ConversationSummary } from '@rag/shared';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { getConversation, listConversations } from '../api/client';
import { useCatalog } from '../hooks/useCatalog';
import { useChat, type Turn } from '../hooks/useChat';
import { useConversation } from '../hooks/useConversation';
import { Composer } from './Composer';
import { EmptyState } from './EmptyState';
import { MessageList } from './MessageList';

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

export function ChatView(): ReactElement {
  const chat = useChat();
  const { cohortName } = useCatalog();
  const [draft, setDraft] = useState('');
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [arrivingAnswerIds, setArrivingAnswerIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const pendingWasTrue = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const conversationsListId = 'conversations-list';

  useConversation({
    setTurns: chat.setTurns,
    setConversationId: chat.setConversationId,
  });

  useEffect(() => {
    if (pendingWasTrue.current && !chat.pending) {
      const latest = [...chat.turns].reverse().find((turn) => turn.kind === 'answer');
      if (latest?.kind === 'answer') {
        setArrivingAnswerIds((prev) => new Set(prev).add(latest.id));
      }
    }
    pendingWasTrue.current = chat.pending;
  }, [chat.pending, chat.turns]);

  const refreshConversations = useCallback((): void => {
    void listConversations()
      .then((result) => setConversations(result.conversations))
      .catch(() => {
        setConversations([]);
      });
  }, []);

  useEffect(() => {
    refreshConversations();
  }, [refreshConversations, chat.conversationId]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuTriggerRef.current?.focus();
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const submitDraft = (): void => {
    const text = draft.trim();
    if (text.length === 0 || chat.pending) {
      return;
    }
    setDraft('');
    void chat.send(text);
  };

  const pickExample = (question: string): void => {
    setDraft(question);
    textareaRef.current?.focus();
  };

  const startNewThread = (): void => {
    chat.setTurns([]);
    chat.setConversationId(null);
    setMenuOpen(false);
    textareaRef.current?.focus();
  };

  const openConversation = (id: string): void => {
    setMenuOpen(false);
    void (async (): Promise<void> => {
      try {
        const detail = await getConversation(id);
        chat.setConversationId(detail.conversationId);
        chat.setTurns(messagesToTurns(detail.conversationId, detail.messages));
      } catch {
        // Leave the current thread in place if reload fails.
      }
    })();
  };

  return (
    <div className="app-shell min-h-dvh bg-ground">
      <a
        href="#main"
        className="absolute left-3 top-3 z-50 bg-page px-3 py-2 font-ui text-xs font-medium text-mark -translate-y-[220%] transition-[transform] duration-[120ms] focus-visible:translate-y-0"
      >
        Skip to main content
      </a>
      <div className="mx-auto flex min-h-[calc(100dvh-1.5rem)] max-w-[var(--spacing-container)] flex-col bg-page split:min-h-[calc(100dvh-2.5rem)]">
        <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-rule bg-page px-5 py-4 split:px-10">
          <h1
            title={cohortName}
            className="min-w-0 flex-1 truncate font-ui text-lg font-semibold text-ink text-balance"
          >
            {cohortName}
          </h1>
          <div ref={menuRef} className="relative shrink-0">
              <button
                ref={menuTriggerRef}
                type="button"
                aria-expanded={menuOpen}
                aria-haspopup="true"
                aria-controls={conversationsListId}
                onClick={() => setMenuOpen((open) => !open)}
                className="font-ui text-sm font-medium text-graphite transition-[color] duration-[120ms] hover:text-ink"
              >
                Conversations
                <span aria-hidden="true" className="ml-1">
                  ▾
                </span>
              </button>
              {menuOpen ? (
                <ul
                  id={conversationsListId}
                  aria-label="Recent conversations"
                  className="absolute right-0 top-full z-20 mt-2 min-w-56 border border-rule bg-page py-1"
                >
                  <li>
                    <button
                      type="button"
                      onClick={startNewThread}
                      className="block w-full px-3 py-2 text-left font-ui text-sm font-medium text-ink transition-[color] duration-[120ms] hover:text-mark"
                    >
                      New Thread
                    </button>
                  </li>
                  {conversations.map((conversation) => (
                    <li key={conversation.id}>
                      <button
                        type="button"
                        aria-current={conversation.id === chat.conversationId ? 'true' : undefined}
                        onClick={() => openConversation(conversation.id)}
                        className="block w-full truncate px-3 py-2 text-left font-ui text-sm text-graphite transition-[color] duration-[120ms] hover:text-ink"
                      >
                        {conversation.title ?? 'Untitled thread'}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
          </div>
        </header>
        <main id="main" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-8 split:px-10">
            {chat.turns.length === 0 ? (
              <EmptyState onPickExample={pickExample} />
            ) : (
              <MessageList
                turns={chat.turns}
                arrivingAnswerIds={arrivingAnswerIds}
                onRetry={() => {
                  void chat.retry();
                }}
              />
            )}
          </div>
          <Composer
            value={draft}
            onChange={setDraft}
            onSubmit={submitDraft}
            pending={chat.pending}
            textareaRef={textareaRef}
          />
        </main>
      </div>
    </div>
  );
}
