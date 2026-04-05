import { useState, useCallback, useRef, useEffect } from "react";
import Sidebar from "./components/Sidebar";
import Workspace from "./components/Workspace";
import AgentPanel from "./components/AgentPanel";
import TradingBar from "./components/TradingBar";
import TitleBar from "./components/TitleBar";
import SubHeader from "./components/SubHeader";
import Settings from "./components/Settings";
import { chatStream, generateTitle } from "./lib/llm";
import { useModelStore } from "./store/modelStore";
import { useChatStore } from "./store/chatStore";
import { useExchangeStore } from "./store/exchangeStore";
import type { Session } from "./store/chatStore";
import "./App.css";

export type { Session };
export type { Message } from "./store/chatStore";

export default function App() {
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [agentWidth, setAgentWidth] = useState(300);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showTrading, setShowTrading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const streamAbort = useRef(false);

  const sessions = useChatStore(s => s.sessions);
  const activeId = useChatStore(s => s.activeId);
  const openTabIds = useChatStore(s => s.openTabIds);

  useEffect(() => {
    useModelStore.getState().initFromBackend();
    useExchangeStore.getState().initFromBackend();
  }, []);

  const openTabs = openTabIds
    .map(tid => sessions.find(s => s.id === tid))
    .filter((s): s is Session => !!s);

  function handleNewSession() {
    useChatStore.getState().addSession();
  }

  function handleReorderSessions(newOrder: Session[]) {
    useChatStore.getState().reorderTabs(newOrder.map(s => s.id));
  }

  function handleRenameSession(id: string, name: string) {
    useChatStore.getState().renameSession(id, name, true);
  }

  function handleCloseSession(id: string) {
    useChatStore.getState().removeTab(id);
  }

  const handleSendMessage = useCallback(async (text: string) => {
    const sid = activeId;
    const { selectedModel } = useModelStore.getState();
    const store = useChatStore.getState();

    const currentSession = store.sessions.find(s => s.id === sid);
    const isFirstMessage = currentSession ? currentSession.messages.length === 0 : true;

    const history = currentSession
      ? currentSession.messages.map(m => ({ role: m.role, content: m.text }))
      : [];
    history.push({ role: "user", content: text });

    store.appendUserMessage(sid, text);

    setStreaming(true);
    streamAbort.current = false;

    if (isFirstMessage && !currentSession?.isNameCustomized) {
      generateTitle(selectedModel.providerId, selectedModel.modelId, text)
        .then((title: string) => useChatStore.getState().renameSession(sid, title, false))
        .catch(() => {});
    }

    try {
      await chatStream(
        selectedModel.providerId,
        selectedModel.modelId,
        history,
        (chunk) => {
          if (streamAbort.current) return;
          if (chunk.error) {
            useChatStore.getState().setAssistantError(sid, chunk.error!);
            setStreaming(false);
            return;
          }
          if (chunk.done) {
            setStreaming(false);
            return;
          }
          if (chunk.delta) {
            useChatStore.getState().updateAssistantDelta(sid, chunk.delta);
          }
        }
      );
    } catch (e: any) {
      const msg = typeof e === "string" ? e : e?.message ?? "未知错误";
      useChatStore.getState().setAssistantError(sid, msg);
      setStreaming(false);
    }
  }, [activeId]);

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
            sessions={openTabs}
            activeId={activeId}
            onSwitch={(id) => useChatStore.getState().setActiveId(id)}
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
