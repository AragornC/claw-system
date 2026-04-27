// Detail view for a single feature. Shown in the Workspace area when a
// feature is selected in the sidebar. Hides the .py path / file system
// layout from non-technical users while still letting power users open
// the folder via the "代码" section.

import { useMemo, useState } from "react";
import { useFeatureStore } from "../store/featureStore";
import "./FeatureDetail.css";

export default function FeatureDetail({ slug }: { slug: string }) {
  const features = useFeatureStore((s) => s.features);
  const lastRun = useFeatureStore((s) => s.lastRun[slug]);
  const run = useFeatureStore((s) => s.run);
  const remove = useFeatureStore((s) => s.remove);
  const upsert = useFeatureStore((s) => s.upsert);
  const openFolder = useFeatureStore((s) => s.openFolder);

  const feature = useMemo(
    () => features.find((f) => f.slug === slug),
    [features, slug]
  );

  const [running, setRunning] = useState(false);
  const [showCode, setShowCode] = useState(false);

  if (!feature) {
    return <div className="fd-empty">特征已删除或不存在</div>;
  }

  const handleRun = async () => {
    setRunning(true);
    try {
      await run(slug);
    } finally {
      setRunning(false);
    }
  };

  const toggleEnabled = async () => {
    const nextStatus = feature.status === "enabled" ? "disabled" : "enabled";
    await upsert({ ...feature, status: nextStatus });
  };

  const handleDelete = async () => {
    if (!confirm(`确定删除特征「${feature.display_name}」？此操作不可撤销。`)) return;
    await remove(slug);
  };

  const dotClass = feature.last_error
    ? "err"
    : feature.last_run_at
      ? "ok"
      : "idle";

  return (
    <div className="fd">
      {/* Hero */}
      <div className="fd-hero">
        <div className="fd-hero-top">
          <span className={`fd-status-dot fd-${dotClass}`} />
          <h1 className="fd-name">{feature.display_name}</h1>
          {feature.category && (
            <span className="fd-cat">{feature.category}</span>
          )}
          {feature.created_by === "llm" && (
            <span className="fd-badge fd-badge-llm">Agent 生成</span>
          )}
        </div>
        <div className="fd-slug stg-mono">{feature.slug}</div>
        {feature.description && (
          <p className="fd-desc">{feature.description}</p>
        )}
      </div>

      {/* Actions */}
      <div className="fd-actions">
        <button
          className="fd-btn fd-btn-primary"
          onClick={handleRun}
          disabled={running}
        >
          {/* Keep the prefix glyph in both states so the button width is
              stable — the swapping label was the visible "flicker". */}
          {running ? "▶ 运行中…" : "▶ 立即运行"}
        </button>
        <button className="fd-btn" onClick={toggleEnabled}>
          {feature.status === "enabled" ? "暂停" : "启用"}
        </button>
        <button className="fd-btn" onClick={() => openFolder()}>
          在 Finder 中显示
        </button>
        <button className="fd-btn fd-btn-danger" onClick={handleDelete}>
          删除
        </button>
      </div>

      {/* Run result */}
      <Section title="最近运行">
        {!lastRun && !feature.last_run_at && (
          <div className="fd-muted">尚未运行 — 点上方「立即运行」试试</div>
        )}
        {(lastRun || feature.last_run_at) && (
          <div className="fd-run">
            <div className="fd-run-meta">
              <span className={`fd-tag ${lastRun?.ok === false || feature.last_error ? "fd-tag-err" : "fd-tag-ok"}`}>
                {lastRun?.ok === false || feature.last_error ? "失败" : "成功"}
              </span>
              {lastRun?.durationMs != null && (
                <span className="fd-muted">{lastRun.durationMs} ms</span>
              )}
              {feature.last_run_at && (
                <span className="fd-muted">
                  {fmtTime(feature.last_run_at)}
                </span>
              )}
            </div>
            {(lastRun?.error || feature.last_error) && (
              <pre className="fd-error">
                {lastRun?.error || feature.last_error}
              </pre>
            )}
            {lastRun?.ok && lastRun.value != null && (
              <pre className="fd-output">
                {JSON.stringify(lastRun.value, null, 2)}
              </pre>
            )}
            {!lastRun && feature.last_brief && !feature.last_error && (
              <div className="fd-muted">{feature.last_brief}</div>
            )}
          </div>
        )}
      </Section>

      {/* Code (collapsible — power users only) */}
      <Section title="代码">
        <div className="fd-code-bar">
          <button
            className="fd-link"
            onClick={() => setShowCode((v) => !v)}
          >
            {showCode ? "▾ 收起" : "▸ 展开 (.py 源码)"}
          </button>
          <span className="fd-muted fd-mono">{feature.slug}.py</span>
        </div>
        {showCode && <pre className="fd-code">{feature.code}</pre>}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="fd-section">
      <div className="fd-section-title">{title}</div>
      <div className="fd-section-body">{children}</div>
    </div>
  );
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
