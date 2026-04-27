import { useMemoryStore, type MemoryNamespace } from "../store/memoryStore";
import type { ToolDef } from "../types/workflow";

/**
 * Memory tool definitions — OpenAI function-calling format.
 *
 * Coordinator gets the full set. Agents only get read_memory + search_memory
 * (scoped to their namespace + shared/).
 */
export const MEM_TOOLS_FULL: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "read_memory",
      description:
        "读取一个记忆文件的完整内容。先看 MEMORY.md 索引的摘要决定要不要读。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "文件路径，如 shared/market-context.md",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_memory",
      description:
        "写入记忆文件（创建或覆盖）。路径必须以 namespace 开头：shared/ analyst/ risk/ coordinator/。内容要简洁，专注一个主题。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
          content: { type: "string", description: "文件内容（Markdown 格式）" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_index",
      description:
        "更新 MEMORY.md 目录索引。每行格式：- [文件名](路径) — 一句话摘要。摘要要具体（含关键数据和时间），便于下次判断是否需要加载。",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "MEMORY.md 的完整新内容（Markdown）",
          },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_memory",
      description: "在所有记忆文件中搜索关键词，返回匹配的行",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
        },
        required: ["query"],
      },
    },
  },
];

/** Agent-scoped tools: read + write (own namespace + shared) + search.
 *  Agents cannot update_index — that's the Coordinator's responsibility. */
export const MEM_TOOLS_AGENT: ToolDef[] = [
  MEM_TOOLS_FULL[0], // read_memory
  MEM_TOOLS_FULL[1], // write_memory  (scoped at exec time)
  MEM_TOOLS_FULL[3], // search_memory
];

/** Check if a tool name is a memory tool */
export function isMemoryTool(name: string): boolean {
  return ["read_memory", "write_memory", "update_index", "search_memory"].includes(
    name
  );
}

/**
 * Execute a memory tool call.
 *
 * @param name   tool name
 * @param args   parsed arguments
 * @param scope  null = Coordinator (full access), or a namespace = agent-scoped
 */
export function execMemoryTool(
  name: string,
  args: Record<string, unknown>,
  scope: MemoryNamespace | null
): unknown {
  const store = useMemoryStore.getState();

  switch (name) {
    case "read_memory": {
      const path = String(args.path ?? "");
      if (!path) return { error: "missing path" };
      if (scope && !path.startsWith(scope + "/") && !path.startsWith("shared/")) {
        return {
          path,
          error: `access denied: ${scope} agent cannot read ${path}`,
        };
      }
      const content = store.readMemory(path);
      return content !== null
        ? { path, content }
        : { path, error: "file not found" };
    }

    case "write_memory": {
      const path = String(args.path ?? "");
      const content = String(args.content ?? "");
      if (!path || !content) {
        return { error: "missing path or content" };
      }
      // Validate namespace
      const ns = path.split("/")[0];
      if (!["shared", "analyst", "risk", "coordinator"].includes(ns)) {
        return {
          error: `invalid namespace: ${ns}. Must start with shared/ analyst/ risk/ coordinator/`,
        };
      }
      // Agent-scoped write: can only write to own namespace or shared/
      if (scope && ns !== scope && ns !== "shared") {
        return {
          error: `access denied: ${scope} agent cannot write to ${ns}/`,
        };
      }
      store.writeMemory(path, content);
      return { path, status: "written", size: content.length };
    }

    case "update_index": {
      if (scope) {
        return { error: `access denied: only Coordinator can update index` };
      }
      const content = String(args.content ?? "");
      store.updateIndex(content);
      return { status: "index updated", size: content.length };
    }

    case "search_memory": {
      const query = String(args.query ?? "");
      if (!query) return { error: "missing query" };
      const allResults = store.searchMemory(query);
      // Apply scope filter
      const results = scope
        ? allResults.filter(
            (r) =>
              r.path.startsWith(scope + "/") || r.path.startsWith("shared/")
          )
        : allResults;
      // Also include MEMORY.md matches
      const indexMatches = store.index
        .split("\n")
        .filter((l) => l.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 3);
      if (indexMatches.length) {
        return {
          query,
          results: [
            { path: "MEMORY.md", matches: indexMatches },
            ...results,
          ],
        };
      }
      return { query, results };
    }

    default:
      return { error: `unknown memory tool: ${name}` };
  }
}

/**
 * One-line human-readable summary of a memory tool call (for UI display).
 */
export function memoryToolBrief(
  name: string,
  args: Record<string, unknown>,
  result: unknown
): string {
  const r = result as Record<string, unknown>;
  if (r?.error) return `error: ${r.error}`;

  switch (name) {
    case "read_memory":
      return String(args.path ?? "");
    case "write_memory": {
      const size = (args.content as string | undefined)?.length ?? 0;
      return `${args.path} (${size}c)`;
    }
    case "update_index":
      return `MEMORY.md (${(args.content as string | undefined)?.length ?? 0}c)`;
    case "search_memory": {
      const hits = (r.results as unknown[])?.length ?? 0;
      return `"${args.query}" → ${hits} hits`;
    }
    default:
      return "";
  }
}

/**
 * Extract memory summaries relevant to a given agent namespace.
 * Used by Coordinator to inject hints into agent prompts.
 */
export function getMemorySummariesFor(ns: MemoryNamespace): string {
  const { index } = useMemoryStore.getState();
  if (!index) return "";
  const lines = index.split("\n");
  const relevant = lines.filter((l) => {
    const lower = l.toLowerCase();
    return (
      l.startsWith("#") ||
      lower.includes("shared/") ||
      lower.includes(ns + "/")
    );
  });
  return relevant.length ? relevant.join("\n") : "";
}
