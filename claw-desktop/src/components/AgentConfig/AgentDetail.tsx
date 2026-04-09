import { useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../types/agent";

const AGENT_COLORS: Record<string, string> = {
  analyst: "var(--info)",
  quant: "#a78bfa",
  risk: "var(--red)",
  sentinel: "#22d3ee",
  coordinator: "var(--accent)",
};

function formatPrompt(text: string): string {
  return text
    .replace(/^## (.+)$/gm, '<span class="ac-h2">## $1</span>')
    .replace(/「([^」]+)」/g, '<span class="ac-hl">「$1」</span>');
}

export default function AgentDetail({ agent }: { agent: Agent }) {
  const skills = useAgentStore((s) => s.skills.filter((sk) => sk.agent === agent.id));
  const functions = useAgentStore((s) => s.functions);
  const setView = useAgentStore((s) => s.setActiveView);
  const toggleActive = useAgentStore((s) => s.toggleAgentActive);
  const color = AGENT_COLORS[agent.id] ?? "var(--text-primary)";

  return (
    <div className="ac-detail">
      <div className="ac-agent-head">
        <span className="ac-agent-name" style={{ color }}>{agent.name}</span>
        <span className="ac-agent-role">{agent.role}</span>
        <div style={{ flex: 1 }} />
        <span className="ac-status-text">{agent.active ? "运行中" : "已停用"}</span>
        <button
          className={`ac-toggle ${agent.active ? "on" : ""}`}
          onClick={() => toggleActive(agent.id)}
        >
          <span className="ac-toggle-dot" />
        </button>
      </div>

      <div className="ac-sep" />

      <div
        className="ac-prompt-area"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        dangerouslySetInnerHTML={{ __html: formatPrompt(agent.systemPrompt) }}
      />

      <div className="ac-memory-tag">
        <svg width={12} height={12} viewBox="0 0 12 12" fill="none">
          <rect x={2} y={1} width={8} height={10} rx={1} stroke="currentColor" strokeWidth={1.1}/>
          <line x1={4} y1={3.5} x2={8} y2={3.5} stroke="currentColor" strokeWidth={.8}/>
          <line x1={4} y1={5.5} x2={7} y2={5.5} stroke="currentColor" strokeWidth={.8}/>
          <line x1={4} y1={7.5} x2={6} y2={7.5} stroke="currentColor" strokeWidth={.8}/>
        </svg>
        <span>{agent.memory}</span>
      </div>

      <div className="ac-sep" />

      <h3 className="ac-section-title">Skills</h3>
      <div className="ac-skill-list">
        {skills.map((sk) => {
          const skFns = sk.fns.map((fid) => functions.find((f) => f.id === fid)).filter(Boolean);
          return (
            <div key={sk.id} className="ac-skill-card" onClick={() => setView({ type: "skill", id: sk.id })}>
              <div className="ac-skill-card-top">
                <span className="ac-skill-card-name">{sk.id}</span>
                <span className="ac-skill-card-desc">{sk.desc}</span>
              </div>
              <div className="ac-skill-card-fns">
                {skFns.map((fn) => fn && (
                  <span
                    key={fn.id}
                    className={`ac-fn-tag ac-perm-${fn.perm}`}
                    onClick={(e) => { e.stopPropagation(); setView({ type: "fn", id: fn.id }); }}
                  >
                    {fn.id}
                    <span className="ac-fn-tag-perm">{fn.perm}</span>
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
