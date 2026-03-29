import { useState } from "react";
import Sidebar from "./components/Sidebar";
import Workspace from "./components/Workspace";
import AgentPanel from "./components/AgentPanel";
import TradingBar from "./components/TradingBar";
import TitleBar from "./components/TitleBar";
import SubHeader from "./components/SubHeader";
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

const DEMO_MESSAGES: Message[] = [
  { role: "user", text: "帮我生成一个基于均线死叉的风控特征" },
  { role: "agent", text: "好的，我来帮你生成这个特征。均线死叉信号是当短期均线下穿长期均线时触发，通常预示下跌风险。\n\n我会用 MA20 和 MA60 组合，生成一个 0/1 的二值特征。开始执行…" },
  { role: "user", text: "验证的时候多看几个回测周期" },
  { role: "agent", text: "明白，我已经在验证步骤中加入了 2020–2024 年的多周期回测，当前第 2 轮验证进行中，数据量 334 根 K 线。" },
];

const INIT_SESSIONS: Session[] = [
  { id: "daily", name: "日常启动", messages: [] },
  { id: "feat-1", name: "特征生成任务", messages: DEMO_MESSAGES },
];

export default function App() {
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [agentWidth, setAgentWidth] = useState(300);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showTrading, setShowTrading] = useState(true);
  const [sessions, setSessions] = useState<Session[]>(INIT_SESSIONS);
  const [activeId, setActiveId] = useState("feat-1");

  function handleNewSession() {
    // 已有空对话时直接跳过去，不重复创建
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
      // 至少保留一个 session，关掉最后一个时自动补一个新对话
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

  function handleSendMessage(text: string) {
    setSessions(prev => prev.map(s =>
      s.id === activeId
        ? { ...s, messages: [...s.messages, { role: "user", text }] }
        : s
    ));
  }

  const activeSession = sessions.find(s => s.id === activeId) ?? sessions[0];

  return (
    <div className="app-root">
      <TitleBar
        showSidebar={showSidebar}
        showTrading={showTrading}
        onToggleSidebar={() => setShowSidebar(v => !v)}
        onToggleTrading={() => setShowTrading(v => !v)}
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
          />
          <div className="app-content-row">
            <div className="app-center">
              <Workspace />
              {showTrading && <TradingBar onClose={() => setShowTrading(false)} />}
            </div>
            <AgentPanel
              width={agentWidth}
              onResize={setAgentWidth}
              session={activeSession}
              onSend={handleSendMessage}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
