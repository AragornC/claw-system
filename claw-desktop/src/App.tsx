import { useState, useCallback, useRef, useEffect } from "react";
import Sidebar from "./components/Sidebar";
import Workspace from "./components/Workspace";
import AgentPanel from "./components/AgentPanel";
import TradingBar from "./components/TradingBar";
import TitleBar from "./components/TitleBar";
import SubHeader from "./components/SubHeader";
import Settings from "./components/Settings";
import { runWorkflow } from "./lib/workflow";
import { initRuntime as initPython, exec as pyExec } from "./lib/python/runtime";
import { useModelStore } from "./store/modelStore";
import { useChatStore } from "./store/chatStore";
import { useExchangeStore } from "./store/exchangeStore";
import { useAgentStore } from "./store/agentStore";
import { useFeatureStore } from "./store/featureStore";
import type { Session } from "./store/chatStore";
import "./App.css";

export type { Session };
export type { Message } from "./store/chatStore";
export type { ChatItem } from "./types/workflow";

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

  // Surface routing — features take priority over settings: clicking a
  // feature tab keeps the Settings tab in the bar but switches the center
  // pane to Workspace. Clicking the Settings tab clears activeTabSlug.
  const activeFeatureSlug = useFeatureStore(s => s.activeTabSlug);
  const activeAgentView = useAgentStore(s => s.activeView);

  useEffect(() => {
    useModelStore.getState().initFromBackend();
    useExchangeStore.getState().initFromBackend();
    useAgentStore.getState().initFromBackend();
    useFeatureStore.getState().initFromBackend();
    // Preload Pyodide so the first feature run is instant. Smoke test:
    // round-trip 1+1 through the worker to confirm the boundary works.
    initPython()
      .then(() => pyExec("1 + 1"))
      .then((v) => console.info("[python] smoke 1+1 =", v))
      .catch((e) => console.error("[python] init failed:", e));
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
    const { selectedModel, auth } = useModelStore.getState();
    const hasConnected = Object.values(auth).some(a => a.connected);
    if (!hasConnected) return;

    setStreaming(true);
    streamAbort.current = false;

    try {
      await runWorkflow(text, sid, selectedModel.providerId, selectedModel.modelId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      useChatStore.getState().pushItem(sid, { kind: "text", text: `[错误] ${msg}` });
    } finally {
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
              {/* Routing priority: active feature → Workspace; else if Settings
                  tab is open AND no feature/agent override → Settings panel;
                  else → Workspace empty state. The activeAgentView path also
                  drops into Settings since AgentDetail/SkillEditor render inside
                  AgentSettingsPanel. */}
              {activeFeatureSlug
                ? <Workspace />
                : (showSettings || activeAgentView)
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
              onOpenSettings={() => setShowSettings(true)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
