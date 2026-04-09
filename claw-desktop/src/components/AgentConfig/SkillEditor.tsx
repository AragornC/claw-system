import { useState, useRef, useCallback } from "react";
import { useAgentStore } from "../../store/agentStore";
import { buildSkillMd, parseMd, validateSkill, applyParsed } from "../../lib/skillMd";
import ValidationBar, { type ValidState } from "./ValidationBar";
import type { Skill } from "../../types/agent";

type ViewMode = "visual" | "md";

export default function SkillEditor({ skill: initSkill }: { skill: Skill }) {
  const functions = useAgentStore((s) => s.functions);
  const updateSkill = useAgentStore((s) => s.updateSkill);
  const setView = useAgentStore((s) => s.setActiveView);
  const agents = useAgentStore((s) => s.agents);
  const knownFnIds = functions.map((f) => f.id);

  const [mode, setMode] = useState<ViewMode>("visual");
  const [validState, setValidState] = useState<ValidState | null>(null);
  const mdDirty = useRef(false);
  const mdRef = useRef<HTMLTextAreaElement>(null);

  const skill = useAgentStore((s) => s.skills.find((sk) => sk.id === initSkill.id))!;
  const ownerAgent = agents.find((a) => a.id === skill.agent);

  const handleSwitch = useCallback((target: ViewMode) => {
    if (mode === "md" && target === "visual") {
      const ta = mdRef.current;
      if (ta && mdDirty.current) {
        const parsed = parseMd(ta.value);
        const tempSkill = { ...skill, ...parsed } as Skill;
        const issues = validateSkill(tempSkill, knownFnIds);
        parsed._dropped.forEach((d) =>
          issues.push({ type: "warn", msg: `[${d.section}] 格式不符已忽略: "${d.line}"` })
        );
        if (issues.some((i) => i.type === "err")) {
          setValidState({ issues, saved: false });
          return;
        }
        applyParsed(skill, parsed);
        updateSkill(skill.id, { ...skill });
        mdDirty.current = false;
        setValidState(issues.length > 0 ? { issues, saved: false } : null);
      } else {
        setValidState(null);
      }
    }
    setMode(target);
  }, [mode, skill, knownFnIds, updateSkill]);

  const handleSave = useCallback(() => {
    if (mode === "md") {
      const ta = mdRef.current;
      const mdText = ta?.value;
      if (!mdText) return;
      const parsed = parseMd(mdText);
      const tempSkill = { ...skill, ...parsed } as Skill;
      const issues = validateSkill(tempSkill, knownFnIds);
      parsed._dropped.forEach((d) =>
        issues.push({ type: "warn", msg: `[${d.section}] 格式不符已忽略: "${d.line}"` })
      );
      if (issues.some((i) => i.type === "err")) {
        setValidState({ issues, saved: true });
        return;
      }
      applyParsed(skill, parsed);
      updateSkill(skill.id, { ...skill });
      mdDirty.current = false;
      if (ta) ta.value = buildSkillMd(skill, functions);
      setValidState({ issues, saved: true });
    } else {
      const issues = validateSkill(skill, knownFnIds);
      if (issues.some((i) => i.type === "err")) {
        setValidState({ issues, saved: true });
        return;
      }
      setValidState({ issues, saved: true });
    }
  }, [mode, skill, knownFnIds, updateSkill, functions]);

  return (
    <div className="ac-detail">
      <div className="ac-skill-header">
        <div className="ac-slide-toggle">
          <button className={`ac-slide-opt ${mode === "visual" ? "active" : ""}`} onClick={() => handleSwitch("visual")}>可视化</button>
          <button className={`ac-slide-opt ${mode === "md" ? "active" : ""}`} onClick={() => handleSwitch("md")}>SKILL.md</button>
        </div>
        <div style={{ flex: 1 }} />
        <button className="ac-save-btn" onClick={handleSave}>保存更改</button>
      </div>

      <ValidationBar validState={validState} />

      <div className="ac-skill-title-row">
        <span className="ac-skill-id">{skill.id}</span>
        {ownerAgent && (
          <span className="ac-owner-badge" onClick={() => setView({ type: "agent", id: ownerAgent.id })}>
            {ownerAgent.name}
          </span>
        )}
      </div>

      {mode === "visual" ? (
        <VisualView skill={skill} functions={functions} knownFnIds={knownFnIds} setView={setView} updateSkill={updateSkill} />
      ) : (
        <MdView skill={skill} functions={functions} mdRef={mdRef} mdDirty={mdDirty} setValidState={setValidState} />
      )}
    </div>
  );
}

