import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface Message {
  role: "user" | "assistant";
  text: string;
}

export interface Session {
  id: string;
  name: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  isNameCustomized: boolean;
}

function makeSession(): Session {
  return {
    id: crypto.randomUUID(),
    name: "新对话",
    messages: [],
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
  appendUserMessage: (sessionId: string, text: string) => void;
  updateAssistantDelta: (sessionId: string, delta: string) => void;
  setAssistantError: (sessionId: string, error: string) => void;
  touchSession: (id: string) => void;
}

const initSession = makeSession();

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      sessions: [initSession],
      activeId: initSession.id,
      openTabIds: [initSession.id],

      addSession() {
        const { sessions, openTabIds } = get();
        const emptyOpen = openTabIds
          .map(tid => sessions.find(s => s.id === tid))
          .find(s => s && s.messages.length === 0);
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
        const next = openTabIds.filter(t => t !== id);
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
        const nextSessions = sessions.filter(s => s.id !== id);
        const nextTabs = openTabIds.filter(t => t !== id);
        if (nextSessions.length === 0) {
          const s = makeSession();
          set({
            sessions: [s],
            openTabIds: [s.id],
            activeId: s.id,
          });
          return;
        }
        const updates: Partial<ChatState> = {
          sessions: nextSessions,
          openTabIds: nextTabs.length > 0 ? nextTabs : [nextSessions[nextSessions.length - 1].id],
        };
        if (activeId === id) {
          updates.activeId = (updates.openTabIds as string[])[(updates.openTabIds as string[]).length - 1];
        }
        set(updates);
      },

      setActiveId(id) {
        set({ activeId: id });
      },

      renameSession(id, name, customized = false) {
        set(s => ({
          sessions: s.sessions.map(sess =>
            sess.id === id
              ? { ...sess, name, updatedAt: Date.now(), ...(customized ? { isNameCustomized: true } : {}) }
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

      appendUserMessage(sessionId, text) {
        set(s => ({
          sessions: s.sessions.map(sess =>
            sess.id === sessionId
              ? {
                  ...sess,
                  messages: [
                    ...sess.messages,
                    { role: "user" as const, text },
                    { role: "assistant" as const, text: "" },
                  ],
                  updatedAt: Date.now(),
                }
              : sess
          ),
        }));
      },

      updateAssistantDelta(sessionId, delta) {
        set(s => ({
          sessions: s.sessions.map(sess => {
            if (sess.id !== sessionId) return sess;
            const msgs = [...sess.messages];
            const last = msgs[msgs.length - 1];
            if (last?.role === "assistant") {
              msgs[msgs.length - 1] = { ...last, text: last.text + delta };
            }
            return { ...sess, messages: msgs };
          }),
        }));
      },

      setAssistantError(sessionId, error) {
        set(s => ({
          sessions: s.sessions.map(sess => {
            if (sess.id !== sessionId) return sess;
            const msgs = [...sess.messages];
            const last = msgs[msgs.length - 1];
            if (last?.role === "assistant") {
              const prefix = last.text ? last.text + "\n\n" : "";
              msgs[msgs.length - 1] = { ...last, text: `${prefix}[错误] ${error}` };
            }
            return { ...sess, messages: msgs };
          }),
        }));
      },

      touchSession(id) {
        set(s => ({
          sessions: s.sessions.map(sess =>
            sess.id === id ? { ...sess, updatedAt: Date.now() } : sess
          ),
        }));
      },
    }),
    {
      name: "claw-chat-store",
    }
  )
);
