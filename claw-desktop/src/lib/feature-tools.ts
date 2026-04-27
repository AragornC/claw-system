// Frontend-only LLM tools for the feature library.
//
// Why these aren't in Rust: `create_feature` must dry-run user-supplied
// Python through Pyodide before persisting (catch syntax errors / undefined
// names / missing `compute`), and Pyodide lives in a frontend WebWorker.
// `lib/tools.ts::execTool` intercepts these names and routes here.

import { exec as pyExec } from "./python/runtime";
import {
  listFeatures,
  writeFeature,
  deleteFeature,
  runFeature,
  type FeatureRecord,
} from "./features";
import { useFeatureStore } from "../store/featureStore";

export const FEATURE_TOOL_NAMES = [
  "create_feature",
  "list_features",
  "run_feature",
  "delete_feature",
] as const;

export type FeatureToolName = (typeof FEATURE_TOOL_NAMES)[number];

export async function handleFeatureTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case "create_feature":
      return createFeature(args);
    case "list_features":
      return doList();
    case "run_feature":
      return doRun(args);
    case "delete_feature":
      return doDelete(args);
    default:
      return { error: `unknown feature tool: ${name}` };
  }
}

/* ─── create ─── */

async function createFeature(args: Record<string, unknown>): Promise<unknown> {
  const slug = String(args.slug ?? "").trim();
  const code = String(args.code ?? "");
  const display_name = String(args.display_name ?? slug);
  const description = String(args.description ?? "");
  const category = String(args.category ?? "");

  if (!slug) return { error: "create_feature: slug 是必需的" };
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(slug)) {
    return {
      error: `create_feature: slug "${slug}" 必须是小写字母开头，只含 [a-z0-9_]，长度 ≤64`,
    };
  }
  if (!code.includes("def compute") && !code.includes("async def compute")) {
    return {
      error:
        "create_feature: code 必须定义 compute(...) 函数（建议 async def compute）",
    };
  }

  // Dry-run: load the code into Pyodide and confirm `compute` is callable.
  // We DO NOT actually invoke compute() — that may hit the network or
  // depend on user-provided args; just statically resolve the symbol.
  const dryrun = `
import inspect, traceback
_ns = {}
try:
    exec(_USER_CODE, _ns)
    _fn = _ns.get("compute")
    if _fn is None:
        _OUT = {"ok": False, "err": "compute() 未定义"}
    elif not callable(_fn):
        _OUT = {"ok": False, "err": "compute 不是可调用对象"}
    else:
        sig = inspect.signature(_fn)
        params = []
        for n, p in sig.parameters.items():
            params.append({
                "name": n,
                "default": None if p.default is inspect.Parameter.empty else repr(p.default),
                "required": p.default is inspect.Parameter.empty,
            })
        _OUT = {"ok": True, "params": params, "is_async": inspect.iscoroutinefunction(_fn)}
except SyntaxError as e:
    _OUT = {"ok": False, "err": f"SyntaxError: {e}"}
except Exception:
    _OUT = {"ok": False, "err": traceback.format_exc()}
_OUT
`;

  let validation: { ok: boolean; err?: string; params?: unknown[]; is_async?: boolean };
  try {
    validation = (await pyExec(dryrun, { _USER_CODE: code })) as typeof validation;
  } catch (e) {
    return {
      error: `create_feature: dry-run 失败 — ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!validation.ok) {
    return { error: `create_feature: 校验失败 — ${validation.err}` };
  }

  // Check for slug collision; refuse to overwrite via this tool. (LLM
  // should pick a fresh slug; user can edit existing features in the UI.)
  const existing = await listFeatures();
  if (existing.some((f) => f.slug === slug)) {
    return {
      error: `create_feature: slug "${slug}" 已存在 — 选个不同的名字，或在 UI 里编辑现有特征`,
    };
  }

  const record: FeatureRecord = {
    slug,
    display_name: display_name || slug,
    description,
    category,
    created_by: "llm",
    status: "draft",
    created_at: 0, // Rust will stamp
    code,
  };

  try {
    await writeFeature(record);
    // Refresh the sidebar / detail views so the user sees the new card.
    await useFeatureStore.getState().refresh();
    return {
      ok: true,
      slug,
      params: validation.params,
      is_async: validation.is_async,
      message: `特征 "${slug}" 已创建（草稿状态）。在侧栏点开可立即试运行。`,
    };
  } catch (e) {
    return {
      error: `create_feature: 写入失败 — ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/* ─── list ─── */

async function doList(): Promise<unknown> {
  const features = await listFeatures();
  return {
    count: features.length,
    features: features.map((f) => ({
      slug: f.slug,
      display_name: f.display_name,
      category: f.category,
      description: f.description,
      status: f.status,
      created_by: f.created_by,
      last_run_at: f.last_run_at ?? null,
      last_brief: f.last_brief ?? null,
      last_error: f.last_error ?? null,
    })),
  };
}

/* ─── run ─── */

async function doRun(args: Record<string, unknown>): Promise<unknown> {
  const slug = String(args.slug ?? "").trim();
  if (!slug) return { error: "run_feature: 缺少 slug" };
  const featureArgs =
    (args.args && typeof args.args === "object" && !Array.isArray(args.args)
      ? (args.args as Record<string, unknown>)
      : {});
  // Use the store's run() so lastRun + sidebar both update.
  const result = await useFeatureStore.getState().run(slug, featureArgs);
  if (!result.ok) {
    return { ok: false, slug, error: result.error, duration_ms: result.durationMs };
  }
  return {
    ok: true,
    slug,
    value: result.value,
    duration_ms: result.durationMs,
  };
}

/* ─── delete ─── */

async function doDelete(args: Record<string, unknown>): Promise<unknown> {
  const slug = String(args.slug ?? "").trim();
  if (!slug) return { error: "delete_feature: 缺少 slug" };
  try {
    await useFeatureStore.getState().remove(slug);
    return { ok: true, slug };
  } catch (e) {
    return {
      error: `delete_feature: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
