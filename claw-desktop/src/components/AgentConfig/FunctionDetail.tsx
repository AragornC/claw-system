import { useState } from "react";
import { useAgentStore } from "../../store/agentStore";
import type { ToolFunction, PermLevel } from "../../types/agent";

export default function FunctionDetail({ fn }: { fn: ToolFunction }) {
  const [tab, setTab] = useState<"detail" | "schema">("detail");
  const agents = useAgentStore((s) => s.agents);
  const changePerm = useAgentStore((s) => s.changeFunctionPerm);
  const setView = useAgentStore((s) => s.setActiveView);

  const linkedAgents = agents.filter((a) => fn.agents.includes(a.id));

  const schema = {
    name: fn.id,
    description: fn.desc,
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        fn.params.map((p) => [p.name, { type: p.type, description: p.desc }])
      ),
      required: fn.params.filter((p) => p.req).map((p) => p.name),
    },
  };

  return (
    <div className="ac-detail">
      <div className="ac-skill-header">
        <div className="ac-slide-toggle">
          <button className={`ac-slide-opt ${tab === "detail" ? "active" : ""}`} onClick={() => setTab("detail")}>详情</button>
          <button className={`ac-slide-opt ${tab === "schema" ? "active" : ""}`} onClick={() => setTab("schema")}>Schema</button>
        </div>
      </div>

      {tab === "schema" ? (
        <pre className="ac-code-block">{JSON.stringify(schema, null, 2)}</pre>
      ) : (
        <>
          <div className="ac-fn-header">
            <span className="ac-fn-name">{fn.id}</span>
            <span className="ac-fn-desc">{fn.desc}</span>
            <span className="ac-fn-cat">{fn.cat}</span>
          </div>

          <div className="ac-sep" />

          <div className="ac-fn-perm-section">
            <span className="ac-sv-label">权限</span>
            <div className="ac-perm-opts">
              {(["auto", "ask", "deny"] as PermLevel[]).map((p) => (
                <button
                  key={p}
                  className={`ac-perm-opt ${fn.perm === p ? `ac-perm-sel-${p}` : ""}`}
                  onClick={() => changePerm(fn.id, p)}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div className="ac-sep" />

          <div className="ac-sv-label">参数</div>
          {fn.params.length === 0 ? (
            <div className="ac-fn-no-params">无参数</div>
          ) : (
            <table className="ac-params-table">
              <thead>
                <tr>
                  <th>名称</th><th>类型</th><th>必填</th><th>描述</th>
                </tr>
              </thead>
              <tbody>
                {fn.params.map((p) => (
                  <tr key={p.name}>
                    <td className="ac-param-name">{p.name}</td>
                    <td className="ac-param-type">{p.type}</td>
                    <td>{p.req ? <span className="ac-param-req">必填</span> : <span className="ac-param-opt">可选</span>}</td>
                    <td className="ac-param-desc">{p.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="ac-sep" />

          <div className="ac-sv-label">绑定的 Agents</div>
          <div className="ac-fn-agents">
            {linkedAgents.length === 0 ? (
              <span className="ac-fn-no-params">系统级保留，未绑定特定 Agent</span>
            ) : (
              linkedAgents.map((a) => (
                <span key={a.id} className="ac-fn-agent-tag" onClick={() => setView({ type: "agent", id: a.id })}>
                  {a.name}
                </span>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
