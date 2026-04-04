import { useRef, useState, useEffect } from "react";
import type { Session } from "../App";
import { useModelStore, PROVIDER_IDS, PROVIDER_META } from "../store/modelStore";
import "./AgentPanel.css";

interface Props {
  width: number;
  onResize: (w: number) => void;
  session: Session;
  onSend: (text: string) => void;
  streaming: boolean;
}

export default function AgentPanel({ width, onResize, session, onSend, streaming }: Props) {
  const [input, setInput] = useState("");
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");
  const [showModelPicker, setShowModelPicker] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const selectedModel = useModelStore((s) => s.selectedModel);
  const auth = useModelStore((s) => s.auth);
  const enabledModels = useModelStore((s) => s.enabledModels);
  const selectModel = useModelStore((s) => s.selectModel);

  useEffect(() => {
    if (!showModelPicker) return;
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowModelPicker(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showModelPicker]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session.messages]);

  function onMouseDown() {
    dragging.current = true;
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const newW = window.innerWidth - e.clientX;
      onResize(Math.max(220, Math.min(500, newW)));
    };
    const onUp = () => { dragging.current = false; window.removeEventListener("mousemove", onMove); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, { once: true });
  }

  function handleUserBubbleClick(text: string, idx: number) {
    setEditingIdx(idx);
    setEditingText(text);
    setTimeout(() => {
      editRef.current?.focus();
      editRef.current?.select();
    }, 0);
  }

  function handleEditSend() {
    if (!editingText.trim()) return;
    setEditingIdx(null);
    setEditingText("");
  }

  function handleEditCancel() {
    setEditingIdx(null);
    setEditingText("");
  }

  function handleSend() {
    if (!input.trim()) return;
    onSend(input.trim());
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
  }

  return (
    <aside className="agent-panel" style={{ width }}>
      <div className="agent-resizer" onMouseDown={onMouseDown} />

      <div className="agent-inner">
        <div className="agent-messages">
          {session.messages.length === 0 && (
            <div className="agent-empty">
              <p>开始一个新的对话</p>
            </div>
          )}
          {session.messages.map((m, i) => (
            m.role === "user" ? (
              <div key={i} className="msg-user-wrap">
                {editingIdx === i ? (
                  <div className="msg-user-editing agent-input-box">
                    <textarea
                      ref={editRef}
                      className="agent-input"
                      value={editingText}
                      onChange={(e) => {
                        setEditingText(e.target.value);
                        e.target.style.height = "auto";
                        e.target.style.height = e.target.scrollHeight + "px";
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleEditSend(); }
                        if (e.key === "Escape") handleEditCancel();
                      }}
                    />
                    <div className="agent-input-toolbar">
                      <div className="agent-toolbar-left" />
                      <div className="agent-toolbar-right">
                        <button className="msg-edit-cancel-btn" onClick={handleEditCancel}>取消</button>
                        <button className="agent-send" onClick={handleEditSend} disabled={!editingText.trim()}>↑</button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div
                    className="msg-user-bubble"
                    onClick={() => handleUserBubbleClick(m.text, i)}
                    title="点击重新编辑"
                  >
                    {m.text}
                    <span className="msg-edit-icon">✎</span>
                  </div>
                )}
              </div>
            ) : (
              <div key={i} className="msg-agent-wrap">
                <div className="msg-agent-body">
                  {m.text
                    ? m.text.split("\n\n").map((p, j) => <p key={j}>{p}</p>)
                    : streaming && i === session.messages.length - 1
                      ? <div className="msg-typing"><span /><span /><span /></div>
                      : null
                  }
                </div>
              </div>
            )
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* 底部输入框 */}
        <div className="agent-input-area">
          <div className="agent-input-box">
            <textarea
              ref={inputRef}
              className="agent-input"
              rows={1}
              placeholder="描述你的需求…"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = e.target.scrollHeight + "px";
              }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            />
            <div className="agent-input-toolbar">
              <div className="agent-toolbar-left">
                <div ref={dropdownRef} style={{ position: "relative" }}>
                  <div className="agent-model-selector" onClick={() => setShowModelPicker(v => !v)}>
                    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4">
                      <rect x="2" y="3" width="12" height="10" rx="1.5"/>
                      <path d="M5.5 7h5M5.5 9.5h3" strokeLinecap="round"/>
                    </svg>
                    <span>{selectedModel.modelId}</span>
                    <svg viewBox="0 0 10 6" width="8" height="5" fill="currentColor">
                      <path d="M1 1l4 4 4-4"/>
                    </svg>
                  </div>
                  {showModelPicker && (
                    <div className="agent-model-dropdown" onClick={e => e.stopPropagation()}>
                      {PROVIDER_IDS.map(pid => {
                        const provAuth = auth[pid];
                        if (!provAuth?.connected) return null;
                        const enabled = enabledModels[pid] ?? [];
                        if (enabled.length === 0) return null;
                        const meta = PROVIDER_META[pid];
                        return (
                          <div key={pid}>
                            <div className="agent-model-group">{meta.name}</div>
                            {enabled.map(modelId => (
                              <div
                                key={modelId}
                                className={`agent-model-option ${selectedModel.providerId === pid && selectedModel.modelId === modelId ? "active" : ""}`}
                                onClick={() => {
                                  selectModel(pid, modelId);
                                  setShowModelPicker(false);
                                }}
                              >
                                {modelId}
                              </div>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              <div className="agent-toolbar-right">
                <button className="agent-send" disabled={!input.trim() || streaming} onClick={handleSend}>↑</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
