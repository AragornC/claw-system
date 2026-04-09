import { useState } from "react";
import { useAgentStore } from "../../store/agentStore";
import type { ToolParam, PermLevel } from "../../types/agent";

interface Props {
  onClose: () => void;
}

export default function RegisterModal({ onClose }: Props) {
  const addFunction = useAgentStore((s) => s.addFunction);
  const [id, setId] = useState("");
  const [desc, setDesc] = useState("");
  const [cat, setCat] = useState("");
  const [perm, setPerm] = useState<PermLevel>("auto");
  const [params, setParams] = useState<ToolParam[]>([]);

  function addParam() {
    setParams([...params, { name: "", type: "string", req: false, desc: "" }]);
  }

  function removeParam(i: number) {
    setParams(params.filter((_, idx) => idx !== i));
  }

  function updateParam(i: number, patch: Partial<ToolParam>) {
    setParams(params.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  }

  function handleSubmit() {
    if (!id.trim() || !desc.trim()) return;
    addFunction({
      id: id.trim(),
      desc: desc.trim(),
      cat: cat.trim() || "自定义",
      perm,
      params: params.filter((p) => p.name.trim()),
      agents: [],
    });
    onClose();
  }

  return (
    <div className="ac-overlay" onClick={onClose}>
      <div className="ac-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="ac-modal-title">注册新 Function</h3>

        <label className="ac-form-label">ID</label>
        <input className="ac-form-input" value={id} onChange={(e) => setId(e.target.value)} placeholder="e.g. my_tool" />

        <label className="ac-form-label">描述</label>
        <input className="ac-form-input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="这个工具做什么" />

        <label className="ac-form-label">分类</label>
        <input className="ac-form-input" value={cat} onChange={(e) => setCat(e.target.value)} placeholder="e.g. 搜索、计算" />

        <label className="ac-form-label">权限</label>
        <div className="ac-perm-opts">
          {(["auto", "ask", "deny"] as PermLevel[]).map((p) => (
            <button
              key={p}
              className={`ac-perm-opt ${perm === p ? `ac-perm-sel-${p}` : ""}`}
              onClick={() => setPerm(p)}
            >
              {p}
            </button>
          ))}
        </div>

        <label className="ac-form-label">参数</label>
        {params.map((p, i) => (
          <div key={i} className="ac-form-param-row">
            <input className="ac-form-input ac-form-sm" value={p.name} onChange={(e) => updateParam(i, { name: e.target.value })} placeholder="name" />
            <input className="ac-form-input ac-form-sm" value={p.type} onChange={(e) => updateParam(i, { type: e.target.value })} placeholder="type" />
            <label className="ac-form-check">
              <input type="checkbox" checked={p.req} onChange={(e) => updateParam(i, { req: e.target.checked })} />
              必填
            </label>
            <input className="ac-form-input ac-form-sm" style={{ flex: 2 }} value={p.desc} onChange={(e) => updateParam(i, { desc: e.target.value })} placeholder="描述" />
            <button className="ac-form-rm" onClick={() => removeParam(i)}>×</button>
          </div>
        ))}
        <button className="ac-form-add" onClick={addParam}>+ 添加参数</button>

        <div className="ac-modal-actions">
          <button className="ac-btn-cancel" onClick={onClose}>取消</button>
          <button className="ac-btn-confirm" onClick={handleSubmit}>注册</button>
        </div>
      </div>
    </div>
  );
}
