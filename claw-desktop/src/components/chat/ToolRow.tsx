import { useState } from "react";
import type { ToolCallRecord } from "../../types/workflow";
import {
  toolDisplay,
  type PreviewBody,
  type SearchHit,
} from "../../lib/tool-display";

// Per-row tool rendering — matches docs/demos/ui-anim-coordinator.html.
// Row layout:  [verb] [arg] → [result] ›
// Clicking expands a .tool-preview card showing the call signature and
// body (search hits / memory file / raw JSON / error).
//
// Shared between CoordThinkingBlock and ToolGroupBlock so the simple_tool
// flow and the coordinator flow show the same expandable detail.
export default function ToolRow({ tc }: { tc: ToolCallRecord }) {
  const [expanded, setExpanded] = useState(false);
  const disp = toolDisplay(tc);
  const running =
    tc.result === undefined && !disp.result && !tc.brief?.startsWith("error");
  const errored = tc.brief?.startsWith("error");
  const verb = running ? disp.verbRunning : disp.verbDone;
  const canExpand = !running;

  return (
    <div className="tool-line-wrap">
      <div
        className={`tool-line expandable ${running ? "running" : "done"} ${expanded ? "open" : ""} ${errored ? "errored" : ""}`}
        onClick={() => canExpand && setExpanded((e) => !e)}
      >
        <span className="tn">{verb}</span>
        {disp.arg && <span className="tv">{disp.arg}</span>}
        {disp.result && <span className="tr">{disp.result}</span>}
      </div>
      {expanded && canExpand && (
        <div className="tool-preview open">
          <PreviewCard body={disp.preview} />
        </div>
      )}
    </div>
  );
}

// Render the preview card body. Path strip at top; body varies by kind.
export function PreviewCard({ body }: { body: PreviewBody }) {
  if (body.type === "search-hits") {
    return (
      <>
        <span className="path">{body.signature}</span>
        <div className="code">
          {body.hits.length === 0 ? (
            <div className="ln dim">(no hits)</div>
          ) : (
            body.hits.map((h, i) => <SearchHitRow key={i} idx={i + 1} hit={h} />)
          )}
        </div>
      </>
    );
  }

  if (body.type === "memory-file") {
    const lines = body.content.split("\n");
    return (
      <>
        <span className="path">{body.signature}</span>
        <div className="code">
          {lines.map((ln, i) => (
            <div key={i} className="ln">{ln || "\u00A0"}</div>
          ))}
        </div>
      </>
    );
  }

  if (body.type === "error") {
    return (
      <>
        <span className="path">{body.signature}</span>
        <div className="code json-raw">
          <div className="ln errored">error: {body.message}</div>
        </div>
      </>
    );
  }

  // call-json
  return (
    <div className="json-wrap">
      <span className="path">{body.signature}</span>
      <pre className="code json-raw">{body.resultJson}</pre>
    </div>
  );
}

function SearchHitRow({ idx, hit }: { idx: number; hit: SearchHit }) {
  return (
    <>
      <div className="ln">
        <span className="h2">match {idx}</span>{"  "}
        <span className="k">{hit.path}</span>
        {hit.score != null && <span className="dim">  score {hit.score.toFixed(2)}</span>}
      </div>
      {hit.snippet && <div className="ln dim">        "{hit.snippet}"</div>}
    </>
  );
}
