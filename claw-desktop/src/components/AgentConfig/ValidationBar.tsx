import type { ValidationIssue } from "../../types/agent";

export interface ValidState {
  issues: ValidationIssue[];
  saved: boolean;
}

interface Props {
  validState: ValidState | null;
}

export default function ValidationBar({ validState }: Props) {
  if (!validState) return null;
  const { issues, saved } = validState;

  if (issues.length === 0 && saved) {
    return (
      <div className="ac-valid-bar ac-valid-ok">
        <span className="ac-valid-icon">✓</span>
        <span className="ac-valid-msg">已保存</span>
      </div>
    );
  }

  if (issues.length === 0) return null;

  const hasErr = issues.some((i) => i.type === "err");
  const cls = hasErr ? "ac-valid-err" : "ac-valid-warn";
  const icon = hasErr ? "✗" : "!";
  const prefix = hasErr && saved ? "保存失败 — " : "";

  return (
    <div className={`ac-valid-bar ${cls}`}>
      <span className="ac-valid-icon">{icon}</span>
      <span className="ac-valid-msg">{prefix}</span>
      <div className="ac-valid-items">
        {issues.map((i, idx) => (
          <span
            key={idx}
            className={`ac-valid-item ${i.type === "err" ? "ac-vi-fail" : "ac-vi-warn"}`}
          >
            {i.msg}
          </span>
        ))}
      </div>
    </div>
  );
}
