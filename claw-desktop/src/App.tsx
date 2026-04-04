import { useState, useCallback, useRef, useEffect } from "react";
import Sidebar from "./components/Sidebar";
import Workspace from "./components/Workspace";
import AgentPanel from "./components/AgentPanel";
import TradingBar from "./components/TradingBar";
import TitleBar from "./components/TitleBar";
import SubHeader from "./components/SubHeader";
import Settings from "./components/Settings";
import { chatStream } from "./lib/llm";
import { useModelStore } from "./store/modelStore";
import "./App.css";

export interface Message {
  role: "user" | "agent";
  text: string;
}

export interface Session {
  id: string;
  name: string;
  messages: Message[];
}

const INIT_SESSIONS: Session[] = [
  { id: "daily", name: "新对话", messages: [] },
];

export default function App() {
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [agentWidth, setAgentWidth] = useState(300);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showTrading, setShowTrading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [sessions, setSessions] = useState<Session[]>(INIT_SESSIONS);
  const [activeId, setActiveId] = useState("daily");
  const [streaming, setStreaming] = useState(false);
  const streamAbort = useRef(false);

  useEffect(() => {
    useModelStore.getState().initFromBackend();
  }, []);

  function handleNewSession() {
    const empty = sessions.find(s => s.messages.length === 0);
    if (empty) {
      setActiveId(empty.id);
      return;
    }
    const id = `session-${Date.now()}`;
    setSessions(prev => [...prev, { id, name: "新对话", messages: [] }]);
    setActiveId(id);
  }

  function handleReorderSessions(newOrder: Session[]) {
    setSessions(newOrder);
  }

  function handleRenameSession(id: string, name: string) {
    setSessions(prev => prev.map(s => s.id === id ? { ...s, name } : s));
  }

  function handleCloseSession(id: string) {
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id);
      if (next.length === 0) {
        const newId = `session-${Date.now()}`;
        const fresh: Session = { id: newId, name: "新对话", messages: [] };
        setActiveId(newId);
        return [fresh];
      }
      if (activeId === id) {
        setActiveId(next[next.length - 1].id);
      }
      return next;
    });
  }

  const handleSendMessage = useCallback(async (text: string) => {
    const sid = activeId;
    const { selectedModel } = useModelStore.getState();

    setSessions(prev => prev.map(s =>
      s.id === sid
        ? { ...s, messages: [...s.messages, { role: "user" as const, text }, { role: "agent" as const, text: "" }] }
        : s
    ));

    setStreaming(true);
    streamAbort.current = false;

    const currentSession = sessions.find(s => s.id === sid);
    const history = currentSession
      ? currentSession.messages.map(m => ({
          role: m.role === "user" ? "user" : "assistant",
          content: m.text,
        }))
      : [];
    history.push({ role: "user", content: text });

    try {
      await chatStream(
        selectedModel.providerId,
        selectedModel.modelId,
        history,
        (chunk) => {
          if (streamAbort.current) return;
          if (chunk.error) {
            setSessions(prev => prev.map(s => {
              if (s.id !== sid) return s;
              const msgs = [...s.messages];
              const last = msgs[msgs.length - 1];
              if (last?.role === "agent") {
                msgs[msgs.length - 1] = { ...last, text: last.text + `\n\n[错误] ${chunk.error}` };
              }
              return { ...s, messages: msgs };
            }));
            setStreaming(false);
            return;
          }
          if (chunk.done) {
            setStreaming(false);
            return;
          }
          if (chunk.delta) {
            setSessions(prev => prev.map(s => {
              if (s.id !== sid) return s;
              const msgs = [...s.messages];
              const last = msgs[msgs.length - 1];
              if (last?.role === "agent") {
                msgs[msgs.length - 1] = { ...last, text: last.text + chunk.delta };
              }
              return { ...s, messages: msgs };
            }));
          }
        }
      );
    } catch (e: any) {
      setSessions(prev => prev.map(s => {
        if (s.id !== sid) return s;
        const msgs = [...s.messages];
        const last = msgs[msgs.length - 1];
        if (last?.role === "agent") {
          msgs[msgs.length - 1] = { ...last, text: `[错误] ${typeof e === "string" ? e : e?.message ?? "未知错误"}` };
        }
        return { ...s, messages: msgs };
      }));
      setStreaming(false);
    }
  }, [activeId, sessions]);

  const activeSession = sessions.find(s => s.id === activeId) ?? sessions[0];

  return (
    <div className="app-root">
      <TitleBar
        showSidebar={showSidebar}
        showTrading={showTrading}
        onToggleSidebar={() => setShowSidebar(v => !v)}
        onToggleTrading={() => setShowTrading(v => !v)}
        onOpenSettings={() => setShowSettings(true)}
      />
      <div className="app-body">
        {showSidebar && <Sidebar width={sidebarWidth} onResize={setSidebarWidth} />}
        <div className="app-rest">
          <SubHeader
            agentWidth={agentWidth}
            sessions={sessions}
            activeId={activeId}
            onSwitch={setActiveId}
            onNew={handleNewSession}
            onClose={handleCloseSession}
            onReorder={handleReorderSessions}
            onRename={handleRenameSession}
            showSettings={showSettings}
            onCloseSettings={() => setShowSettings(false)}
          />
          <div className="app-content-row">
            <div className="app-center">
              {showSettings
                ? <Settings onClose={() => setShowSettings(false)} />
                : <Workspace />
              }
              {showTrading && <TradingBar onClose={() => setShowTrading(false)} />}
            </div>
            <AgentPanel
              width={agentWidth}
              onResize={setAgentWidth}
              session={activeSession}
              onSend={handleSendMessage}
              streaming={streaming}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
