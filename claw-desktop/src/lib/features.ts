// Frontend façade for the feature library.
//
// CRUD over the Rust feature_commands. The store layer (Phase 1c) will sit
// on top of this; right now it's the raw API plus a tiny `runFeature` that
// stitches the Pyodide runtime + Rust persist-run-result together.

import { invoke } from "@tauri-apps/api/core";
import { exec as pyExec } from "./python/runtime";

export interface FeatureMeta {
  slug: string;
  display_name: string;
  category: string;
  description: string;
  created_by: string;          // "user" | "llm"
  status: string;              // "draft" | "enabled" | "disabled"
  created_at: number;          // ms epoch
  last_run_at?: number | null;
  last_brief?: string | null;
  last_error?: string | null;
}

export interface FeatureRecord extends FeatureMeta {
  code: string;
}

export const listFeatures = (): Promise<FeatureRecord[]> =>
  invoke("list_features");

export const readFeature = (slug: string): Promise<FeatureRecord> =>
  invoke("read_feature", { slug });

export const writeFeature = (record: FeatureRecord): Promise<FeatureRecord> =>
  invoke("write_feature", { record });

export const deleteFeature = (slug: string): Promise<void> =>
  invoke("delete_feature", { slug });

export const featuresDirPath = (): Promise<string> =>
  invoke("features_dir_path");

const recordRun = (
  slug: string,
  brief: string | null,
  error: string | null
): Promise<void> =>
  invoke("record_feature_run", { slug, brief, error });

/** Result of running a feature once. */
export interface RunResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  durationMs: number;
}

/**
 * Loads the feature's code into Pyodide and invokes its `compute(**args)`.
 * Convention: every feature must define an async function `compute` whose
 * return value is JSON-serializable (numbers, strings, dicts, lists).
 *
 * The brief shown on the card comes from a top-level `BRIEF` string the
 * feature can optionally compute, or we synthesize one from the result.
 */
export async function runFeature(
  slug: string,
  args: Record<string, unknown> = {}
): Promise<RunResult> {
  const t0 = performance.now();
  let value: unknown = null;
  let error: string | null = null;

  // Build a small launcher: import the user's code as a fresh module-ish
  // namespace, find compute, await it with args, return the value. Using
  // exec(globals=...) so we don't pollute Pyodide's __main__ between runs.
  const launcher = `
import json as _json, asyncio as _aio, traceback as _tb
_ns = {}
try:
    exec(_USER_CODE, _ns)
    _fn = _ns.get("compute")
    if _fn is None:
        _RESULT = {"__err__": "feature 必须定义 compute(...) 函数"}
    else:
        _ARGS = _json.loads(_ARGS_JSON)
        _coro = _fn(**_ARGS) if _aio.iscoroutinefunction(_fn) else None
        _RESULT = await _coro if _coro is not None else _fn(**_ARGS)
except Exception as e:
    _RESULT = {"__err__": _tb.format_exc()}
_RESULT
`;

  try {
    const rec = await readFeature(slug);
    value = await pyExec(launcher, {
      _USER_CODE: rec.code,
      _ARGS_JSON: JSON.stringify(args),
    });
    if (value && typeof value === "object" && "__err__" in (value as object)) {
      error = String((value as { __err__: string }).__err__);
      value = null;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const brief = error
    ? null
    : summarizeResult(value);

  // Fire-and-forget the meta update so the UI can keep going.
  recordRun(slug, brief, error).catch(() => {});

  return {
    ok: error === null,
    value: value ?? undefined,
    error: error ?? undefined,
    durationMs: Math.round(performance.now() - t0),
  };
}

/** Best-effort one-line summary for the card view. */
function summarizeResult(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v.slice(0, 60);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // Common patterns: {value: x}, {z_score: x}, {signal: "buy"}
    for (const k of ["brief", "summary", "signal", "value", "z_score", "score"]) {
      if (k in o && (typeof o[k] === "number" || typeof o[k] === "string")) {
        return `${k}=${o[k]}`;
      }
    }
    const keys = Object.keys(o);
    if (keys.length <= 3) {
      return keys.map((k) => `${k}=${String(o[k]).slice(0, 20)}`).join(" · ");
    }
  }
  return null;
}
