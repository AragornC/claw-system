// Feature library store. Loads from disk via lib/features.ts and exposes
// in-memory state to the sidebar + detail view.
//
// Source of truth lives on disk (Rust feature_commands). This store is a
// cache that's invalidated by every mutation — after add/edit/delete/run
// we re-list to keep cards fresh (cheap; small N).

import { create } from "zustand";
import {
  listFeatures,
  writeFeature,
  deleteFeature,
  runFeature,
  featuresDirPath,
  type FeatureRecord,
  type RunResult,
} from "../lib/features";

interface FeatureStoreState {
  features: FeatureRecord[];
  loaded: boolean;
  /** Slugs of features open as tabs in the SubHeader, in display order. */
  openTabSlugs: string[];
  /** The slug currently displayed in Workspace; null = show default view. */
  activeTabSlug: string | null;
  lastRun: Record<string, RunResult>; // slug → most recent run

  refresh: () => Promise<void>;
  initFromBackend: () => Promise<void>;
  /** Open a feature as a tab and activate it. Idempotent. */
  openTab: (slug: string) => void;
  /** Close a tab; if it was active, fall back to the next/prev tab or null. */
  closeTab: (slug: string) => void;
  /** Activate an already-open tab. */
  setActiveTab: (slug: string | null) => void;
  upsert: (record: FeatureRecord) => Promise<void>;
  remove: (slug: string) => Promise<void>;
  run: (slug: string, args?: Record<string, unknown>) => Promise<RunResult>;
  openFolder: () => Promise<void>;
}

export const useFeatureStore = create<FeatureStoreState>((set, get) => ({
  features: [],
  loaded: false,
  openTabSlugs: [],
  activeTabSlug: null,
  lastRun: {},

  refresh: async () => {
    const features = await listFeatures();
    set({ features });
  },

  initFromBackend: async () => {
    try {
      const features = await listFeatures();
      // Seed a starter feature on a brand-new install so the user has
      // something runnable to look at immediately. After that, never
      // auto-create — let the user / LLM populate the library.
      if (features.length === 0) {
        await writeFeature({
          slug: "btc_funding_zscore",
          display_name: "BTC 资金费率 Z 分数",
          category: "情绪",
          description:
            "对 BTC 永续合约最近 24 个 funding 数据做 z-score。|z| > 2 通常代表多/空一边极度拥挤，反向风险升高。",
          created_by: "user",
          status: "draft",
          created_at: 0,
          code: SEED_CODE_FUNDING_Z,
        });
        const seeded = await listFeatures();
        set({ features: seeded, loaded: true });
      } else {
        set({ features, loaded: true });
      }
    } catch (e) {
      console.error("[featureStore] init failed:", e);
      set({ loaded: true });
    }
  },

  openTab: (slug) =>
    set((s) => ({
      openTabSlugs: s.openTabSlugs.includes(slug)
        ? s.openTabSlugs
        : [...s.openTabSlugs, slug],
      activeTabSlug: slug,
    })),

  closeTab: (slug) =>
    set((s) => {
      const idx = s.openTabSlugs.indexOf(slug);
      if (idx === -1) return s;
      const next = s.openTabSlugs.filter((x) => x !== slug);
      let active = s.activeTabSlug;
      if (active === slug) {
        // Activate neighbor (right then left) if any tabs remain.
        active = next[idx] ?? next[idx - 1] ?? null;
      }
      return { openTabSlugs: next, activeTabSlug: active };
    }),

  setActiveTab: (slug) => set({ activeTabSlug: slug }),

  upsert: async (record) => {
    await writeFeature(record);
    await get().refresh();
  },

  remove: async (slug) => {
    await deleteFeature(slug);
    set((s) => {
      // Drop from open tabs and pick a sane neighbor for activation.
      const idx = s.openTabSlugs.indexOf(slug);
      const nextTabs = s.openTabSlugs.filter((x) => x !== slug);
      const wasActive = s.activeTabSlug === slug;
      const nextActive = wasActive
        ? nextTabs[idx] ?? nextTabs[idx - 1] ?? null
        : s.activeTabSlug;
      return {
        openTabSlugs: nextTabs,
        activeTabSlug: nextActive,
        lastRun: Object.fromEntries(
          Object.entries(s.lastRun).filter(([k]) => k !== slug)
        ),
      };
    });
    await get().refresh();
  },

  run: async (slug, args = {}) => {
    const result = await runFeature(slug, args);
    set((s) => ({ lastRun: { ...s.lastRun, [slug]: result } }));
    // Pull fresh meta so last_run_at / last_brief / last_error update in
    // the sidebar without a manual refresh.
    await get().refresh();
    return result;
  },

  openFolder: async () => {
    const path = await featuresDirPath();
    // Prefer plugin-opener if available; fall back to a console hint.
    try {
      const { openPath } = await import("@tauri-apps/plugin-opener");
      await openPath(path);
    } catch {
      console.info("[featureStore] features dir:", path);
    }
  },
}));

/** Seed feature shipped on first launch. Real Python, calls the host bridge. */
const SEED_CODE_FUNDING_Z = `"""BTC 资金费率 Z 分数

对最近 N 条 funding 数据计算 z-score；|z|>2 视为情绪极端。
返回:
  z_score:   当前 funding 的 z 值
  current:   当前 funding rate（小数）
  signal:    "neutral" | "long_crowded" | "short_crowded"
"""

import statistics
from thunderclaw import market

async def compute(symbol: str = "BTCUSDT", lookback: int = 24):
    data = await market.funding_rate(symbol, limit=lookback)
    history = data.get("history") or []
    rates = [h.get("rate") or 0.0 for h in history]
    if len(rates) < 3:
        return {"error": "not enough data", "n": len(rates)}

    mean = statistics.mean(rates)
    std = statistics.pstdev(rates)
    cur = rates[-1]
    z = (cur - mean) / std if std > 0 else 0.0

    if z > 2:
        signal = "long_crowded"
    elif z < -2:
        signal = "short_crowded"
    else:
        signal = "neutral"

    return {
        "symbol": symbol,
        "current": cur,
        "z_score": round(z, 2),
        "signal": signal,
        "mean": round(mean, 6),
        "std": round(std, 6),
    }
`;
