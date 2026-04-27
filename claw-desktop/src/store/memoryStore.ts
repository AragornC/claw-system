import { create } from "zustand";
import { persist } from "zustand/middleware";

// ── Memory namespaces ──────────────────────────────────────
export type MemoryNamespace = "shared" | "analyst" | "risk" | "coordinator";

export const NAMESPACE_META: Record<
  MemoryNamespace,
  { label: string; desc: string; color: string; colorBg: string }
> = {
  shared: {
    label: "共享",
    desc: "跨 Agent 共享的知识、市场快照、用户信息",
    color: "#5b8def",
    colorBg: "rgba(91,141,239,0.1)",
  },
  analyst: {
    label: "分析师",
    desc: "Analyst Agent 的发现和经验",
    color: "#e8a84a",
    colorBg: "rgba(232,168,74,0.1)",
  },
  risk: {
    label: "风控",
    desc: "Risk Agent 的评估记录",
    color: "#e05050",
    colorBg: "rgba(224,80,80,0.1)",
  },
  coordinator: {
    label: "协调器",
    desc: "Coordinator 的元知识和决策框架",
    color: "#3cc87a",
    colorBg: "rgba(60,200,122,0.1)",
  },
};

export const NAMESPACE_IDS: MemoryNamespace[] = [
  "shared",
  "analyst",
  "risk",
  "coordinator",
];

// ── Memory file record ─────────────────────────────────────
export interface MemoryFile {
  path: string; // e.g. "shared/user-profile.md"
  content: string;
  updatedAt: number;
}

interface MemoryState {
  // MEMORY.md — the index with one-line summaries per file
  index: string;
  // All memory files keyed by path
  files: Record<string, MemoryFile>;

  // Actions
  readMemory: (path: string) => string | null;
  writeMemory: (path: string, content: string) => void;
  deleteMemory: (path: string) => void;
  updateIndex: (content: string) => void;
  searchMemory: (query: string) => { path: string; matches: string[] }[];
  clearAll: () => void;

  // Helpers
  getNamespaceOf: (path: string) => MemoryNamespace | null;
  listByNamespace: (ns: MemoryNamespace) => MemoryFile[];
}

export const useMemoryStore = create<MemoryState>()(
  persist(
    (set, get) => ({
      index: "",
      files: {},

      readMemory(path) {
        return get().files[path]?.content ?? null;
      },

      writeMemory(path, content) {
        const file: MemoryFile = { path, content, updatedAt: Date.now() };
        set((s) => ({ files: { ...s.files, [path]: file } }));
      },

      deleteMemory(path) {
        set((s) => {
          const next = { ...s.files };
          delete next[path];
          return { files: next };
        });
      },

      updateIndex(content) {
        set({ index: content });
      },

      searchMemory(query) {
        const q = query.toLowerCase();
        const results: { path: string; matches: string[] }[] = [];
        for (const [path, file] of Object.entries(get().files)) {
          if (file.content.toLowerCase().includes(q)) {
            const matches = file.content
              .split("\n")
              .filter((l) => l.toLowerCase().includes(q))
              .slice(0, 3);
            results.push({ path, matches });
          }
        }
        return results;
      },

      clearAll() {
        set({ index: "", files: {} });
      },

      getNamespaceOf(path) {
        const ns = path.split("/")[0];
        return (NAMESPACE_IDS as string[]).includes(ns)
          ? (ns as MemoryNamespace)
          : null;
      },

      listByNamespace(ns) {
        return Object.values(get().files)
          .filter((f) => f.path.startsWith(ns + "/"))
          .sort((a, b) => a.path.localeCompare(b.path));
      },
    }),
    {
      name: "thunderclaw-memory",
      version: 2,
      // v1 had seed/mock data for UI preview. v2 starts empty so Agent
      // manages memory from scratch.
      migrate: (_persisted: unknown, version: number) => {
        if (version < 2) {
          return { index: "", files: {} } as Partial<MemoryState>;
        }
        return _persisted as Partial<MemoryState>;
      },
    }
  )
);
