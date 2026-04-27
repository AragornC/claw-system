import { useState } from "react";
import { useAgentStore } from "../../store/agentStore";
import type { ToolFunction, PermLevel } from "../../types/agent";
import { getToolStatus, STATUS_META } from "../../lib/toolStatus";

export default function FunctionDetail({ fn }: { fn: ToolFunction }) {
  const [tab, setTab] = useState<"detail" | "schema">("detail");
  const agents = useAgentStore((s) => s.agents);
  const changePerm = useAgentStore((s) => s.changeFunctionPerm);
  const setView = useAgentStore((s) => s.setActiveView);

  const linkedAgents = agents.filter((a) => fn.agents.includes(a.id));
  const status = getToolStatus(fn.id);
  const statusMeta = STATUS_META[status];

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
    <div className="ac-detail ac-fn-detail">
      <div className="ac-fn-tabs">
        <div className="ac-slide-toggle">
          <button
            className={`ac-slide-opt ${tab === "detail" ? "active" : ""}`}
            onClick={() => setTab("detail")}
          >
            详情
          </button>
          <button
            className={`ac-slide-opt ${tab === "schema" ? "active" : ""}`}
            onClick={() => setTab("schema")}
          >
            Schema
          </button>
        </div>
      </div>

      {tab === "schema" ? (
        <pre className="ac-code-block">{JSON.stringify(schema, null, 2)}</pre>
      ) : (
        <div className="ac-fn-body">
          {/* Hero: name + category pill + description */}
          <div className="ac-fn-hero">
            <div className="ac-fn-hero-top">
              <span className="ac-fn-name">{fn.id}</span>
              <span className="ac-fn-cat">{fn.cat}</span>
            </div>
            {fn.desc && <p className="ac-fn-desc">{fn.desc}</p>}
          </div>

          {/* Meta rows — all two-column (label | content) */}
          <dl className="ac-fn-meta">
            <div className="ac-fn-row">
              <dt>实现状态</dt>
              <dd>
                <span
                  className={`ac-fn-status-badge ac-fn-status-badge-${statusMeta.tone}`}
                >
                  {statusMeta.label}
                </span>
                <span className="ac-fn-status-desc">{statusMeta.desc}</span>
              </dd>
            </div>

            <div className="ac-fn-row">
              <dt>权限</dt>
              <dd>
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
              </dd>
            </div>

            <div className="ac-fn-row ac-fn-row-block">
              <dt>参数</dt>
              <dd>
                {fn.params.length === 0 ? (
                  <div className="ac-fn-no-params">无参数</div>
                ) : (
                  <table className="ac-params-table">
                    <thead>
                      <tr>
                        <th>名称</th>
                        <th>类型</th>
                        <th>必填</th>
                        <th>描述</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fn.params.map((p) => (
                        <tr key={p.name}>
                          <td className="ac-param-name">{p.name}</td>
                          <td className="ac-param-type">{p.type}</td>
                          <td>
                            {p.req ? (
                              <span className="ac-param-req">必填</span>
                            ) : (
                              <span className="ac-param-opt">可选</span>
                            )}
                          </td>
                          <td className="ac-param-desc">{p.desc}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </dd>
            </div>

            <div className="ac-fn-row ac-fn-row-block">
              <dt>绑定 Agents</dt>
              <dd>
                <div className="ac-fn-agents">
                  {linkedAgents.length === 0 ? (
                    <span className="ac-fn-no-params">
                      系统级保留，未绑定特定 Agent
                    </span>
                  ) : (
                    linkedAgents.map((a) => (
                      <span
                        key={a.id}
                        className="ac-fn-agent-tag"
                        onClick={() =>
                          setView({ type: "agent", id: a.id })
                        }
                      >
                        {a.name}
                      </span>
                    ))
                  )}
                </div>
              </dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
