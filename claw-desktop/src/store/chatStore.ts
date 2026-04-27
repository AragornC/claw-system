import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ChatItem } from "../types/workflow";

// ── Legacy type (for migration) ─────────────────────────────
export interface Message {
  role: "user" | "assistant";
  text: string;
}

export interface Session {
  id: string;
  name: string;
  items: ChatItem[];
  createdAt: number;
  updatedAt: number;
  isNameCustomized: boolean;
  // Legacy field — only present in old persisted data
  messages?: Message[];
}

function makeSession(): Session {
  return {
    id: crypto.randomUUID(),
    name: "新对话",
    items: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isNameCustomized: false,
  };
}

interface ChatState {
  sessions: Session[];
  activeId: string;
  openTabIds: string[];

  addSession: () => string;
  removeTab: (id: string) => void;
  deleteSession: (id: string) => void;
  setActiveId: (id: string) => void;
  renameSession: (id: string, name: string, customized?: boolean) => void;
  reorderTabs: (ids: string[]) => void;
  openTab: (id: string) => void;
  touchSession: (id: string) => void;

  // ── New workflow-oriented actions ──────────────────────
  pushItem: (sessionId: string, item: ChatItem) => void;
  updateItem: (sessionId: string, index: number, updater: (item: ChatItem) => ChatItem) => void;
  updateLastItem: (sessionId: string, updater: (item: ChatItem) => ChatItem) => void;

  // ── Legacy compat (thin wrappers) ─────────────────────
  appendUserMessage: (sessionId: string, text: string) => void;
  updateAssistantDelta: (sessionId: string, delta: string) => void;
  setAssistantError: (sessionId: string, error: string) => void;
}

const initSession = makeSession();

// ── Migrate old sessions (messages → items) ─────────────────
function migrateSession(sess: Session): Session {
  // Already migrated
  if (Array.isArray(sess.items) && sess.items.length > 0) return sess;
  // Has old messages field
  const oldMsgs = (sess as unknown as { messages?: Message[] }).messages;
  if (Array.isArray(oldMsgs) && oldMsgs.length > 0) {
    const items: ChatItem[] = oldMsgs.map((m) =>
      m.role === "user"
        ? { kind: "user" as const, text: m.text }
        : { kind: "text" as const, text: m.text }
    );
    return { ...sess, items, messages: undefined };
  }
  // Empty session — ensure items is always an array
  return { ...sess, items: Array.isArray(sess.items) ? sess.items : [] };
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      sessions: [initSession],
      activeId: initSession.id,
      openTabIds: [initSession.id],

      addSession() {
        const { sessions, openTabIds } = get();
        const emptyOpen = openTabIds
          .map((tid) => sessions.find((s) => s.id === tid))
          .find((s) => s && s.items.length === 0);
        if (emptyOpen) {
          set({ activeId: emptyOpen.id });
          return emptyOpen.id;
        }
        const s = makeSession();
        set({
          sessions: [...sessions, s],
          openTabIds: [...openTabIds, s.id],
          activeId: s.id,
        });
        return s.id;
      },

      removeTab(id) {
        const { openTabIds, activeId, sessions } = get();
        const next = openTabIds.filter((t) => t !== id);
        if (next.length === 0) {
          const s = makeSession();
          set({
            sessions: [...sessions, s],
            openTabIds: [s.id],
            activeId: s.id,
          });
          return;
        }
        const updates: Partial<ChatState> = { openTabIds: next };
        if (activeId === id) {
          updates.activeId = next[next.length - 1];
        }
        set(updates);
      },

      deleteSession(id) {
        const { sessions, openTabIds, activeId } = get();
        const nextSessions = sessions.filter((s) => s.id !== id);
        const nextTabs = openTabIds.filter((t) => t !== id);
        if (nextSessions.length === 0) {
          const s = makeSession();
          set({ sessions: [s], openTabIds: [s.id], activeId: s.id });
          return;
        }
        const updates: Partial<ChatState> = {
          sessions: nextSessions,
          openTabIds:
            nextTabs.length > 0
              ? nextTabs
              : [nextSessions[nextSessions.length - 1].id],
        };
        if (activeId === id) {
          updates.activeId = (updates.openTabIds as string[])[
            (updates.openTabIds as string[]).length - 1
          ];
        }
        set(updates);
      },

      setActiveId(id) {
        set({ activeId: id });
      },

      renameSession(id, name, customized = false) {
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === id
              ? {
                  ...sess,
                  name,
                  updatedAt: Date.now(),
                  ...(customized ? { isNameCustomized: true } : {}),
                }
              : sess
          ),
        }));
      },

      reorderTabs(ids) {
        set({ openTabIds: ids });
      },

      openTab(id) {
        const { openTabIds } = get();
        if (!openTabIds.includes(id)) {
          set({ openTabIds: [...openTabIds, id], activeId: id });
        } else {
          set({ activeId: id });
        }
      },

      touchSession(id) {
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === id ? { ...sess, updatedAt: Date.now() } : sess
          ),
        }));
      },

      // ── New: push a ChatItem to session ───────────────────
      pushItem(sessionId, item) {
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === sessionId
              ? { ...sess, items: [...sess.items, item], updatedAt: Date.now() }
              : sess
          ),
        }));
      },

      // ── New: update item at index ─────────────────────────
      updateItem(sessionId, index, updater) {
        set((s) => ({
          sessions: s.sessions.map((sess) => {
            if (sess.id !== sessionId) return sess;
            const items = [...sess.items];
            if (index >= 0 && index < items.length) {
              items[index] = updater(items[index]);
            }
            return { ...sess, items };
          }),
        }));
      },

      // ── New: update the last item ─────────────────────────
      updateLastItem(sessionId, updater) {
        set((s) => ({
          sessions: s.sessions.map((sess) => {
            if (sess.id !== sessionId) return sess;
            const items = [...sess.items];
            if (items.length > 0) {
              items[items.length - 1] = updater(items[items.length - 1]);
            }
            return { ...sess, items };
          }),
        }));
      },

      // ── Legacy: append user message (pushes user item) ────
      appendUserMessage(sessionId, text) {
        get().pushItem(sessionId, { kind: "user", text });
      },

      // ── Legacy: append to last text item ──────────────────
      updateAssistantDelta(sessionId, delta) {
        set((s) => ({
          sessions: s.sessions.map((sess) => {
            if (sess.id !== sessionId) return sess;
            const items = [...sess.items];
            const last = items[items.length - 1];
            if (last?.kind === "text") {
              items[items.length - 1] = { ...last, text: last.text + delta };
            }
            return { ...sess, items };
          }),
        }));
      },

      // ── Legacy: set error on last text item ───────────────
      setAssistantError(sessionId, error) {
        set((s) => ({
          sessions: s.sessions.map((sess) => {
            if (sess.id !== sessionId) return sess;
            const items = [...sess.items];
            const last = items[items.length - 1];
            if (last?.kind === "text") {
              const prefix = last.text ? last.text + "\n\n" : "";
              items[items.length - 1] = {
                ...last,
                text: `${prefix}[错误] ${error}`,
              };
            }
            return { ...sess, items };
          }),
        }));
      },
    }),
    {
      name: "claw-chat-store",
      version: 2,
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as ChatState;
        if (version < 2) {
          // Migrate old sessions: messages → items
          return {
            ...state,
            sessions: (state.sessions || []).map(migrateSession),
          };
        }
        return state;
      },
    }
  )
);