/* ── Visual sub-view ── */
function VisualView({
  skill, functions, knownFnIds, setView, updateSkill,
}: {
  skill: Skill;
  functions: ReturnType<typeof useAgentStore.getState>["functions"];
  knownFnIds: string[];
  setView: ReturnType<typeof useAgentStore.getState>["setActiveView"];
  updateSkill: ReturnType<typeof useAgentStore.getState>["updateSkill"];
}) {
  return (
    <div className="ac-sv-body">
      <div className="ac-sv-section">
        <div className="ac-sv-label">描述</div>
        <input
          className="ac-sv-input"
          defaultValue={skill.desc}
          spellCheck={false}
          onBlur={(e) => updateSkill(skill.id, { desc: e.target.value })}
        />
      </div>

      <div className="ac-sv-section">
        <div className="ac-sv-label">Tools</div>
        <div className="ac-sv-tools">
          {skill.fns.map((fid) => {
            const fn = functions.find((f) => f.id === fid);
            const missing = !knownFnIds.includes(fid);
            return (
              <div key={fid} className={`ac-sv-tool-row ${missing ? "ac-tool-missing" : ""}`}>
                <span
                  className={`ac-sv-tool-name ${missing ? "ac-tool-missing-text" : ""}`}
                  onClick={() => !missing && setView({ type: "fn", id: fid })}
                >
                  {fid}
                </span>
                <span className="ac-sv-tool-desc">{fn ? fn.desc : "⚠ 未注册"}</span>
                {fn && <span className={`ac-sv-perm ac-perm-${fn.perm}`}>{fn.perm}</span>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="ac-sv-section">
        <div className="ac-sv-label">指引</div>
        <textarea
          className="ac-skill-editor"
          defaultValue={skill.guide}
          spellCheck={false}
          onBlur={(e) => updateSkill(skill.id, { guide: e.target.value })}
        />
      </div>

      <div className="ac-sv-section">
        <div className="ac-sv-label">Constraints</div>
        {skill.constraints.map((c, i) => (
          <div key={i} className="ac-sv-list-item">
            <span className="ac-sv-bullet" style={{ color: "var(--red)" }}>•</span>
            <input
              className="ac-sv-list-input"
              defaultValue={c}
              spellCheck={false}
              onBlur={(e) => {
                const next = [...skill.constraints];
                next[i] = e.target.value;
                updateSkill(skill.id, { constraints: next.filter((v) => v.trim()) });
              }}
            />
          </div>
        ))}
      </div>

      <div className="ac-sv-section">
        <div className="ac-sv-label">Evaluator</div>
        {skill.eval.map((ev, i) => (
          <div key={i} className="ac-sv-list-item">
            <span className="ac-sv-bullet" style={{ color: "var(--accent)" }}>✓</span>
            <input
              className="ac-sv-list-input"
              defaultValue={ev}
              spellCheck={false}
              onBlur={(e) => {
                const next = [...skill.eval];
                next[i] = e.target.value;
                updateSkill(skill.id, { eval: next.filter((v) => v.trim()) });
              }}
            />
          </div>
        ))}
      </div>

      {skill.custom && skill.custom.length > 0 && skill.custom.map((c, i) => (
        <div key={i} className="ac-sv-custom">
          <div className="ac-sv-custom-head">
            <span className="ac-sv-custom-prefix">##</span>
            <input
              className="ac-sv-custom-title"
              defaultValue={c.title}
              spellCheck={false}
              onBlur={(e) => {
                const next = [...(skill.custom ?? [])];
                next[i] = { ...next[i], title: e.target.value };
                updateSkill(skill.id, { custom: next });
              }}
            />
            <span className="ac-sv-custom-badge">自定义</span>
          </div>
          <textarea
            className="ac-skill-editor"
            style={{ minHeight: 60 }}
            defaultValue={c.content}
            spellCheck={false}
            onBlur={(e) => {
              const next = [...(skill.custom ?? [])];
              next[i] = { ...next[i], content: e.target.value };
              updateSkill(skill.id, { custom: next });
            }}
          />
        </div>
      ))}
    </div>
  );
}

/* ── Markdown sub-view ── */
function MdView({
  skill, functions, mdRef, mdDirty, setValidState,
}: {
  skill: Skill;
  functions: ReturnType<typeof useAgentStore.getState>["functions"];
  mdRef: React.RefObject<HTMLTextAreaElement | null>;
  mdDirty: React.MutableRefObject<boolean>;
  setValidState: (v: ValidState | null) => void;
}) {
  const mdContent = buildSkillMd(skill, functions);
  return (
    <div className="ac-sv-body">
      <div className="ac-md-bar">
        <span className="ac-md-label">SKILL.md</span>
        <span className="ac-md-hint">编辑后点「保存更改」或切回「可视化」自动同步</span>
      </div>
      <textarea
        ref={mdRef}
        className="ac-skill-editor ac-skill-editor-full"
        defaultValue={mdContent}
        spellCheck={false}
        onInput={() => { mdDirty.current = true; setValidState(null); }}
      />
    </div>
  );
}
