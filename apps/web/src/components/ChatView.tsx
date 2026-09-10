import type { ChatResponse, ConversationSummary } from '@rag/shared';
import {
  ChatCircleDots,
  List,
  Plus,
  SidebarSimple,
  X,
} from '@phosphor-icons/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { Button } from './ui/button';

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [arrivingAnswerIds, setArrivingAnswerIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const pendingWasTrue = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const conversationScrollRef = useRef<HTMLDivElement>(null);
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

  const latestTurnId = chat.turns.at(-1)?.id;

  useLayoutEffect(() => {
    if (!latestTurnId) {
      return;
    }

    const scrollRegion = conversationScrollRef.current;
    if (!scrollRegion) {
      return;
    }

    const reduceMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    scrollRegion.scrollTo({
      top: scrollRegion.scrollHeight,
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  }, [latestTurnId]);

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
        className="absolute left-3 top-3 z-40 -translate-y-[220%] rounded-full bg-page px-3 py-2 font-ui text-xs font-medium text-mark shadow-[0_8px_24px_-18px_rgba(25,29,26,0.35)] transition-[transform] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] focus-visible:translate-y-0"
      >
        Skip to main content
      </a>
      <div className="mx-auto flex h-dvh min-h-0 max-w-[var(--spacing-container)] overflow-hidden bg-page">
        <aside
          aria-label="Thread history"
          className={`hidden shrink-0 border-r border-rule/70 bg-ground/40 transition-[width] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] split:flex split:flex-col ${
            sidebarCollapsed ? 'w-[4.5rem]' : 'w-72'
          }`}
        >
          <div
            className={`flex h-[4.75rem] items-center border-b border-rule/60 px-3 ${
              sidebarCollapsed ? 'justify-center' : 'gap-3'
            }`}
          >
            <div
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-mark text-page"
            >
              <ChatCircleDots size={19} weight="light" />
            </div>
            {sidebarCollapsed ? null : (
              <div className="min-w-0 flex-1">
                <p className="font-ui text-xs font-medium uppercase tracking-[0.12em] text-graphite">
                  Recordings
                </p>
                <h1
                  title={cohortName}
                  className="truncate font-ui text-sm font-semibold text-ink"
                >
                  {cohortName}
                </h1>
              </div>
            )}
          </div>

          <div className="px-3 pb-2 pt-4">
            <Button
              type="button"
              onClick={startNewThread}
              aria-label="New Thread"
              title={sidebarCollapsed ? 'New Thread' : undefined}
              className={`w-full ${sidebarCollapsed ? 'px-0' : 'justify-start'}`}
            >
              <Plus size={17} weight="light" aria-hidden="true" />
              {sidebarCollapsed ? <span className="sr-only">New Thread</span> : 'New Thread'}
            </Button>
          </div>

          {sidebarCollapsed ? (
            <div className="flex flex-1 flex-col items-center gap-2 px-3 py-3">
              <ChatCircleDots
                size={20}
                weight="light"
                className="text-graphite"
                aria-hidden="true"
              />
              {conversations.length > 0 ? (
                <span className="font-ui text-xs tabular-nums text-graphite">
                  {conversations.length}
                </span>
              ) : null}
            </div>
          ) : (
            <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-3" aria-label="Recent threads">
              <p className="px-2 pb-2 font-ui text-xs font-medium uppercase tracking-[0.12em] text-graphite">
                Recent
              </p>
              <ul className="space-y-0.5">
                {conversations.map((conversation) => (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      aria-current={conversation.id === chat.conversationId ? 'page' : undefined}
                      onClick={() => openConversation(conversation.id)}
                      className={`block w-full truncate rounded-xl px-2.5 py-2 text-left font-ui text-sm transition-[background-color,color,transform] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.985] ${
                        conversation.id === chat.conversationId
                          ? 'bg-page font-medium text-ink shadow-sm'
                          : 'text-graphite hover:bg-page/70 hover:text-ink'
                      }`}
                    >
                      {conversation.title ?? 'Untitled thread'}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}

          <div className="border-t border-rule/60 p-3">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
              className={sidebarCollapsed ? 'mx-auto' : 'ml-auto'}
            >
              <SidebarSimple
                size={19}
                weight="light"
                className={sidebarCollapsed ? 'rotate-180' : undefined}
                aria-hidden="true"
              />
            </Button>
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-16 shrink-0 items-center gap-3 border-b border-rule/60 bg-page px-4 split:hidden">
            <div ref={menuRef} className="contents">
              <Button
                ref={menuTriggerRef}
                type="button"
                variant="ghost"
                size="icon"
                aria-label={menuOpen ? 'Close thread history' : 'Open thread history'}
                aria-expanded={menuOpen}
                aria-haspopup="dialog"
                aria-controls={conversationsListId}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <List size={21} weight="light" aria-hidden="true" />
              </Button>

              {menuOpen ? (
                <>
                  <button
                    type="button"
                    aria-label="Close thread history"
                    onClick={() => setMenuOpen(false)}
                    className="fixed inset-0 z-30 cursor-default bg-ink/20 backdrop-blur-[1px] split:hidden"
                  />
                  <aside
                    id={conversationsListId}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Thread history"
                    className="drawer-in fixed inset-y-0 left-0 z-40 flex w-[min(20rem,88vw)] flex-col bg-page shadow-[18px_0_48px_-32px_rgba(25,29,26,0.32)] split:hidden"
                  >
                    <div className="flex h-16 items-center gap-3 border-b border-rule/60 px-4">
                      <div
                        aria-hidden="true"
                        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-mark text-page"
                      >
                        <ChatCircleDots size={19} weight="light" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-ui text-xs font-medium uppercase tracking-[0.12em] text-graphite">
                          Recordings
                        </p>
                        <p className="truncate font-ui text-sm font-semibold text-ink" title={cohortName}>
                          {cohortName}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Close thread history"
                        onClick={() => setMenuOpen(false)}
                      >
                        <X size={20} weight="light" aria-hidden="true" />
                      </Button>
                    </div>

                    <div className="px-4 pb-2 pt-4">
                      <Button type="button" onClick={startNewThread} className="w-full justify-start">
                        <Plus size={17} weight="light" aria-hidden="true" />
                        New Thread
                      </Button>
                    </div>
                    <nav className="min-h-0 flex-1 overflow-y-auto px-4 py-3" aria-label="Recent threads">
                      <p className="px-2 pb-2 font-ui text-xs font-medium uppercase tracking-[0.12em] text-graphite">
                        Recent
                      </p>
                      <ul className="space-y-0.5">
                        {conversations.map((conversation) => (
                          <li key={conversation.id}>
                            <button
                              type="button"
                              aria-current={conversation.id === chat.conversationId ? 'page' : undefined}
                              onClick={() => openConversation(conversation.id)}
                              className={`block w-full truncate rounded-xl px-2.5 py-2.5 text-left font-ui text-sm transition-[background-color,color,transform] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.985] ${
                                conversation.id === chat.conversationId
                                  ? 'bg-ground/70 font-medium text-ink'
                                  : 'text-graphite hover:bg-ground/50 hover:text-ink'
                              }`}
                            >
                              {conversation.title ?? 'Untitled thread'}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </nav>
                  </aside>
                </>
              ) : null}
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="truncate font-ui text-sm font-semibold text-ink" title={cohortName}>
                {cohortName}
              </h1>
            </div>
          </header>

          <main id="main" className="flex min-h-0 min-w-0 flex-1 flex-col bg-page">
            {chat.turns.length === 0 ? (
              <div className="flex min-h-0 flex-1 overflow-y-auto px-5 py-10 split:px-12 split:py-16">
                <div className="m-auto w-full max-w-3xl">
                  <EmptyState onPickExample={pickExample}>
                    <Composer
                      variant="hero"
                      value={draft}
                      onChange={setDraft}
                      onSubmit={submitDraft}
                      pending={chat.pending}
                      textareaRef={textareaRef}
                    />
                  </EmptyState>
                </div>
              </div>
            ) : (
              <>
                <div
                  ref={conversationScrollRef}
                  className="min-h-0 flex-1 overflow-y-auto px-5 py-8 split:px-10 split:py-10"
                >
                  <MessageList
                    turns={chat.turns}
                    arrivingAnswerIds={arrivingAnswerIds}
                    onRetry={() => {
                      void chat.retry();
                    }}
                  />
                </div>
                <Composer
                  variant="docked"
                  value={draft}
                  onChange={setDraft}
                  onSubmit={submitDraft}
                  pending={chat.pending}
                  textareaRef={textareaRef}
                />
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
