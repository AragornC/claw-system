import { useRef, useState } from "react";
import type { Session } from "../App";
import "./AgentPanel.css";

interface Props {
  width: number;
  onResize: (w: number) => void;
  session: Session;
  onSend: (text: string) => void;
}

export default function AgentPanel({ width, onResize, session, onSend }: Props) {
  const [input, setInput] = useState("");
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const dragging = useRef(false);

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
                  {m.text.split("\n\n").map((p, j) => <p key={j}>{p}</p>)}
                </div>
              </div>
            )
          ))}
          <div className="msg-agent-wrap">
            <div className="msg-typing">
              <span /><span /><span />
            </div>
          </div>
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
                // 自动撑高：重置高度再设为 scrollHeight
                e.target.style.height = "auto";
                e.target.style.height = e.target.scrollHeight + "px";
              }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            />
            <div className="agent-input-toolbar">
              <div className="agent-toolbar-left">
                <span className="agent-toolbar-tag">⟳ Agent</span>
                <span className="agent-toolbar-tag">Auto</span>
              </div>
              <div className="agent-toolbar-right">
                <span className="agent-toolbar-icon" title="附件">⊞</span>
                <button className="agent-send" disabled={!input.trim()} onClick={handleSend}>↑</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
