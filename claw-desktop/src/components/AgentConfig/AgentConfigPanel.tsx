import { useAgentStore } from "../../store/agentStore";
import AgentDetail from "./AgentDetail";
import SkillEditor from "./SkillEditor";
import FunctionDetail from "./FunctionDetail";
import "./AgentConfig.css";

export default function AgentConfigPanel() {
  const activeView = useAgentStore((s) => s.activeView);
  const agents = useAgentStore((s) => s.agents);
  const skills = useAgentStore((s) => s.skills);
  const functions = useAgentStore((s) => s.functions);

  if (!activeView) {
    return (
      <div className="ac-empty">
        <div className="ac-empty-icon">
          <svg width={40} height={40} viewBox="0 0 40 40" fill="none" opacity={0.3}>
            <circle cx={14} cy={16} r={5} stroke="currentColor" strokeWidth={1.5}/>
            <circle cx={26} cy={16} r={5} stroke="currentColor" strokeWidth={1.5}/>
            <path d="M4 36c0-5.5 4.5-10 10-10" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"/>
            <path d="M36 36c0-5.5-4.5-10-10-10" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"/>
          </svg>
        </div>
        <div className="ac-empty-text">选择 Agent、Skill 或 Function 查看详情</div>
      </div>
    );
  }

  if (activeView.type === "agent") {
    const agent = agents.find((a) => a.id === activeView.id);
    if (!agent) return null;
    return <AgentDetail agent={agent} />;
  }

  if (activeView.type === "skill") {
    const skill = skills.find((s) => s.id === activeView.id);
    if (!skill) return null;
    return <SkillEditor key={skill.id} skill={skill} />;
  }

  if (activeView.type === "fn") {
    const fn = functions.find((f) => f.id === activeView.id);
    if (!fn) return null;
    return <FunctionDetail fn={fn} />;
  }

  return null;
}
