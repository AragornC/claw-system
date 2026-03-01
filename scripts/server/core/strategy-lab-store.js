import fs from "node:fs";
import path from "node:path";
import {
  FEATURE_TAXONOMY,
  MAIN_CATEGORY_CONFIG,
  TAG_CONFIG,
  OUTPUT_TYPE_CONFIG,
  buildFeatureProductProfile,
  buildFeatureVersionInfo,
} from "../domain/feature-taxonomy.js";

import {
  clampNumber,
  FEATURE_GROUPS,
  FEATURE_KINDS,
  toText,
  slugify,
  uniqStrings,
  pickEnum,
  nowIso,
  parsePositiveInt,
  normalizeSortField,
  normalizeSortOrder,
  normalizeEnabledFilter,
  normalizeMainCategoryFilter,
  normalizeTagFilter,
  buildSeedStore,
  normalizeFeatureCandidate,
  normalizeStrategyCandidate,
  computeScore,
  applyProvenanceMeta,
  applyFeatureProductMeta,
  migrateStoreShape,
  inferFeatureRelationType,
} from "./strategy-lab-store-helpers.js";
import {
  STRATEGY_STATUS_LABELS,
  STRATEGY_RUNTIME_ENV_BY_STATUS,
  STRATEGY_RUNTIME_ENV_LABELS,
  TRADE_TYPE_LABELS,
  normalizeStatus,
  normalizeRuntimeEnv,
  canTransitionStatus,
  normalizeSortField as normalizeStrategySortField,
  normalizeSortOrder as normalizeStrategySortOrder,
  normalizeRangeDays,
  normalizeTradeType,
  normalizeFeatureRefs,
  buildStrategyDraftPayload,
  buildFeatureLookup,
  lockFeatureVersions,
  buildSampleExecutionReport,
  filterExecutionReport,
} from "./strategy-lifecycle-helpers.js";
import {
  normalizeLayerFramework,
  buildLayerCapabilityMatrix,
} from "./strategy-layer-framework.js";

export function createStrategyLabStore(deps = {}) {
  const statePath = String(deps.statePath || "").trim();
  if (!statePath) throw new Error("statePath is required");

  let storeCache = null;
  const injectedBacktestEngine = deps.backtestEngine && typeof deps.backtestEngine.runBacktest === "function"
    ? deps.backtestEngine
    : null;
  if (!injectedBacktestEngine) {
    throw new Error("backtestEngine is required: Freqtrade is the only supported engine");
  }
  const strategyExecutionEngine = injectedBacktestEngine;
  const executionReportCache = new Map();

  function runBacktestWithFallback(paramsLike = {}) {
    return strategyExecutionEngine.runBacktest(paramsLike);
  }

  function persistSafe(storeLike) {
    const store = storeLike && typeof storeLike === "object" ? storeLike : buildSeedStore();
    store.updatedAt = nowIso();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(store, null, 2), "utf8");
  }

  function loadStore() {
    if (storeCache) return storeCache;
    try {
      if (!fs.existsSync(statePath)) {
        storeCache = buildSeedStore();
        ensureStrategyLifecycleShape(storeCache);
        persistSafe(storeCache);
        return storeCache;
      }
      const raw = fs.readFileSync(statePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        storeCache = buildSeedStore();
        ensureStrategyLifecycleShape(storeCache);
        persistSafe(storeCache);
        return storeCache;
      }
      const seed = buildSeedStore();
      storeCache = {
        ...seed,
        ...parsed,
        seq: { ...seed.seq, ...(parsed.seq || {}) },
        features: Array.isArray(parsed.features) ? parsed.features : seed.features,
        versions: Array.isArray(parsed.versions) ? parsed.versions : seed.versions,
        artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
        strategies: Array.isArray(parsed.strategies) ? parsed.strategies : seed.strategies,
        strategyVersions: Array.isArray(parsed.strategyVersions) ? parsed.strategyVersions : seed.strategyVersions,
        strategyAudits: Array.isArray(parsed.strategyAudits) ? parsed.strategyAudits : seed.strategyAudits,
      };
      if (migrateStoreShape(storeCache) || ensureStrategyLifecycleShape(storeCache)) {
        persistSafe(storeCache);
      }
      return storeCache;
    } catch {
      storeCache = buildSeedStore();
      ensureStrategyLifecycleShape(storeCache);
      persistSafe(storeCache);
      return storeCache;
    }
  }

  function saveStore() {
    const store = loadStore();
    persistSafe(store);
  }

  function nextId(prefix, seqKey) {
    const store = loadStore();
    const n = Number(store?.seq?.[seqKey] || 1);
    store.seq[seqKey] = n + 1;
    return `${prefix}_${n}`;
  }

  function ensureStrategyLifecycleShape(storeLike) {
    const store = storeLike && typeof storeLike === "object" ? storeLike : buildSeedStore();
    let changed = false;
    if (!Number.isFinite(Number(store.version)) || Number(store.version) < 3) {
      store.version = 3;
      changed = true;
    }
    if (!store.seq || typeof store.seq !== "object") {
      store.seq = {};
      changed = true;
    }
    if (!Number.isFinite(Number(store.seq.strategy)) || Number(store.seq.strategy) <= 0) {
      store.seq.strategy = 1;
      changed = true;
    }
    if (!Number.isFinite(Number(store.seq.strategyVersion)) || Number(store.seq.strategyVersion) <= 0) {
      store.seq.strategyVersion = 1;
      changed = true;
    }
    if (!Number.isFinite(Number(store.seq.audit)) || Number(store.seq.audit) <= 0) {
      store.seq.audit = 1;
      changed = true;
    }
    if (!Array.isArray(store.strategies)) {
      store.strategies = [];
      changed = true;
    }
    if (!Array.isArray(store.strategyVersions)) {
      store.strategyVersions = [];
      changed = true;
    }
    if (!Array.isArray(store.strategyAudits)) {
      store.strategyAudits = [];
      changed = true;
    }
    const now = nowIso();
    if (!store.strategies.length && Array.isArray(store.versions) && store.versions.length) {
      const featureLookup = buildFeatureLookup(store.features || []);
      const seedRows = store.versions.slice(0, 3);
      seedRows.forEach((versionRow, idx) => {
        const item = versionRow && typeof versionRow === "object" ? versionRow : {};
        const strategyId = `stg_${idx + 1}`;
        const strategyVersionId = `stgver_${idx + 1}`;
        const featureRefs = normalizeFeatureRefs(item?.strategy?.featureRefs || []);
        const status = normalizeStatus(item.status === "active" ? "backtested" : "draft", "draft");
        const draftConfig = buildStrategyDraftPayload({
          signalLayer: {
            featureRefs,
            signalLogic: toText(item?.strategy?.entry || "多信号确认后触发"),
            params: {},
          },
          riskLayer: {
            riskPauseCondition: toText(item?.strategy?.riskControl || ""),
          },
          executionLayer: {},
          positionLayer: {},
        });
        const perfScore = Number(item.score);
        const latestReturnPct = Number.isFinite(perfScore) ? Number((perfScore * 65 - 8).toFixed(3)) : 0;
        const maxDrawdownPct = Number.isFinite(perfScore) ? Number((28 - perfScore * 16).toFixed(3)) : 18;
        const executionReport = buildSampleExecutionReport({ days: 30 + idx * 8, stepSec: 3600 });
        const strategyVersion = {
          strategyVersionId,
          strategyId,
          versionNo: 1,
          immutable: true,
          publishState: "published",
          versionTag: "v1.0.0",
          createdAt: toText(item.createdAt || now),
          publishedAt: toText(item.updatedAt || item.createdAt || now),
          createdBy: "ThunderClaw",
          lockedFeatureVersions: lockFeatureVersions(featureRefs, featureLookup),
          signalLayer: draftConfig.signalLayer,
          positionLayer: draftConfig.positionLayer,
          riskLayer: draftConfig.riskLayer,
          executionLayer: draftConfig.executionLayer,
          performance: {
            latestReturnPct,
            maxDrawdownPct,
            score: Number.isFinite(perfScore) ? Number(perfScore.toFixed(4)) : null,
            tradeCount: Number(item?.lastReport?.metrics?.tradeCount || 0),
            winRate: Number(item?.lastReport?.metrics?.winRate || 0),
          },
          executionReport,
        };
        const strategy = {
          strategyId,
          name: toText(item.title || `策略 ${idx + 1}`),
          description: toText(item?.strategy?.thesis || item.evalSummary || "策略草稿"),
          status,
          runtimeEnv: normalizeRuntimeEnv(status),
          currentVersionId: strategyVersionId,
          latestVersionId: strategyVersionId,
          featureCount: featureRefs.length,
          latestReturnPct,
          maxDrawdownPct,
          draftConfig,
          cardBinding: null,
          createdAt: toText(item.createdAt || now),
          updatedAt: toText(item.updatedAt || now),
        };
        store.strategies.push(strategy);
        store.strategyVersions.push(strategyVersion);
        store.strategyAudits.push({
          auditId: `audit_${idx + 1}`,
          strategyId,
          strategyVersionId,
          action: "bootstrap_migrate",
          fromStatus: "",
          toStatus: status,
          operator: "system",
          reason: "从旧策略版本迁移初始化",
          ts: now,
          detail: {
            sourceVersionId: toText(item.versionId || ""),
            sourceTitle: toText(item.title || ""),
          },
        });
      });
      store.seq.strategy = Math.max(Number(store.seq.strategy || 1), store.strategies.length + 1);
      store.seq.strategyVersion = Math.max(Number(store.seq.strategyVersion || 1), store.strategyVersions.length + 1);
      store.seq.audit = Math.max(Number(store.seq.audit || 1), store.strategyAudits.length + 1);
      changed = true;
    }
    if (Array.isArray(store.strategies)) {
      store.strategies.forEach((strategyLike) => {
        const strategy = strategyLike && typeof strategyLike === "object" ? strategyLike : null;
        if (!strategy) return;
        if (!strategy.runtimeReports || typeof strategy.runtimeReports !== "object") {
          strategy.runtimeReports = {};
          changed = true;
        }
      });
    }
    return changed;
  }

  function appendStrategyAudit(storeLike, payloadLike = {}) {
    const store = storeLike && typeof storeLike === "object" ? storeLike : loadStore();
    const payload = payloadLike && typeof payloadLike === "object" ? payloadLike : {};
    const audit = {
      auditId: `audit_${Number(store.seq.audit || 1)}`,
      strategyId: toText(payload.strategyId || ""),
      strategyVersionId: toText(payload.strategyVersionId || ""),
      action: toText(payload.action || "unknown"),
      fromStatus: toText(payload.fromStatus || ""),
      toStatus: toText(payload.toStatus || ""),
      operator: toText(payload.operator || "ThunderClaw"),
      reason: toText(payload.reason || ""),
      ts: toText(payload.ts || nowIso(), nowIso()),
      detail: payload.detail && typeof payload.detail === "object" ? payload.detail : {},
    };
    store.seq.audit = Number(store.seq.audit || 1) + 1;
    store.strategyAudits.push(audit);
    if (store.strategyAudits.length > 5000) {
      store.strategyAudits = store.strategyAudits.slice(-4200);
    }
    return audit;
  }

  function resolveStrategyById(storeLike, strategyIdLike) {
    const store = storeLike && typeof storeLike === "object" ? storeLike : loadStore();
    const strategyId = toText(strategyIdLike || "");
    if (!strategyId) return null;
    return (store.strategies || []).find((item) => toText(item?.strategyId || "") === strategyId) || null;
  }

  function resolveStrategyByName(storeLike, nameLike) {
    const store = storeLike && typeof storeLike === "object" ? storeLike : loadStore();
    const key = slugify(nameLike);
    if (!key) return null;
    return (store.strategies || []).find((item) => slugify(item?.name || "") === key) || null;
  }

  function resolveStrategyVersionById(storeLike, strategyVersionIdLike) {
    const store = storeLike && typeof storeLike === "object" ? storeLike : loadStore();
    const strategyVersionId = toText(strategyVersionIdLike || "");
    if (!strategyVersionId) return null;
    return (store.strategyVersions || []).find((item) => toText(item?.strategyVersionId || "") === strategyVersionId) || null;
  }



  function buildFeatureCatalogFromLockedFeatures(lockedLike = []) {
    const rows = Array.isArray(lockedLike) ? lockedLike : [];
    return rows
      .map((itemLike) => {
        const item = itemLike && typeof itemLike === "object" ? itemLike : {};
        const featureId = toText(item.featureId || item.featureName || "");
        if (!featureId) return null;
        return {
          featureRef: featureId,
          featureName: toText(item.featureName || featureId),
          featureId,
          featureVersion: toText(item.featureVersion || "v1.0.0"),
          mainCategory: "custom",
          mainCategoryLabel: "自定义",
        };
      })
      .filter(Boolean);
  }

  function enrichExecutionReportWithFeatureCatalog(reportLike, lockedLike = []) {
    const report = reportLike && typeof reportLike === "object" ? reportLike : null;
    if (!report) return null;
    const existing = Array.isArray(report.featureCatalog) ? report.featureCatalog.filter(Boolean) : [];
    if (existing.length > 0) return report;
    return {
      ...report,
      featureCatalog: buildFeatureCatalogFromLockedFeatures(lockedLike),
    };
  }

  function toUnixSeconds(valueLike, fallbackSec = 0) {
    const raw = toText(valueLike || "");
    if (!raw) return Math.max(0, Math.floor(Number(fallbackSec || 0)));
    const dt = new Date(raw);
    const ts = Math.floor(Number(dt.getTime()) / 1000);
    if (Number.isFinite(ts) && ts > 0) return ts;
    return Math.max(0, Math.floor(Number(fallbackSec || 0)));
  }

  function inferTradingModeFromStatus(statusLike) {
    const status = normalizeStatus(statusLike || "draft");
    if (status === "live" || status === "risk_paused") return "live";
    if (status === "paper_live") return "paper";
    return "backtest";
  }

  function normalizeTradingMode(modeLike, statusLike) {
    const raw = toText(modeLike || "").toLowerCase();
    if (raw === "live" || raw === "paper" || raw === "backtest") return raw;
    return inferTradingModeFromStatus(statusLike || "draft");
  }

  function resolveStrategyVersions(storeLike, strategyIdLike) {
    const store = storeLike && typeof storeLike === "object" ? storeLike : loadStore();
    const strategyId = toText(strategyIdLike || "");
    if (!strategyId) return [];
    return (store.strategyVersions || [])
      .filter((item) => toText(item?.strategyId || "") === strategyId)
      .slice()
      .sort((a, b) => {
        const noA = Number(a?.versionNo || 0);
        const noB = Number(b?.versionNo || 0);
        if (noA !== noB) return noB - noA;
        return String(b?.createdAt || "").localeCompare(String(a?.createdAt || ""));
      });
  }

  function buildStableSampleReport(strategyLike, modeLike, daysLike, seedShiftLike = 0) {
    const strategy = strategyLike && typeof strategyLike === "object" ? strategyLike : {};
    const mode = normalizeTradingMode(modeLike, strategy?.status || "draft");
    const rangeDays = normalizeRangeDays(daysLike || 30);
    const strategyId = toText(strategy?.strategyId || strategy?.name || "stg", "stg");
    let hash = 0;
    for (let i = 0; i < strategyId.length; i += 1) {
      const code = strategyId.charCodeAt(i);
      hash = (hash * 31 + code) % 9973;
    }
    const modeShift = mode === "live" ? 100 : (mode === "paper" ? 60 : 10);
    const createdSec = toUnixSeconds(strategy?.createdAt || "", Math.floor(Date.now() / 1000));
    return buildSampleExecutionReport({
      days: rangeDays,
      stepSec: 3600,
      baseTimeSec: createdSec + rangeDays * 86400 + modeShift * 120,
      seedShift: hash + modeShift + Math.max(0, Math.floor(Number(seedShiftLike || 0))),
    });
  }

  function summarizeExecutionReport(reportLike, performanceLike = {}) {
    const report = reportLike && typeof reportLike === "object" ? reportLike : {};
    const perf = performanceLike && typeof performanceLike === "object" ? performanceLike : {};
    const events = Array.isArray(report.events) ? report.events : [];
    const closeEvents = events.filter((item) => toText(item?.tradeType || "").toLowerCase() === "close");
    const tradeCount = closeEvents.length
      || events.length
      || Math.max(0, Math.floor(Number(perf.tradeCount || 0)));
    const equityCurve = Array.isArray(report.equityCurve) ? report.equityCurve : [];
    const drawdownCurve = Array.isArray(report.drawdownCurve) ? report.drawdownCurve : [];
    const firstEquity = Number(equityCurve[0]?.equity || 1);
    const lastEquity = Number(equityCurve[equityCurve.length - 1]?.equity || firstEquity || 1);
    const latestReturnPctFromCurve = firstEquity > 0
      ? Number((((lastEquity - firstEquity) / firstEquity) * 100).toFixed(4))
      : 0;
    let maxDrawdownPctFromCurve = 0;
    drawdownCurve.forEach((item) => {
      const dd = Number(item?.drawdownPct || 0);
      if (Number.isFinite(dd) && dd > maxDrawdownPctFromCurve) {
        maxDrawdownPctFromCurve = dd;
      }
    });
    const latestReturnPct = Number.isFinite(Number(perf.latestReturnPct))
      ? Number(perf.latestReturnPct)
      : latestReturnPctFromCurve;
    const maxDrawdownPct = Number.isFinite(Number(perf.maxDrawdownPct))
      ? Number(perf.maxDrawdownPct)
      : Number(maxDrawdownPctFromCurve.toFixed(4));
    return {
      tradeCount: Math.max(0, Math.floor(tradeCount)),
      latestReturnPct: Number(latestReturnPct.toFixed(4)),
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(4)),
    };
  }

  function buildEventReasonDetails(eventLike = {}) {
    const event = eventLike && typeof eventLike === "object" ? eventLike : {};
    const snapshot = event.decisionSnapshot && typeof event.decisionSnapshot === "object"
      ? event.decisionSnapshot
      : {};
    const signal = snapshot.signal && typeof snapshot.signal === "object" ? snapshot.signal : {};
    const position = snapshot.position && typeof snapshot.position === "object" ? snapshot.position : {};
    const risk = snapshot.risk && typeof snapshot.risk === "object" ? snapshot.risk : {};
    const execution = snapshot.execution && typeof snapshot.execution === "object" ? snapshot.execution : {};
    const externalSignals = Array.isArray(signal.externalSignals)
      ? signal.externalSignals.slice(0, 4).map((itemLike) => {
        const item = itemLike && typeof itemLike === "object" ? itemLike : {};
        return {
          featureRef: toText(item.featureRef || ""),
          sourceType: toText(item.sourceType || ""),
          sourceLabel: toText(item.sourceLabel || ""),
          sourceUrl: toText(item.sourceUrl || ""),
          score: Number(item.score || 0),
          sourceStatus: toText(item.sourceStatus || ""),
          headlines: Array.isArray(item.sampleHeadlines) ? item.sampleHeadlines.slice(0, 3) : [],
        };
      })
      : [];
    const indicatorSignals = [
      {
        name: "longThreshold",
        value: Number(signal.longThreshold || 0),
      },
      {
        name: "shortThreshold",
        value: Number(signal.shortThreshold || 0),
      },
      {
        name: "observedDeltaPct",
        value: Number(signal.observedDeltaPct || 0),
      },
      {
        name: "externalSignalScore",
        value: Number(signal.externalSignalScore || 0),
      },
    ];
    const reasonSummary = [
      toText(event.reasonRule || ""),
      `signal=${toText(signal.signalType || "")}`,
      `delta=${Number(signal.observedDeltaPct || 0).toFixed(4)}%`,
      externalSignals.length ? `external=${externalSignals.map((row) => `${row.sourceLabel}:${row.score.toFixed(3)}`).join("|")}` : "",
    ].filter(Boolean).join(" ; ");
    return {
      reasonSummary,
      indicatorSignals,
      externalSignals,
      runtime: {
        position,
        risk,
        execution,
      },
    };
  }

  function enrichEventsWithReason(rowsLike = []) {
    const rows = Array.isArray(rowsLike) ? rowsLike : [];
    return rows.map((item) => {
      const reasonDetails = buildEventReasonDetails(item);
      return {
        ...item,
        tradeTypeLabel: TRADE_TYPE_LABELS[toText(item?.tradeType || "").toLowerCase()] || toText(item?.tradeType || ""),
        reasonDetails,
        reasonSummary: toText(reasonDetails.reasonSummary || toText(item?.reasonRule || "")),
      };
    });
  }

  function inferArtifactTradingMode(artifactLike) {
    const artifact = artifactLike && typeof artifactLike === "object" ? artifactLike : {};
    const config = artifact.config && typeof artifact.config === "object" ? artifact.config : {};
    const result = artifact.result && typeof artifact.result === "object" ? artifact.result : {};
    const modeRaw = toText(config.marketMode || result.marketMode || "").toLowerCase();
    if (modeRaw === "live" || modeRaw === "paper" || modeRaw === "backtest") return modeRaw;
    const sourceRaw = toText(artifact.source || "").toLowerCase();
    if (sourceRaw.includes("live")) return "live";
    if (sourceRaw.includes("paper")) return "paper";
    if (sourceRaw.includes("backtest")) return "backtest";
    return "backtest";
  }

  function buildArtifactExecutionReport(artifactLike, strategyLike) {
    const artifact = artifactLike && typeof artifactLike === "object" ? artifactLike : {};
    const config = artifact.config && typeof artifact.config === "object" ? artifact.config : {};
    const result = artifact.result && typeof artifact.result === "object" ? artifact.result : {};
    if (result.executionReport && typeof result.executionReport === "object") {
      return result.executionReport;
    }
    const bars = Math.max(120, Math.min(3600, Math.floor(Number(config.bars || result.bars || 720) || 720)));
    const rangeDays = Math.max(7, Math.min(365, Math.floor(bars / 24)));
    const mode = inferArtifactTradingMode(artifact);
    const tradeCount = Math.max(0, Math.floor(Number(result.tradeCount || result.trades || 0) || 0));
    const strategy = strategyLike && typeof strategyLike === "object" ? strategyLike : {};
    const report = buildStableSampleReport(strategy, mode, rangeDays, tradeCount + bars);
    return report;
  }

  function buildRuntimeModeReport(storeLike, strategyLike, versionsLike, modeLike, rangeDaysLike) {
    const store = storeLike && typeof storeLike === "object" ? storeLike : loadStore();
    const strategy = strategyLike && typeof strategyLike === "object" ? strategyLike : {};
    const versions = Array.isArray(versionsLike) ? versionsLike : [];
    const mode = normalizeTradingMode(modeLike, strategy.status || "draft");
    const runtimeReports = strategy.runtimeReports && typeof strategy.runtimeReports === "object"
      ? strategy.runtimeReports
      : {};
    const fromRuntime = runtimeReports[mode] && typeof runtimeReports[mode] === "object"
      ? runtimeReports[mode]
      : null;
    if (fromRuntime && fromRuntime.executionReport && typeof fromRuntime.executionReport === "object") {
      return {
        mode,
        source: toText(fromRuntime.source || "runtime"),
        updatedAt: toText(fromRuntime.updatedAt || strategy.updatedAt || ""),
        executionReport: fromRuntime.executionReport,
        positionSummary: fromRuntime.positionSummary && typeof fromRuntime.positionSummary === "object"
          ? fromRuntime.positionSummary
          : {},
      };
    }
    const currentVersionId = toText(strategy.currentVersionId || strategy.latestVersionId || "");
    const preferredVersion = versions.find((item) => toText(item?.strategyVersionId || "") === currentVersionId) || versions[0] || null;
    if (preferredVersion) {
      const report = resolveVersionBacktestExecutionReport(store, strategy, preferredVersion, normalizeRangeDays(rangeDaysLike || 30));
      return {
        mode,
        source: "strategy_version",
        updatedAt: toText(preferredVersion.publishedAt || preferredVersion.createdAt || strategy.updatedAt || ""),
        executionReport: report,
        positionSummary: {
          mode,
          state: mode === "live" ? "running" : "paper_running",
          note: mode === "live" ? "来自当前策略版本实盘数据映射" : "来自当前策略版本模拟数据映射",
        },
      };
    }
    if (mode === "backtest" && strategy.draftConfig && typeof strategy.draftConfig === "object") {
      try {
        const featureLookup = buildFeatureLookup(store.features || []);
        const draftFeatureRefs = normalizeFeatureRefs(strategy?.draftConfig?.signalLayer?.featureRefs || []);
        const lockedFeatureVersions = lockFeatureVersions(draftFeatureRefs, featureLookup);
        const out = runBacktestWithFallback({
          strategy,
          version: {
            strategyVersionId: "",
            strategyId: toText(strategy.strategyId || ""),
            versionNo: 0,
            versionTag: "draft",
            signalLayer: strategy.draftConfig.signalLayer || {},
            positionLayer: strategy.draftConfig.positionLayer || {},
            riskLayer: strategy.draftConfig.riskLayer || {},
            executionLayer: strategy.draftConfig.executionLayer || {},
            lockedFeatureVersions,
          },
          features: store.features || [],
          rangeDays: normalizeRangeDays(rangeDaysLike || 30),
        });
        const report = out?.executionReport && typeof out.executionReport === "object" ? out.executionReport : null;
        if (report) {
          return {
            mode,
            source: "draft_engine",
            updatedAt: toText(strategy.updatedAt || strategy.createdAt || ""),
            executionReport: report,
            positionSummary: {
              mode,
              state: "draft_backtest",
              note: "草稿事件驱动回测结果",
            },
          };
        }
      } catch (_) {}
    }
    return {
      mode,
      source: "fallback_sample",
      updatedAt: toText(strategy.updatedAt || strategy.createdAt || ""),
      executionReport: buildStableSampleReport(strategy, mode, rangeDaysLike || 30),
      positionSummary: {
        mode,
        state: "unknown",
        note: mode === "live" ? "尚未接入实盘成交，当前显示稳定占位样本。" : "尚未接入模拟成交，当前显示稳定占位样本。",
      },
    };
  }

  function buildEngineCacheKey(paramsLike = {}) {
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    return [
      toText(params.strategyId || ""),
      toText(params.strategyVersionId || ""),
      String(Math.max(1, Math.floor(Number(params.rangeDays || 30) || 30))),
      toText(params.strategyUpdatedAt || ""),
      toText(params.versionUpdatedAt || ""),
      String(Math.max(0, Math.floor(Number(params.featureCount || 0) || 0))),
    ].join("|");
  }

  function readEngineReportCache(cacheKeyLike) {
    const cacheKey = toText(cacheKeyLike || "");
    if (!cacheKey) return null;
    const hit = executionReportCache.get(cacheKey) || null;
    if (!hit || typeof hit !== "object") return null;
    const ts = Number(hit.ts || 0);
    const ageMs = Date.now() - ts;
    if (!Number.isFinite(ageMs) || ageMs > 5 * 60 * 1000) {
      executionReportCache.delete(cacheKey);
      return null;
    }
    return hit.report && typeof hit.report === "object" ? hit.report : null;
  }

  function writeEngineReportCache(cacheKeyLike, reportLike) {
    const cacheKey = toText(cacheKeyLike || "");
    const report = reportLike && typeof reportLike === "object" ? reportLike : null;
    if (!cacheKey || !report) return;
    executionReportCache.set(cacheKey, {
      ts: Date.now(),
      report,
    });
    if (executionReportCache.size <= 240) return;
    const entries = Array.from(executionReportCache.entries())
      .sort((a, b) => Number(a?.[1]?.ts || 0) - Number(b?.[1]?.ts || 0));
    const drop = Math.max(1, executionReportCache.size - 200);
    for (let i = 0; i < drop && i < entries.length; i += 1) {
      executionReportCache.delete(entries[i][0]);
    }
  }

  function resolveVersionBacktestExecutionReport(storeLike, strategyLike, versionLike, rangeDaysLike) {
    const store = storeLike && typeof storeLike === "object" ? storeLike : loadStore();
    const strategy = strategyLike && typeof strategyLike === "object" ? strategyLike : {};
    const version = versionLike && typeof versionLike === "object" ? versionLike : {};
    const report = version.executionReport && typeof version.executionReport === "object"
      ? version.executionReport
      : null;
    const engineName = toText(report?.engine?.name || "");
    if (report && engineName === "thunderclaw_strategy_engine_v1") {
      return report;
    }
    const rangeDays = normalizeRangeDays(rangeDaysLike || 30);
    const cacheKey = buildEngineCacheKey({
      strategyId: strategy.strategyId,
      strategyVersionId: version.strategyVersionId,
      rangeDays,
      strategyUpdatedAt: strategy.updatedAt,
      versionUpdatedAt: version.updatedAt || version.publishedAt || version.createdAt,
      featureCount: Array.isArray(store.features) ? store.features.length : 0,
    });
    const cacheHit = readEngineReportCache(cacheKey);
    if (cacheHit) return cacheHit;
    try {
      const out = runBacktestWithFallback({
        strategy,
        version,
        features: store.features || [],
        rangeDays,
      });
      const engineReport = out?.executionReport && typeof out.executionReport === "object"
        ? out.executionReport
        : null;
      if (engineReport) {
        writeEngineReportCache(cacheKey, engineReport);
        return engineReport;
      }
    } catch (_) {}
    if (report) return report;
    return buildStableSampleReport(strategy, "backtest", rangeDays, Number(version?.versionNo || 1));
  }

  function buildBacktestPlaybackRows(storeLike, strategyLike, versionsLike, rangeDaysLike = 30) {
    const store = storeLike && typeof storeLike === "object" ? storeLike : loadStore();
    const strategy = strategyLike && typeof strategyLike === "object" ? strategyLike : {};
    const versions = Array.isArray(versionsLike) ? versionsLike : [];
    const rangeDays = normalizeRangeDays(rangeDaysLike || 30);
    const rows = [];
    versions.forEach((version) => {
      const report = resolveVersionBacktestExecutionReport(store, strategy, version, rangeDays);
      const perf = version?.performance && typeof version.performance === "object" ? version.performance : {};
      const summary = summarizeExecutionReport(report, perf);
      rows.push({
        playbackId: "ver:" + toText(version?.strategyVersionId || ""),
        marketMode: "backtest",
        source: "strategy_version",
        strategyVersionId: toText(version?.strategyVersionId || ""),
        label: toText(version?.versionTag || ("v" + String(Number(version?.versionNo || 1) || 1))) + " 回测",
        createdAt: toText(version?.publishedAt || version?.createdAt || strategy.updatedAt || ""),
        updatedAt: toText(version?.publishedAt || version?.createdAt || strategy.updatedAt || ""),
        executionReport: report,
        ...summary,
      });
    });
    if (strategy.draftConfig && typeof strategy.draftConfig === "object") {
      try {
        const featureLookup = buildFeatureLookup(store.features || []);
        const draftFeatureRefs = normalizeFeatureRefs(strategy?.draftConfig?.signalLayer?.featureRefs || []);
        const lockedFeatureVersions = lockFeatureVersions(draftFeatureRefs, featureLookup);
        const out = runBacktestWithFallback({
          strategy,
          version: {
            strategyVersionId: "",
            strategyId: toText(strategy.strategyId || ""),
            versionNo: 0,
            versionTag: "draft",
            signalLayer: strategy.draftConfig.signalLayer || {},
            positionLayer: strategy.draftConfig.positionLayer || {},
            riskLayer: strategy.draftConfig.riskLayer || {},
            executionLayer: strategy.draftConfig.executionLayer || {},
            lockedFeatureVersions,
          },
          features: store.features || [],
          rangeDays,
        });
        const report = out?.executionReport && typeof out.executionReport === "object" ? out.executionReport : null;
        if (report) {
          const summary = summarizeExecutionReport(report, {
            latestReturnPct: Number(out?.summary?.latestReturnPct || 0) || 0,
            maxDrawdownPct: Number(out?.summary?.maxDrawdownPct || 0) || 0,
            tradeCount: Number(out?.summary?.tradeCount || 0) || 0,
          });
          rows.push({
            playbackId: "draft:runtime",
            marketMode: "backtest",
            source: "draft_engine",
            strategyVersionId: "",
            label: "草稿运行回放",
            createdAt: toText(strategy.updatedAt || strategy.createdAt || ""),
            updatedAt: toText(strategy.updatedAt || strategy.createdAt || ""),
            executionReport: report,
            ...summary,
          });
        }
      } catch (_) {}
    }
    const strategyId = toText(strategy.strategyId || "");
    (store.artifacts || []).forEach((artifactLike) => {
      const artifact = artifactLike && typeof artifactLike === "object" ? artifactLike : {};
      const config = artifact.config && typeof artifact.config === "object" ? artifact.config : {};
      const result = artifact.result && typeof artifact.result === "object" ? artifact.result : {};
      const directStrategyId = toText(config.strategyId || result.strategyId || "");
      const mode = inferArtifactTradingMode(artifact);
      const matchById = directStrategyId && directStrategyId === strategyId;
      if (!matchById) return;
      if (mode !== "backtest") return;
      const report = buildArtifactExecutionReport(artifact, strategy);
      const summary = summarizeExecutionReport(report, {
        latestReturnPct: Number(result.netPnlPct || result.totalPnlPct || 0) || 0,
        maxDrawdownPct: Number(result.maxDrawdownPct || 0) || 0,
        tradeCount: Number(result.tradeCount || result.trades || 0) || 0,
      });
      const playbackId = "artifact:" + toText(artifact.artifactId || artifact.reportKey || "");
      if (!playbackId || playbackId === "artifact:") return;
      rows.push({
        playbackId,
        marketMode: "backtest",
        source: "artifact",
        strategyVersionId: "",
        label: toText(artifact.label || "回测工件"),
        createdAt: toText(artifact.ts || artifact.updatedAt || strategy.updatedAt || ""),
        updatedAt: toText(artifact.updatedAt || artifact.ts || strategy.updatedAt || ""),
        executionReport: report,
        ...summary,
      });
    });
    const dedup = new Map();
    rows.forEach((item) => {
      const key = toText(item?.playbackId || "");
      if (!key) return;
      dedup.set(key, item);
    });
    return Array.from(dedup.values()).sort((a, b) => String(b?.createdAt || "").localeCompare(String(a?.createdAt || "")));
  }

  function listFeatures(options = {}) {
    const store = loadStore();
    const q = toText(options.q).toLowerCase();
    const group = pickEnum(options.group || "", FEATURE_GROUPS, "");
    const kind = pickEnum(options.kind || "", FEATURE_KINDS, "");
    const mainCategory = normalizeMainCategoryFilter(options.mainCategory);
    const tag = normalizeTagFilter(options.tag);
    const source = toText(options.source || "");
    const enabledFilter = normalizeEnabledFilter(options.enabled);
    const sortBy = normalizeSortField(options.sortBy);
    const sortOrder = normalizeSortOrder(options.sortOrder);
    const page = parsePositiveInt(options.page, 1, 1, 9999);
    const pageSize = parsePositiveInt(options.pageSize || options.limit, 40, 10, 120);
    let rows = Array.isArray(store.features) ? store.features.slice() : [];
    if (group) {
      rows = rows.filter((item) => String(item?.group || "") === group);
    }
    if (kind) {
      rows = rows.filter((item) => String(item?.kind || "") === kind);
    }
    if (mainCategory) {
      rows = rows.filter((item) => String(item?.mainCategory || "") === mainCategory);
    }
    if (tag) {
      rows = rows.filter((item) => Array.isArray(item?.tags) && item.tags.includes(tag));
    }
    if (source) {
      rows = rows.filter((item) => String(item?.source || "") === source);
    }
    if (enabledFilter) {
      const enabledVal = enabledFilter === "enabled";
      rows = rows.filter((item) => Boolean(item?.enabled !== false) === enabledVal);
    }
    if (q) {
      rows = rows.filter((item) => {
        const text = [
          item?.featureId,
          item?.name,
          item?.group,
          item?.kind,
          item?.mainCategory,
          item?.outputType,
          item?.description,
          item?.usageSummary,
          item?.triggerLogic,
          ...(Array.isArray(item?.tags) ? item.tags : []),
          item?.source,
          item?.originQuery,
          item?.originReply,
          item?.originConversationId,
          item?.originCardId,
        ]
          .map((v) => String(v || "").toLowerCase())
          .join(" ");
        return text.includes(q);
      });
    }
    rows.sort((a, b) => {
      let cmp = 0;
      if (
        sortBy === "name"
        || sortBy === "group"
        || sortBy === "kind"
        || sortBy === "source"
        || sortBy === "mainCategory"
        || sortBy === "outputType"
      ) {
        cmp = String(a?.[sortBy] || "").localeCompare(String(b?.[sortBy] || ""));
      } else if (sortBy === "enabled") {
        cmp = Number(Boolean(a?.enabled !== false)) - Number(Boolean(b?.enabled !== false));
      } else {
        cmp = String(a?.[sortBy] || "").localeCompare(String(b?.[sortBy] || ""));
      }
      if (cmp === 0) {
        cmp = String(b?.updatedAt || "").localeCompare(String(a?.updatedAt || ""));
      }
      return sortOrder === "asc" ? cmp : -cmp;
    });
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = Math.min(page, totalPages);
    const start = (normalizedPage - 1) * pageSize;
    return {
      total,
      page: normalizedPage,
      pageSize,
      totalPages,
      sortBy,
      sortOrder,
      features: rows.slice(start, start + pageSize),
    };
  }

  function getFeatureFacets() {
    const store = loadStore();
    const rows = Array.isArray(store.features) ? store.features : [];
    const groups = uniqStrings(rows.map((item) => item?.group)).sort((a, b) => a.localeCompare(b));
    const kinds = uniqStrings(rows.map((item) => item?.kind)).sort((a, b) => a.localeCompare(b));
    const sources = uniqStrings(rows.map((item) => item?.source)).sort((a, b) => a.localeCompare(b));
    const mainCategories = uniqStrings(rows.map((item) => item?.mainCategory))
      .filter((key) => Boolean(MAIN_CATEGORY_CONFIG[key]))
      .sort((a, b) => a.localeCompare(b));
    const tags = uniqStrings(
      rows.flatMap((item) => (Array.isArray(item?.tags) ? item.tags : [])),
    )
      .filter((key) => Boolean(TAG_CONFIG[key]))
      .sort((a, b) => a.localeCompare(b));
    const outputTypes = uniqStrings(rows.map((item) => item?.outputType))
      .filter((key) => Boolean(OUTPUT_TYPE_CONFIG[key]))
      .sort((a, b) => a.localeCompare(b));
    const enabledCount = rows.filter((item) => item?.enabled !== false).length;
    return {
      groups,
      kinds,
      sources,
      mainCategories,
      tags,
      outputTypes,
      taxonomy: {
        mainCategories: FEATURE_TAXONOMY.mainCategories,
        tags: FEATURE_TAXONOMY.tags,
        outputTypes: FEATURE_TAXONOMY.outputTypes,
      },
      enabledCount,
      disabledCount: Math.max(0, rows.length - enabledCount),
    };
  }

  function listVersions(options = {}) {
    const store = loadStore();
    const limit = Math.max(1, Math.min(300, Number(options.limit) || 80));
    const rows = (Array.isArray(store.versions) ? store.versions.slice() : [])
      .sort((a, b) => String(b?.updatedAt || "").localeCompare(String(a?.updatedAt || "")));
    return {
      total: rows.length,
      versions: rows.slice(0, limit),
    };
  }

  function findFeatureByName(nameLike) {
    const key = slugify(nameLike);
    if (!key) return null;
    const store = loadStore();
    return (store.features || []).find((item) => slugify(item?.name) === key) || null;
  }

  function upsertFeature(featureLike, metaLike = {}) {
    const store = loadStore();
    const normalized = normalizeFeatureCandidate(featureLike);
    if (!normalized) throw new Error("invalid feature candidate");
    const now = nowIso();
    const existing = findFeatureByName(normalized.name);
    if (existing) {
      existing.group = normalized.group;
      existing.kind = normalized.kind;
      existing.description = normalized.description;
      existing.params = normalized.params;
      existing.mainCategory = normalized.mainCategory || existing.mainCategory;
      existing.tags = normalized.tags && normalized.tags.length ? normalized.tags : existing.tags;
      existing.displayMode = normalized.displayMode || existing.displayMode;
      existing.outputType = normalized.outputType || existing.outputType;
      existing.usageSummary = normalized.usageSummary || existing.usageSummary;
      existing.triggerLogic = normalized.triggerLogic || existing.triggerLogic;
      existing.algorithmSummary = normalized.algorithmSummary || existing.algorithmSummary;
      existing.algorithmSteps = normalized.algorithmSteps && normalized.algorithmSteps.length
        ? normalized.algorithmSteps
        : existing.algorithmSteps;
      existing.pseudoCode = normalized.pseudoCode && normalized.pseudoCode.length
        ? normalized.pseudoCode
        : existing.pseudoCode;
      existing.paramSpecs = normalized.paramSpecs && normalized.paramSpecs.length
        ? normalized.paramSpecs
        : existing.paramSpecs;
      existing.sourceType = normalized.sourceType || existing.sourceType;
      existing.createdBy = normalized.createdBy || existing.createdBy;
      existing.enabled = normalized.enabled !== false;
      applyProvenanceMeta(existing, metaLike, now, toText(existing.source || "chat_intent", "chat_intent"));
      applyFeatureProductMeta(existing, {
        ...metaLike,
        source: toText(metaLike?.source || existing.source || "chat_intent"),
        sourceType: toText(metaLike?.sourceType || existing.sourceType || existing.source || "chat_intent"),
        creator: toText(metaLike?.createdBy || metaLike?.creator || existing.createdBy || "ThunderClaw"),
        bumpRevision: true,
      });
      existing.updatedAt = now;
      saveStore();
      return { created: false, feature: existing };
    }
    const item = {
      featureId: nextId("feat", "feature"),
      name: normalized.name,
      group: normalized.group,
      kind: normalized.kind,
      description: normalized.description,
      params: normalized.params,
      mainCategory: normalized.mainCategory,
      tags: normalized.tags,
      displayMode: normalized.displayMode,
      outputType: normalized.outputType,
      usageSummary: normalized.usageSummary,
      triggerLogic: normalized.triggerLogic,
      algorithmSummary: normalized.algorithmSummary,
      algorithmSteps: normalized.algorithmSteps,
      pseudoCode: normalized.pseudoCode,
      paramSpecs: normalized.paramSpecs,
      enabled: normalized.enabled !== false,
      source: "chat_intent",
      sourceType: toText(normalized.sourceType || metaLike?.sourceType || metaLike?.source || "chat_intent"),
      createdBy: toText(normalized.createdBy || metaLike?.createdBy || metaLike?.creator || "ThunderClaw"),
      originQuery: "",
      originReply: "",
      createdAt: now,
      updatedAt: now,
    };
    applyProvenanceMeta(item, metaLike, now, "chat_intent");
    applyFeatureProductMeta(item, {
      ...metaLike,
      source: toText(metaLike?.source || "chat_intent"),
      sourceType: toText(metaLike?.sourceType || metaLike?.source || "chat_intent"),
      creator: toText(metaLike?.createdBy || metaLike?.creator || "ThunderClaw"),
      bumpRevision: false,
    });
    store.features.push(item);
    saveStore();
    return { created: true, feature: item };
  }

  function upsertStrategy(strategyLike, metaLike = {}) {
    const store = loadStore();
    const normalized = normalizeStrategyCandidate(strategyLike);
    if (!normalized.title) throw new Error("invalid strategy candidate");
    const now = nowIso();
    const titleKey = normalized.title.toLowerCase();
    const allowTitleMerge = metaLike?.allowTitleMerge === true;
    const existing = allowTitleMerge
      ? ((store.versions || []).find((item) => String(item?.title || "").toLowerCase() === titleKey) || null)
      : null;
    const featureRefs = uniqStrings([
      ...normalized.featureRefs,
      ...normalized.features.map((f) => f.name),
    ]);
    normalized.features.forEach((feature) => {
      try {
        upsertFeature(feature, metaLike);
      } catch {}
    });
    if (existing) {
      existing.strategy = {
        ...existing.strategy,
        thesis: normalized.thesis,
        horizon: normalized.horizon,
        riskLevel: normalized.riskLevel,
        entry: normalized.entry,
        riskControl: normalized.riskControl,
        exit: normalized.exit,
        featureRefs,
        dsl: normalized.dsl || existing.strategy?.dsl || null,
      };
      existing.source = toText(metaLike.source || existing.source || "chat_intent");
      existing.originQuery = toText(metaLike.query || existing.originQuery || "");
      existing.originReply = toText(metaLike.reply || existing.originReply || "");
      applyProvenanceMeta(existing, metaLike, now, toText(existing.source || "chat_intent", "chat_intent"));
      existing.updatedAt = now;
      saveStore();
      return { created: false, version: existing };
    }
    const item = {
      versionId: nextId("ver", "version"),
      title: normalized.title,
      status: "candidate",
      parentVersionId: toText(metaLike.parentVersionId || ""),
      score: null,
      evalSummary: "",
      source: toText(metaLike.source || "chat_intent"),
      originQuery: toText(metaLike.query || ""),
      originReply: toText(metaLike.reply || ""),
      strategy: {
        thesis: normalized.thesis,
        horizon: normalized.horizon,
        riskLevel: normalized.riskLevel,
        entry: normalized.entry,
        riskControl: normalized.riskControl,
        exit: normalized.exit,
        featureRefs,
        dsl: normalized.dsl || null,
      },
      createdAt: now,
      updatedAt: now,
    };
    applyProvenanceMeta(item, metaLike, now, "chat_intent");
    store.versions.push(item);
    saveStore();
    return { created: true, version: item };
  }



  function validateFeatureExecutionCodeForApply(featureLike = {}) {
    const feature = featureLike && typeof featureLike === "object" ? featureLike : {};
    const params = feature.params && typeof feature.params === "object" ? feature.params : {};
    const kind = toText(feature.kind || "").toLowerCase();
    const name = toText(feature.name || feature.featureId || "").toLowerCase();
    const sourceType = toText(params.sourceType || feature.sourceType || "").toLowerCase();
    const isExternal = sourceType === "news"
      || sourceType === "social"
      || sourceType === "prediction"
      || kind === "news_sentiment"
      || kind === "social_sentiment"
      || kind === "prediction_market"
      || name.includes("news")
      || name.includes("social")
      || name.includes("twitter")
      || name.includes("prediction")
      || name.includes("polymarket");
    if (!isExternal) return;

    const pythonIndicator = toText(params.pythonIndicator || "");
    if (!pythonIndicator) {
      throw new Error("外部特征必须先由模型产出 pythonIndicator 执行代码，才能确认加入");
    }
    const codeSource = toText(params.codeSource || "").toLowerCase();
    if (codeSource !== "model_generated") {
      throw new Error("外部特征代码来源无效：仅允许 model_generated");
    }
    const codegenStatus = toText(params.codegenStatus || "").toLowerCase();
    if (codegenStatus === "needs_user_input") {
      const needed = Array.isArray(params.requiredInputs) ? params.requiredInputs : [];
      const neededKeys = needed.map((row) => toText(row && row.key || "")).filter(Boolean);
      const detail = neededKeys.length ? `（待补充：${neededKeys.join(",")}）` : "";
      throw new Error(`外部特征代码仍需用户确认后改造${detail}`);
    }
    const codeValidationError = toText(params.codeValidationError || "");
    if (codeValidationError) {
      throw new Error(`外部特征代码校验未通过：${codeValidationError}`);
    }
  }

  function applyIntentCandidate(candidateLike, metaLike = {}) {
    const candidate = candidateLike && typeof candidateLike === "object" ? candidateLike : {};
    const kind = String(candidate.kind || "").trim().toLowerCase();
    if (kind === "feature") {
      const featureRaw = candidate.feature && typeof candidate.feature === "object"
        ? candidate.feature
        : candidate;
      validateFeatureExecutionCodeForApply(featureRaw);
      const result = upsertFeature(featureRaw, metaLike);
      return {
        kind: "feature",
        created: result.created,
        feature: result.feature,
        version: null,
      };
    }
    if (kind === "strategy") {
      const strategyRaw = candidate.strategy && typeof candidate.strategy === "object"
        ? candidate.strategy
        : candidate;
      const prepared = {
        ...strategyRaw,
        title: toText(strategyRaw.title || candidate.title || "对话策略候选"),
      };
      const extraFeatureRefs = Array.isArray(prepared.features)
        ? prepared.features.map((item) => {
          if (typeof item === "string") return item;
          const row = item && typeof item === "object" ? item : {};
          return toText(row.featureId || row.name || "");
        }).filter(Boolean)
        : [];
      const draftFeatureRefs = uniqStrings([
        ...(Array.isArray(prepared.featureRefs) ? prepared.featureRefs : []),
        ...extraFeatureRefs,
      ]);
      const layerFramework = normalizeLayerFramework(prepared.layers || {
        signalLayer: {
          signalType: "composite",
          signalLogic: toText(prepared.entry || "多信号确认"),
          featureRefs: draftFeatureRefs,
        },
        positionLayer: {},
        riskLayer: {
          riskPauseCondition: toText(prepared.riskControl || ""),
        },
        executionLayer: {},
      });
      const result = upsertStrategy(prepared, {
        ...metaLike,
        allowTitleMerge: false,
      });
      const lifecycleResult = saveStrategyDraft({
        name: prepared.title,
        description: toText(prepared.thesis || candidate.summary || ""),
        signalLayer: layerFramework.signalLayer,
        positionLayer: layerFramework.positionLayer,
        riskLayer: layerFramework.riskLayer,
        executionLayer: layerFramework.executionLayer,
      }, {
        ...metaLike,
        source: toText(metaLike?.source || "chat_intent"),
        forceCreate: true,
        reason: "来自 ThunderClaw 对话候选",
      });
      return {
        kind: "strategy",
        created: result.created,
        feature: null,
        version: result.version,
        strategy: lifecycleResult?.strategy || null,
        layerMatrix: buildLayerCapabilityMatrix(layerFramework),
      };
    }
    throw new Error("candidate.kind must be feature or strategy");
  }

  function proposeVersionsFromMessage(params = {}) {
    const message = toText(params.message);
    if (!message) throw new Error("message is required");
    const baseVersionId = toText(params.baseVersionId);
    const store = loadStore();
    const base = (store.versions || []).find((v) => String(v?.versionId || "") === baseVersionId)
      || (store.versions || [])[0]
      || null;
    const objective = message.slice(0, 160);
    const baseTitle = toText(base?.title || "策略基线");
    const parentVersionId = toText(base?.versionId || "");
    const variants = [
      {
        title: `${baseTitle} · 稳健降回撤`,
        horizon: "intraday",
        riskLevel: "conservative",
        entry: "增加确认条件后再入场",
        riskControl: "收紧单笔风险，优先控制回撤",
        exit: "目标收益达到即分批退出",
      },
      {
        title: `${baseTitle} · 平衡收益`,
        horizon: "intraday",
        riskLevel: "balanced",
        entry: "趋势同向 + 动量确认",
        riskControl: "ATR 风险控制 + notional 约束",
        exit: "趋势衰减或收益目标达成退出",
      },
      {
        title: `${baseTitle} · 进攻增强`,
        horizon: "swing",
        riskLevel: "aggressive",
        entry: "突破或再入信号触发即执行",
        riskControl: "允许更大波动，设置硬止损",
        exit: "反向信号或时间止盈退出",
      },
    ];
    const proposals = variants.map((item) => {
      const result = upsertStrategy(
        {
          title: item.title,
          thesis: `用户目标：${objective}`,
          horizon: item.horizon,
          riskLevel: item.riskLevel,
          entry: item.entry,
          riskControl: item.riskControl,
          exit: item.exit,
          featureRefs: base?.strategy?.featureRefs || [],
        },
        {
          source: "manual_propose",
          query: message,
          parentVersionId,
        },
      );
      return result.version;
    });
    return { proposals };
  }

  function evaluateVersion(params = {}) {
    const versionId = toText(params.versionId);
    if (!versionId) throw new Error("versionId is required");
    const metrics = params.metrics && typeof params.metrics === "object" ? params.metrics : {};
    const store = loadStore();
    const target = (store.versions || []).find((item) => String(item?.versionId || "") === versionId);
    if (!target) throw new Error("version not found");
    const score = computeScore(metrics);
    const report = {
      ts: nowIso(),
      score,
      metrics: {
        tradeCount: clampNumber(metrics.tradeCount, 0, 50000, 0),
        winRate: clampNumber(metrics.winRate, 0, 100, 0),
        netPnlPct: clampNumber(metrics.netPnlPct, -100, 300, 0),
        maxDrawdownPct: clampNumber(metrics.maxDrawdownPct, 0, 100, 0),
        sharpe: clampNumber(metrics.sharpe, -5, 10, 0),
        profitFactor: clampNumber(metrics.profitFactor, 0, 10, 0),
      },
    };
    target.score = Number(score.toFixed(4));
    target.status = "evaluated";
    target.evalSummary = `win=${report.metrics.winRate.toFixed(1)}% pnl=${report.metrics.netPnlPct.toFixed(2)}% dd=${report.metrics.maxDrawdownPct.toFixed(2)}%`;
    target.lastReport = report;
    target.updatedAt = nowIso();
    saveStore();
    return { report, version: target };
  }

  function reportArtifact(payloadLike = {}) {
    const store = loadStore();
    const payload = payloadLike && typeof payloadLike === "object" ? payloadLike : {};
    const reportKey = toText(payload.reportKey || "");
    const existing = reportKey
      ? (store.artifacts || []).find((item) => String(item?.reportKey || "") === reportKey) || null
      : null;
    const ts = nowIso();
    if (existing) {
      existing.ts = ts;
      existing.source = toText(payload.source || existing.source || "dashboard");
      existing.query = toText(payload.query || existing.query || "");
      existing.label = toText(payload.label || existing.label || "strategy-artifact");
      existing.config = payload.config && typeof payload.config === "object" ? payload.config : existing.config || {};
      existing.result = payload.result && typeof payload.result === "object" ? payload.result : existing.result || {};
      existing.version = Number(existing.version || 1) + 1;
      existing.updatedAt = ts;
      saveStore();
      return { artifact: existing, artifactId: existing.artifactId, version: existing.version };
    }
    const artifact = {
      artifactId: nextId("artifact", "artifact"),
      reportKey: reportKey || nextId("report", "artifact"),
      version: 1,
      ts,
      updatedAt: ts,
      source: toText(payload.source || "dashboard"),
      query: toText(payload.query || ""),
      label: toText(payload.label || "strategy-artifact"),
      config: payload.config && typeof payload.config === "object" ? payload.config : {},
      result: payload.result && typeof payload.result === "object" ? payload.result : {},
    };
    store.artifacts.push(artifact);
    if (store.artifacts.length > 2000) {
      store.artifacts = store.artifacts.slice(-1600);
    }
    saveStore();
    return { artifact, artifactId: artifact.artifactId, version: 1 };
  }

  function runStrategyReplay(paramsLike = {}, metaLike = {}) {
    const store = loadStore();
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const meta = metaLike && typeof metaLike === "object" ? metaLike : {};
    const strategyId = toText(params.strategyId || "");
    if (!strategyId) throw new Error("strategyId is required");
    const strategy = resolveStrategyById(store, strategyId);
    if (!strategy) throw new Error("strategy not found");
    const rangeDays = normalizeRangeDays(params.rangeDays || 30);
    const tradeType = normalizeTradeType(params.tradeType || "all");
    const draftInput = params.draftConfig && typeof params.draftConfig === "object"
      ? params.draftConfig
      : (strategy.draftConfig && typeof strategy.draftConfig === "object" ? strategy.draftConfig : {});
    const draftConfig = buildStrategyDraftPayload(draftInput);
    const featureLookup = buildFeatureLookup(store.features || []);
    const lockedFeatureVersions = lockFeatureVersions(draftConfig?.signalLayer?.featureRefs || [], featureLookup);
    const out = runBacktestWithFallback({
      strategy: {
        ...strategy,
        draftConfig,
      },
      version: {
        strategyVersionId: "",
        strategyId: toText(strategy.strategyId || ""),
        versionNo: 0,
        versionTag: "draft_replay",
        signalLayer: draftConfig.signalLayer || {},
        positionLayer: draftConfig.positionLayer || {},
        riskLayer: draftConfig.riskLayer || {},
        executionLayer: draftConfig.executionLayer || {},
        lockedFeatureVersions,
      },
      features: store.features || [],
      bars: Array.isArray(params.bars) ? params.bars : [],
      rangeDays,
    });
    const executionReportRaw = out?.executionReport && typeof out.executionReport === "object"
      ? out.executionReport
      : null;
    const executionReport = enrichExecutionReportWithFeatureCatalog(executionReportRaw, lockedFeatureVersions);
    if (!executionReport) throw new Error("strategy replay failed");
    const summary = summarizeExecutionReport(executionReport, {
      latestReturnPct: Number(out?.summary?.latestReturnPct || 0) || 0,
      maxDrawdownPct: Number(out?.summary?.maxDrawdownPct || 0) || 0,
      tradeCount: Number(out?.summary?.tradeCount || 0) || 0,
    });
    const artifactResult = reportArtifact({
      source: toText(meta.source || "strategy_replay"),
      query: toText(meta.query || ""),
      label: toText(meta.label || (strategy.name + " · 回放")),
      config: {
        strategyId: strategyId,
        strategy: toText(strategy.name || strategyId),
        marketMode: "backtest",
        rangeDays,
        tradeType,
        tf: toText(params.tf || ""),
        bars: Math.max(0, Math.floor(Number(Array.isArray(params.bars) ? params.bars.length : 0))),
      },
      result: {
        strategyId: strategyId,
        strategy: toText(strategy.name || strategyId),
        marketMode: "backtest",
        tradeCount: Number(summary.tradeCount || 0) || 0,
        winRate: Number(out?.summary?.winRate || 0) || 0,
        netPnlPct: Number(summary.latestReturnPct || 0) || 0,
        maxDrawdownPct: Number(summary.maxDrawdownPct || 0) || 0,
        executionReport,
      },
    });
    const filtered = filterExecutionReport(executionReport, { rangeDays, tradeType });
    const replayEvents = enrichEventsWithReason(filtered.report.events || []);
    return {
      strategyId,
      artifactId: toText(artifactResult?.artifactId || ""),
      playbackId: "artifact:" + toText(artifactResult?.artifactId || ""),
      summary,
      visualization: {
        rangeDays: filtered.rangeDays,
        tradeType: filtered.tradeType,
        events: replayEvents,
        equityCurve: filtered.report.equityCurve || [],
        drawdownCurve: filtered.report.drawdownCurve || [],
        summary,
      },
    };
  }

  function listStrategies(options = {}) {
    const store = loadStore();
    const q = toText(options.q || "").toLowerCase();
    const statusRaw = toText(options.status || "").toLowerCase();
    const status = STRATEGY_STATUS_LABELS[statusRaw] ? statusRaw : "";
    const sortBy = normalizeStrategySortField(options.sortBy);
    const sortOrder = normalizeStrategySortOrder(options.sortOrder);
    const page = parsePositiveInt(options.page, 1, 1, 9999);
    const pageSize = parsePositiveInt(options.pageSize || options.limit, 20, 5, 100);
    let rows = Array.isArray(store.strategies) ? store.strategies.slice() : [];
    if (status) {
      rows = rows.filter((item) => normalizeStatus(item?.status || "draft") === status);
    }
    if (q) {
      rows = rows.filter((item) => {
        const textPack = [
          item?.strategyId,
          item?.name,
          item?.description,
          item?.status,
          item?.runtimeEnv,
          item?.currentVersionId,
        ].map((v) => String(v || "").toLowerCase()).join(" ");
        return textPack.includes(q);
      });
    }
    rows.sort((a, b) => {
      let cmp = 0;
      if (sortBy === "latestReturnPct" || sortBy === "maxDrawdownPct") {
        cmp = Number(a?.[sortBy] || 0) - Number(b?.[sortBy] || 0);
      } else if (sortBy === "name" || sortBy === "status") {
        cmp = String(a?.[sortBy] || "").localeCompare(String(b?.[sortBy] || ""));
      } else {
        cmp = String(a?.updatedAt || "").localeCompare(String(b?.updatedAt || ""));
      }
      if (cmp === 0) {
        cmp = String(b?.updatedAt || "").localeCompare(String(a?.updatedAt || ""));
      }
      return sortOrder === "asc" ? cmp : -cmp;
    });
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = Math.min(page, totalPages);
    const start = (normalizedPage - 1) * pageSize;
    const list = rows.slice(start, start + pageSize).map((item) => {
      const strategy = item && typeof item === "object" ? item : {};
      const statusKey = normalizeStatus(strategy.status || "draft");
      const runtimeEnv = normalizeRuntimeEnv(statusKey, strategy.runtimeEnv);
      return {
        strategyId: toText(strategy.strategyId || ""),
        name: toText(strategy.name || ""),
        description: toText(strategy.description || ""),
        status: statusKey,
        statusLabel: STRATEGY_STATUS_LABELS[statusKey] || statusKey,
        runtimeEnv: runtimeEnv,
        runtimeEnvLabel: STRATEGY_RUNTIME_ENV_LABELS[runtimeEnv] || runtimeEnv,
        latestReturnPct: Number(strategy.latestReturnPct || 0),
        maxDrawdownPct: Number(strategy.maxDrawdownPct || 0),
        featureCount: Math.max(0, Math.floor(Number(strategy.featureCount || 0))),
        currentVersionId: toText(strategy.currentVersionId || ""),
        latestVersionId: toText(strategy.latestVersionId || ""),
        createdAt: toText(strategy.createdAt || ""),
        updatedAt: toText(strategy.updatedAt || ""),
      };
    });
    return {
      total,
      page: normalizedPage,
      pageSize,
      totalPages,
      sortBy,
      sortOrder,
      strategies: list,
    };
  }

  function saveStrategyDraft(payloadLike = {}, metaLike = {}) {
    const store = loadStore();
    const payload = payloadLike && typeof payloadLike === "object" ? payloadLike : {};
    const meta = metaLike && typeof metaLike === "object" ? metaLike : {};
    const now = nowIso();
    const name = toText(payload.name || payload.title || "");
    if (!name) throw new Error("strategy name is required");
    const forceCreate = meta?.forceCreate === true;
    const allowNameMerge = meta?.allowNameMerge === true;
    let strategy = forceCreate
      ? null
      : (resolveStrategyById(store, payload.strategyId || "")
        || (allowNameMerge ? resolveStrategyByName(store, name) : null)
        || null);
    const requestedStatusRaw = toText(payload.status || "");
    const requestedStatus = requestedStatusRaw
      ? normalizeStatus(requestedStatusRaw, "draft")
      : normalizeStatus(strategy?.status || "draft", "draft");
    const draftConfig = buildStrategyDraftPayload(payload);
    const featureCount = normalizeFeatureRefs(draftConfig?.signalLayer?.featureRefs || []).length;
    const operator = toText(meta.operator || meta.createdBy || "ThunderClaw");
    if (!strategy) {
      strategy = {
        strategyId: nextId("stg", "strategy"),
        name,
        description: toText(payload.description || payload.summary || "策略草稿"),
        status: requestedStatus,
        runtimeEnv: normalizeRuntimeEnv(requestedStatus, payload.runtimeEnv),
        currentVersionId: "",
        latestVersionId: "",
        featureCount,
        latestReturnPct: 0,
        maxDrawdownPct: 0,
        draftConfig,
        cardBinding: null,
        runtimeReports: {},
        createdAt: now,
        updatedAt: now,
      };
      if (Number.isFinite(Number(meta.eventId)) && Number(meta.eventId) > 0 && toText(meta.cardId || "")) {
        strategy.cardBinding = {
          conversationId: toText(meta.conversationId || "thunderclaw-main"),
          eventId: Number(meta.eventId),
          cardId: toText(meta.cardId || ""),
          linkedAt: now,
        };
      }
      applyProvenanceMeta(strategy, meta, now, toText(meta.source || "chat_intent", "chat_intent"));
      store.strategies.push(strategy);
      appendStrategyAudit(store, {
        strategyId: strategy.strategyId,
        action: "create_draft",
        fromStatus: "",
        toStatus: strategy.status,
        operator,
        reason: toText(meta.reason || "创建策略草稿"),
        ts: now,
        detail: {
          name: strategy.name,
          featureCount,
        },
      });
      saveStore();
      return { created: true, strategy };
    }
    const fromStatus = normalizeStatus(strategy.status || "draft");
    strategy.name = name;
    strategy.description = toText(payload.description || strategy.description || "");
    strategy.status = requestedStatus || fromStatus;
    strategy.runtimeEnv = normalizeRuntimeEnv(strategy.status, payload.runtimeEnv || strategy.runtimeEnv);
    strategy.featureCount = featureCount;
    strategy.draftConfig = draftConfig;
    if (!strategy.runtimeReports || typeof strategy.runtimeReports !== "object") {
      strategy.runtimeReports = {};
    }
    strategy.updatedAt = now;
    if (Number.isFinite(Number(meta.eventId)) && Number(meta.eventId) > 0 && toText(meta.cardId || "")) {
      strategy.cardBinding = {
        conversationId: toText(meta.conversationId || strategy?.cardBinding?.conversationId || "thunderclaw-main"),
        eventId: Number(meta.eventId),
        cardId: toText(meta.cardId || ""),
        linkedAt: now,
      };
    }
    applyProvenanceMeta(strategy, meta, now, toText(meta.source || "chat_intent", "chat_intent"));
    appendStrategyAudit(store, {
      strategyId: strategy.strategyId,
      action: "save_draft",
      fromStatus,
      toStatus: strategy.status,
      operator,
      reason: toText(meta.reason || "更新策略草稿"),
      ts: now,
      detail: {
        featureCount,
      },
    });
    saveStore();
    return { created: false, strategy };
  }

  function publishStrategyVersion(paramsLike = {}, metaLike = {}) {
    const store = loadStore();
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const meta = metaLike && typeof metaLike === "object" ? metaLike : {};
    const strategy = resolveStrategyById(store, params.strategyId || "");
    if (!strategy) throw new Error("strategy not found");
    const now = nowIso();
    const statusBeforePublish = normalizeStatus(strategy.status || "draft");
    const operator = toText(meta.operator || meta.createdBy || "ThunderClaw");
    const draftConfig = strategy.draftConfig && typeof strategy.draftConfig === "object"
      ? strategy.draftConfig
      : buildStrategyDraftPayload({});
    const featureLookup = buildFeatureLookup(store.features || []);
    const lockedFeatureVersions = lockFeatureVersions(draftConfig?.signalLayer?.featureRefs || [], featureLookup);
    const versionNo = (store.strategyVersions || []).filter((item) => toText(item?.strategyId || "") === strategy.strategyId).length + 1;
    const strategyVersionId = nextId("stgver", "strategyVersion");
    const perfLike = params.performance && typeof params.performance === "object" ? params.performance : {};
    const engineRangeDays = normalizeRangeDays(params.rangeDays || 30);
    const engineOut = (() => {
      try {
        return runBacktestWithFallback({
          strategy,
          version: {
            strategyVersionId,
            strategyId: strategy.strategyId,
            versionNo,
            versionTag: `v${versionNo}.0.0`,
            signalLayer: draftConfig.signalLayer,
            positionLayer: draftConfig.positionLayer,
            riskLayer: draftConfig.riskLayer,
            executionLayer: draftConfig.executionLayer,
            lockedFeatureVersions,
          },
          features: store.features || [],
          rangeDays: engineRangeDays,
        });
      } catch {
        return null;
      }
    })();
    const engineSummary = engineOut?.summary && typeof engineOut.summary === "object" ? engineOut.summary : {};
    const engineReport = engineOut?.executionReport && typeof engineOut.executionReport === "object"
      ? engineOut.executionReport
      : null;
    const executionReportRaw = params.executionReport && typeof params.executionReport === "object"
      ? params.executionReport
      : (engineReport || buildSampleExecutionReport({ days: engineRangeDays, stepSec: 3600 }));
    const executionReport = enrichExecutionReportWithFeatureCatalog(executionReportRaw, lockedFeatureVersions);
    const latestReturnFallback = Number(clampNumber(engineSummary.latestReturnPct, -1000, 2000, strategy.latestReturnPct || 0).toFixed(4));
    const maxDrawdownFallback = Number(clampNumber(engineSummary.maxDrawdownPct, 0, 100, strategy.maxDrawdownPct || 0).toFixed(4));
    const winRateFallback = Number(clampNumber(engineSummary.winRate, 0, 100, 0).toFixed(4));
    const tradeCountFallback = Math.max(0, Math.floor(Number(engineSummary.tradeCount || 0)));
    const hasLatestReturn = Number.isFinite(Number(perfLike.latestReturnPct));
    const hasMaxDrawdown = Number.isFinite(Number(perfLike.maxDrawdownPct));
    const hasWinRate = Number.isFinite(Number(perfLike.winRate));
    const hasTradeCount = Number.isFinite(Number(perfLike.tradeCount));
    const latestReturnPct = hasLatestReturn
      ? Number(clampNumber(perfLike.latestReturnPct, -1000, 2000, latestReturnFallback).toFixed(4))
      : latestReturnFallback;
    const maxDrawdownPct = hasMaxDrawdown
      ? Number(clampNumber(perfLike.maxDrawdownPct, 0, 100, maxDrawdownFallback).toFixed(4))
      : maxDrawdownFallback;
    const version = {
      strategyVersionId,
      strategyId: strategy.strategyId,
      versionNo,
      immutable: true,
      publishState: "published",
      versionTag: `v${versionNo}.0.0`,
      createdAt: now,
      publishedAt: now,
      createdBy: operator,
      publishNote: toText(params.note || meta.reason || ""),
      lockedFeatureVersions,
      signalLayer: draftConfig.signalLayer,
      positionLayer: draftConfig.positionLayer,
      riskLayer: draftConfig.riskLayer,
      executionLayer: draftConfig.executionLayer,
      performance: {
        latestReturnPct,
        maxDrawdownPct,
        winRate: hasWinRate
          ? Number(clampNumber(perfLike.winRate, 0, 100, winRateFallback).toFixed(4))
          : winRateFallback,
        tradeCount: hasTradeCount
          ? Math.max(0, Math.floor(Number(perfLike.tradeCount || tradeCountFallback)))
          : tradeCountFallback,
        score: Number.isFinite(Number(perfLike.score)) ? Number(Number(perfLike.score).toFixed(4)) : null,
      },
      executionMeta: {
        engineName: toText(executionReport?.engine?.name || ""),
        engineMode: toText(executionReport?.engine?.mode || ""),
        rangeDays: engineRangeDays,
      },
      executionReport,
    };
    store.strategyVersions.push(version);
    strategy.latestVersionId = strategyVersionId;
    strategy.currentVersionId = strategyVersionId;
    strategy.updatedAt = now;
    strategy.featureCount = lockedFeatureVersions.length;
    strategy.latestReturnPct = latestReturnPct;
    strategy.maxDrawdownPct = maxDrawdownPct;
    if (!strategy.runtimeReports || typeof strategy.runtimeReports !== "object") {
      strategy.runtimeReports = {};
    }
    strategy.runtimeReports.backtest = {
      mode: "backtest",
      source: "publish_version",
      updatedAt: now,
      strategyVersionId,
      executionReport,
      positionSummary: {
        mode: "backtest",
        state: "completed",
        note: "来自最新发布版本回测结果",
      },
    };
    if (strategy.status === "draft" || strategy.status === "backtested") {
      strategy.status = "backtested";
      strategy.runtimeEnv = STRATEGY_RUNTIME_ENV_BY_STATUS.backtested;
    }
    appendStrategyAudit(store, {
      strategyId: strategy.strategyId,
      strategyVersionId,
      action: "publish_version",
      fromStatus: statusBeforePublish,
      toStatus: toText(strategy.status || ""),
      operator,
      reason: toText(params.note || meta.reason || "发布新版本"),
      ts: now,
      detail: {
        versionNo,
        versionTag: version.versionTag,
        featureLocks: lockedFeatureVersions,
      },
    });
    saveStore();
    return { strategy, version };
  }

  function updateStrategyStatus(paramsLike = {}, metaLike = {}) {
    const store = loadStore();
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const meta = metaLike && typeof metaLike === "object" ? metaLike : {};
    const strategy = resolveStrategyById(store, params.strategyId || "");
    if (!strategy) throw new Error("strategy not found");
    const now = nowIso();
    const fromStatus = normalizeStatus(strategy.status || "draft");
    const toStatus = normalizeStatus(params.targetStatus || params.status || fromStatus, fromStatus);
    if (!canTransitionStatus(fromStatus, toStatus)) {
      throw new Error(`invalid status transition: ${fromStatus} -> ${toStatus}`);
    }
    strategy.status = toStatus;
    strategy.runtimeEnv = normalizeRuntimeEnv(toStatus, params.runtimeEnv || strategy.runtimeEnv);
    strategy.updatedAt = now;
    if (!strategy.runtimeReports || typeof strategy.runtimeReports !== "object") {
      strategy.runtimeReports = {};
    }
    const versions = resolveStrategyVersions(store, strategy.strategyId);
    const currentVersionId = toText(strategy.currentVersionId || strategy.latestVersionId || "");
    const preferredVersion = versions.find((item) => toText(item?.strategyVersionId || "") === currentVersionId) || versions[0] || null;
    const baseReport = preferredVersion
      ? resolveVersionBacktestExecutionReport(store, strategy, preferredVersion, 30)
      : buildStableSampleReport(strategy, toStatus, 30, Number(versions.length || 1));
    if (toStatus === "paper_live") {
      strategy.runtimeReports.paper = {
        mode: "paper",
        source: "status_transition",
        updatedAt: now,
        startedAt: toText(strategy.runtimeReports.paper?.startedAt || now),
        strategyVersionId: toText(preferredVersion?.strategyVersionId || ""),
        executionReport: baseReport,
        positionSummary: {
          mode: "paper",
          state: "running",
          note: "模拟盘运行中（策略状态驱动）",
        },
      };
    } else if (toStatus === "live" || toStatus === "risk_paused") {
      strategy.runtimeReports.live = {
        mode: "live",
        source: "status_transition",
        updatedAt: now,
        startedAt: toText(strategy.runtimeReports.live?.startedAt || now),
        strategyVersionId: toText(preferredVersion?.strategyVersionId || ""),
        executionReport: baseReport,
        positionSummary: {
          mode: "live",
          state: toStatus === "risk_paused" ? "risk_paused" : "running",
          note: toStatus === "risk_paused" ? "触发风控暂停" : "实盘运行中（策略状态驱动）",
        },
      };
    } else if (toStatus === "paused") {
      if (strategy.runtimeReports.paper && typeof strategy.runtimeReports.paper === "object") {
        strategy.runtimeReports.paper = {
          ...strategy.runtimeReports.paper,
          updatedAt: now,
          positionSummary: {
            ...(strategy.runtimeReports.paper.positionSummary && typeof strategy.runtimeReports.paper.positionSummary === "object"
              ? strategy.runtimeReports.paper.positionSummary
              : {}),
            mode: "paper",
            state: "paused",
            note: "策略已暂停",
          },
        };
      }
      if (strategy.runtimeReports.live && typeof strategy.runtimeReports.live === "object") {
        strategy.runtimeReports.live = {
          ...strategy.runtimeReports.live,
          updatedAt: now,
          positionSummary: {
            ...(strategy.runtimeReports.live.positionSummary && typeof strategy.runtimeReports.live.positionSummary === "object"
              ? strategy.runtimeReports.live.positionSummary
              : {}),
            mode: "live",
            state: "paused",
            note: "策略已暂停",
          },
        };
      }
    } else if (toStatus === "backtested" || toStatus === "draft") {
      strategy.runtimeReports.backtest = {
        mode: "backtest",
        source: "status_transition",
        updatedAt: now,
        strategyVersionId: toText(preferredVersion?.strategyVersionId || ""),
        executionReport: baseReport,
        positionSummary: {
          mode: "backtest",
          state: "ready",
          note: "回测视图已更新",
        },
      };
    }
    appendStrategyAudit(store, {
      strategyId: strategy.strategyId,
      strategyVersionId: toText(strategy.currentVersionId || ""),
      action: toText(params.action || "change_status"),
      fromStatus,
      toStatus,
      operator: toText(meta.operator || meta.createdBy || "ThunderClaw"),
      reason: toText(params.reason || meta.reason || ""),
      ts: now,
      detail: {
        runtimeEnv: strategy.runtimeEnv,
      },
    });
    saveStore();
    return { strategy };
  }

  function listStrategyAudits(options = {}) {
    const store = loadStore();
    const strategyId = toText(options.strategyId || "");
    if (!strategyId) return { total: 0, audits: [] };
    const limit = Math.max(1, Math.min(300, Number(options.limit) || 120));
    const rows = (store.strategyAudits || [])
      .filter((item) => toText(item?.strategyId || "") === strategyId)
      .slice()
      .sort((a, b) => String(b?.ts || "").localeCompare(String(a?.ts || "")));
    return {
      total: rows.length,
      audits: rows.slice(0, limit),
    };
  }


  function buildFeatureCodePreviewFromLayers(featureRefsLike = [], signalLayerLike = {}) {
    const refs = normalizeFeatureRefs(featureRefsLike || []);
    const signalLayer = signalLayerLike && typeof signalLayerLike === "object" ? signalLayerLike : {};
    const params = signalLayer.params && typeof signalLayer.params === "object" ? signalLayer.params : {};
    const dynamicSpecs = Array.isArray(params.dynamicFeatureSpecs) ? params.dynamicFeatureSpecs : [];
    const dynByRef = new Map();
    dynamicSpecs.forEach((itemLike) => {
      const item = itemLike && typeof itemLike === "object" ? itemLike : {};
      const ref = slugify(item.ref || "");
      if (!ref) return;
      dynByRef.set(ref, item);
    });
    return refs.map((ref, index) => {
      const dyn = dynByRef.get(slugify(ref)) || {};
      const lower = toText(ref || "").toLowerCase();
      const inferredSourceType = lower.includes("polymarket") || lower.includes("prediction")
        ? "prediction"
        : (lower.includes("twitter") || lower.includes("social") || lower.includes("x_")
          ? "social"
          : ((lower.includes("news") || lower.includes("headline") || lower.includes("sentiment")) ? "news" : ""));
      const inferredProvider = inferredSourceType === "prediction"
        ? "polymarket"
        : (inferredSourceType === "social" ? "twitter" : (inferredSourceType === "news" ? "coindesk" : ""));
      let formula = "momentum";
      if (lower.includes("ema") || lower.includes("trend")) formula = "trend_ema";
      else if (lower.includes("adx")) formula = "adx_strength";
      else if (lower.includes("rsi")) formula = "rsi_bias";
      else if (lower.includes("atr") || lower.includes("volatility")) formula = "atr_guard";
      else if (lower.includes("risk") || lower.includes("drawdown") || lower.includes("stop")) formula = "risk_guard";
      else if (lower.includes("position") || lower.includes("exposure") || lower.includes("sizing")) formula = "position_cap";
      else if (lower.includes("execution") || lower.includes("slippage") || lower.includes("fee")) formula = "execution_cost";
      else if (lower.includes("news") || lower.includes("social") || lower.includes("twitter") || lower.includes("prediction") || lower.includes("polymarket")) formula = "external";
      const externalDefaultExpr = {
        news: "dataframe['{col}'] = dataframe['{col}'].rolling(3).mean().fillna(dataframe['{col}']).clip(-1, 1)",
        social: "dataframe['{col}'] = dataframe['{col}'].ewm(span=5, adjust=False).mean().clip(-1, 1)",
        prediction: "dataframe['{col}'] = dataframe['{col}'].fillna(0.0).clip(-1, 1)",
      }[inferredSourceType] || "map(external_series_by_ref[feature_ref], candle_time)";
      const expression = toText(dyn.pythonIndicator || "") || ({
        trend_ema: "((ema_fast - ema_slow) / close).clip(-1, 1)",
        adx_strength: "((adx - 20.0) / 25.0).clip(0, 1)",
        rsi_bias: "((rsi - 50.0) / 50.0).clip(-1, 1)",
        atr_guard: "(0.7 - atr_pct * 25.0).clip(-1, 1)",
        risk_guard: "(0.8 - abs(ret_1) * 20.0).clip(-1, 1)",
        position_cap: "(0.6 - abs(ret_1) * 12.0).clip(-1, 1)",
        execution_cost: "(0.75 - atr_pct * 20.0).clip(-1, 1)",
        external: externalDefaultExpr,
      }[formula] || "(ret_1 * 12.0).clip(-1, 1)");
      return {
        featureRef: ref,
        column: `tc_feat_${index}`,
        formula,
        sourceType: toText(dyn.sourceType || inferredSourceType),
        provider: toText(dyn.provider || inferredProvider),
        sourceUrl: toText(dyn.url || ""),
        expression,
      };
    });
  }

  function getStrategyDetail(options = {}) {
    const store = loadStore();
    const strategyId = toText(options.strategyId || "");
    if (!strategyId) throw new Error("strategyId is required");
    const strategy = resolveStrategyById(store, strategyId);
    if (!strategy) throw new Error("strategy not found");
    const rangeDays = normalizeRangeDays(options.rangeDays || 30);
    const tradeType = normalizeTradeType(options.tradeType || "all");
    const tradingMode = normalizeTradingMode(options.tradingMode || options.marketMode || "", strategy.status || "draft");
    const specifiedVersionId = toText(options.strategyVersionId || "");
    const specifiedPlaybackId = toText(options.playbackId || "");
    const versions = resolveStrategyVersions(store, strategyId);
    let version = specifiedVersionId
      ? resolveStrategyVersionById(store, specifiedVersionId)
      : null;
    if (!version || toText(version?.strategyId || "") !== strategyId) {
      const preferredVersionId = toText(strategy.currentVersionId || strategy.latestVersionId || "");
      version = preferredVersionId
        ? resolveStrategyVersionById(store, preferredVersionId)
        : null;
    }
    if (!version && versions.length) {
      version = versions[0];
    }
    const backtestPlaybacksRaw = buildBacktestPlaybackRows(store, strategy, versions, rangeDays);
    let selectedPlayback = specifiedPlaybackId
      ? backtestPlaybacksRaw.find((item) => toText(item?.playbackId || "") === specifiedPlaybackId) || null
      : null;
    if (!selectedPlayback && specifiedVersionId) {
      selectedPlayback = backtestPlaybacksRaw.find((item) => toText(item?.strategyVersionId || "") === specifiedVersionId) || null;
    }
    if (!selectedPlayback && backtestPlaybacksRaw.length) {
      selectedPlayback = backtestPlaybacksRaw[0];
    }
    let runtimeMeta = {
      source: "",
      updatedAt: "",
      positionSummary: {},
      selectedPlaybackId: "",
    };
    let reportRaw = null;
    if (tradingMode === "backtest") {
      if (selectedPlayback) {
        reportRaw = selectedPlayback.executionReport;
        runtimeMeta = {
          source: toText(selectedPlayback.source || "backtest_playback"),
          updatedAt: toText(selectedPlayback.updatedAt || selectedPlayback.createdAt || strategy.updatedAt || ""),
          positionSummary: {
            mode: "backtest",
            state: "completed",
            note: "当前展示所选回测回放结果",
          },
          selectedPlaybackId: toText(selectedPlayback.playbackId || ""),
        };
        const playbackVersionId = toText(selectedPlayback.strategyVersionId || "");
        if (playbackVersionId) {
          const playbackVersion = resolveStrategyVersionById(store, playbackVersionId);
          if (playbackVersion && toText(playbackVersion?.strategyId || "") === strategyId) {
            version = playbackVersion;
          }
        }
      } else if (version) {
        reportRaw = resolveVersionBacktestExecutionReport(store, strategy, version, rangeDays);
        runtimeMeta = {
          source: "strategy_version",
          updatedAt: toText(version.publishedAt || version.createdAt || strategy.updatedAt || ""),
          positionSummary: {
            mode: "backtest",
            state: "completed",
            note: "当前展示策略版本回测结果",
          },
          selectedPlaybackId: "",
        };
      } else {
        reportRaw = buildStableSampleReport(strategy, "backtest", rangeDays);
        runtimeMeta = {
          source: "fallback_sample",
          updatedAt: toText(strategy.updatedAt || strategy.createdAt || ""),
          positionSummary: {
            mode: "backtest",
            state: "seeded",
            note: "暂无回测记录，显示稳定样本。",
          },
          selectedPlaybackId: "",
        };
      }
    } else {
      const modeReport = buildRuntimeModeReport(store, strategy, versions, tradingMode, rangeDays);
      reportRaw = modeReport.executionReport;
      runtimeMeta = {
        source: toText(modeReport.source || ""),
        updatedAt: toText(modeReport.updatedAt || strategy.updatedAt || ""),
        positionSummary: modeReport.positionSummary && typeof modeReport.positionSummary === "object"
          ? modeReport.positionSummary
          : {},
        selectedPlaybackId: "",
      };
    }
    if (!reportRaw || typeof reportRaw !== "object") {
      reportRaw = buildStableSampleReport(strategy, tradingMode, rangeDays);
    }
    const filtered = filterExecutionReport(reportRaw, { rangeDays, tradeType });
    const report = filtered.report;
    const events = enrichEventsWithReason(Array.isArray(report.events) ? report.events : []);
    const summary = summarizeExecutionReport(report, version?.performance || {});
    const sourceKey = toText(strategy.source || "", "unknown");
    const sourceLabel = sourceKey === "chat_intent"
      ? "ThunderClaw 对话"
      : (sourceKey === "strategy_console"
        ? "策略运营控制台"
        : (sourceKey === "manual_propose" ? "手动提案" : sourceKey));
    const lockRows = Array.isArray(version?.lockedFeatureVersions) ? version.lockedFeatureVersions : [];
    const lockLookup = new Map();
    lockRows.forEach((item) => {
      const key = toText(item?.featureId || item?.featureName || "");
      if (!key) return;
      lockLookup.set(key, item);
      lockLookup.set(toText(item?.featureName || ""), item);
    });
    const featuresByKey = new Map();
    (store.features || []).forEach((itemLike) => {
      const item = itemLike && typeof itemLike === "object" ? itemLike : {};
      const idKey = toText(item.featureId || "");
      const nameKey = toText(item.name || item.featureName || "");
      if (idKey) {
        featuresByKey.set(idKey, item);
        featuresByKey.set(slugify(idKey), item);
      }
      if (nameKey) {
        featuresByKey.set(nameKey, item);
        featuresByKey.set(slugify(nameKey), item);
      }
    });
    const featureRefs = normalizeFeatureRefs(
      version?.signalLayer?.featureRefs
      || strategy?.draftConfig?.signalLayer?.featureRefs
      || [],
    );
    const featureRelations = featureRefs.map((ref) => {
      const lock = lockLookup.get(ref) || null;
      const featureMeta = featuresByKey.get(ref) || featuresByKey.get(slugify(ref)) || null;
      const featureGroup = toText(featureMeta?.group || "", "").toLowerCase();
      const mainCategory = toText(featureMeta?.mainCategory || "", "");
      const mainCategoryConfig = MAIN_CATEGORY_CONFIG[mainCategory] || null;
      const outputType = toText(featureMeta?.outputType || "", "");
      const outputTypeLabel = OUTPUT_TYPE_CONFIG[outputType]?.label || outputType || "";
      const tags = Array.isArray(featureMeta?.tags) ? featureMeta.tags.slice(0, 3) : [];
      const tagLabels = tags.map((tag) => TAG_CONFIG[tag]?.label || tag).filter(Boolean);
      const relationType = inferFeatureRelationType(ref, featureMeta);
      return {
        featureRef: ref,
        featureId: toText(lock?.featureId || ref),
        featureName: toText(lock?.featureName || featureMeta?.name || ref),
        featureVersion: toText(lock?.featureVersion || "v1.0.0"),
        relationType,
        featureGroup,
        mainCategory: mainCategory,
        mainCategoryLabel: toText(mainCategoryConfig?.label || "未分类"),
        kind: toText(featureMeta?.kind || ""),
        outputType: outputType,
        outputTypeLabel: outputTypeLabel,
        tags,
        tagLabels,
      };
    });
    const detailsLayers = {
      signalLayer: version?.signalLayer && typeof version.signalLayer === "object"
        ? version.signalLayer
        : (strategy?.draftConfig?.signalLayer || {}),
      positionLayer: version?.positionLayer && typeof version.positionLayer === "object"
        ? version.positionLayer
        : (strategy?.draftConfig?.positionLayer || {}),
      riskLayer: version?.riskLayer && typeof version.riskLayer === "object"
        ? version.riskLayer
        : (strategy?.draftConfig?.riskLayer || {}),
      executionLayer: version?.executionLayer && typeof version.executionLayer === "object"
        ? version.executionLayer
        : (strategy?.draftConfig?.executionLayer || {}),
    };
    const backtestPlaybacks = backtestPlaybacksRaw.map((item) => ({
      playbackId: toText(item?.playbackId || ""),
      marketMode: "backtest",
      source: toText(item?.source || ""),
      strategyVersionId: toText(item?.strategyVersionId || ""),
      label: toText(item?.label || ""),
      createdAt: toText(item?.createdAt || ""),
      updatedAt: toText(item?.updatedAt || ""),
      tradeCount: Math.max(0, Math.floor(Number(item?.tradeCount || 0))),
      latestReturnPct: Number(Number(item?.latestReturnPct || 0).toFixed(4)),
      maxDrawdownPct: Number(Number(item?.maxDrawdownPct || 0).toFixed(4)),
      selected: toText(item?.playbackId || "") === toText(runtimeMeta.selectedPlaybackId || ""),
    }));
    const runtimeBacktestMeta = report?.backtestMeta && typeof report.backtestMeta === "object"
      ? report.backtestMeta
      : {};
    const generatedFeatureCode = Array.isArray(runtimeBacktestMeta.featureCode) && runtimeBacktestMeta.featureCode.length
      ? runtimeBacktestMeta.featureCode
      : buildFeatureCodePreviewFromLayers(featureRefs, detailsLayers.signalLayer);
    const signalDiagnostics = runtimeBacktestMeta.signalDiagnostics && typeof runtimeBacktestMeta.signalDiagnostics === "object"
      ? runtimeBacktestMeta.signalDiagnostics
      : {};
    return {
      strategy: {
        ...strategy,
        status: normalizeStatus(strategy.status || "draft"),
        statusLabel: STRATEGY_STATUS_LABELS[normalizeStatus(strategy.status || "draft")] || normalizeStatus(strategy.status || "draft"),
        runtimeEnv: normalizeRuntimeEnv(strategy.status || "draft", strategy.runtimeEnv),
        runtimeEnvLabel: STRATEGY_RUNTIME_ENV_LABELS[normalizeRuntimeEnv(strategy.status || "draft", strategy.runtimeEnv)] || strategy.runtimeEnv,
        source: sourceKey,
        sourceLabel,
      },
      version: version || null,
      details: {
        expression: toText(detailsLayers.signalLayer?.signalLogic || "未配置策略表达式"),
        featureRelations,
        layers: detailsLayers,
        generatedFeatureCode,
      },
      trading: {
        mode: tradingMode,
        modeLabel: tradingMode === "live" ? "实盘交易" : (tradingMode === "paper" ? "模拟交易" : "回测交易"),
        source: runtimeMeta.source,
        updatedAt: runtimeMeta.updatedAt,
        positionSummary: runtimeMeta.positionSummary,
        selectedPlaybackId: toText(runtimeMeta.selectedPlaybackId || ""),
        backtestPlaybacks,
        playbackTotal: backtestPlaybacks.length,
        summary,
        signalDiagnostics,
      },
      visualization: {
        rangeDays: filtered.rangeDays,
        tradeType: filtered.tradeType,
        mode: tradingMode,
        events,
        equityCurve: report.equityCurve || [],
        drawdownCurve: report.drawdownCurve || [],
        summary,
        playback: {
          minSpeedMs: 180,
          defaultSpeedMs: 520,
        },
      },
      labels: {
        status: STRATEGY_STATUS_LABELS,
        runtimeEnv: STRATEGY_RUNTIME_ENV_LABELS,
        tradeType: TRADE_TYPE_LABELS,
      },
    };
  }


  function deleteFeature(paramsLike = {}, metaLike = {}) {
    const store = loadStore();
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const meta = metaLike && typeof metaLike === "object" ? metaLike : {};
    const targetId = toText(params.featureId || params.id || "");
    const targetName = toText(params.featureName || params.name || params.featureRef || "");
    const targetSlug = slugify(targetId || targetName);
    if (!targetId && !targetSlug) throw new Error("featureId or featureName is required");

    const features = Array.isArray(store.features) ? store.features : [];
    const targetFeature = features.find((rowLike) => {
      const row = rowLike && typeof rowLike === "object" ? rowLike : {};
      const featureId = toText(row.featureId || "");
      const featureName = toText(row.name || "");
      if (targetId && featureId && featureId === targetId) return true;
      const candidates = [featureId, featureName].map((v) => slugify(v)).filter(Boolean);
      return targetSlug ? candidates.includes(targetSlug) : false;
    }) || null;
    if (!targetFeature) throw new Error("feature not found");

    const matchSlugs = new Set(
      [
        toText(targetFeature.featureId || ""),
        toText(targetFeature.name || ""),
      ].map((v) => slugify(v)).filter(Boolean),
    );
    const removeRefs = (refsLike) => {
      const refs = normalizeFeatureRefs(refsLike || []);
      return refs.filter((ref) => !matchSlugs.has(slugify(ref)));
    };

    store.features = features.filter((rowLike) => {
      const row = rowLike && typeof rowLike === "object" ? rowLike : {};
      const featureId = toText(row.featureId || "");
      if (targetId && featureId && featureId === targetId) return false;
      return !matchSlugs.has(slugify(featureId || row.name || ""));
    });

    let affectedVersionCount = 0;
    store.versions = (Array.isArray(store.versions) ? store.versions : []).map((rowLike) => {
      const row = rowLike && typeof rowLike === "object" ? rowLike : {};
      const strategy = row.strategy && typeof row.strategy === "object" ? row.strategy : null;
      if (!strategy) return row;
      const before = normalizeFeatureRefs(strategy.featureRefs || []);
      const after = removeRefs(before);
      if (after.length === before.length) return row;
      affectedVersionCount += 1;
      return {
        ...row,
        strategy: {
          ...strategy,
          featureRefs: after,
        },
      };
    });

    let affectedStrategyCount = 0;
    store.strategies = (Array.isArray(store.strategies) ? store.strategies : []).map((rowLike) => {
      const row = rowLike && typeof rowLike === "object" ? rowLike : {};
      const draftConfig = row.draftConfig && typeof row.draftConfig === "object" ? row.draftConfig : null;
      if (!draftConfig) return row;
      const signalLayer = draftConfig.signalLayer && typeof draftConfig.signalLayer === "object"
        ? draftConfig.signalLayer
        : {};
      const before = normalizeFeatureRefs(signalLayer.featureRefs || []);
      const after = removeRefs(before);
      if (after.length === before.length) return row;
      affectedStrategyCount += 1;
      return {
        ...row,
        featureCount: after.length,
        updatedAt: nowIso(),
        draftConfig: {
          ...draftConfig,
          signalLayer: {
            ...signalLayer,
            featureRefs: after,
          },
        },
      };
    });

    let affectedStrategyVersionCount = 0;
    store.strategyVersions = (Array.isArray(store.strategyVersions) ? store.strategyVersions : []).map((rowLike) => {
      const row = rowLike && typeof rowLike === "object" ? rowLike : {};
      const signalLayer = row.signalLayer && typeof row.signalLayer === "object" ? row.signalLayer : {};
      const before = normalizeFeatureRefs(signalLayer.featureRefs || []);
      const after = removeRefs(before);
      const lockedBefore = Array.isArray(row.lockedFeatureVersions) ? row.lockedFeatureVersions : [];
      const lockedAfter = lockedBefore.filter((itemLike) => {
        const item = itemLike && typeof itemLike === "object" ? itemLike : {};
        const featureId = slugify(item.featureId || item.featureName || "");
        return featureId ? !matchSlugs.has(featureId) : true;
      });
      const changed = after.length !== before.length || lockedAfter.length !== lockedBefore.length;
      if (!changed) return row;
      affectedStrategyVersionCount += 1;
      return {
        ...row,
        signalLayer: {
          ...signalLayer,
          featureRefs: after,
        },
        lockedFeatureVersions: lockedAfter,
      };
    });

    executionReportCache.clear();

    appendStrategyAudit(store, {
      strategyId: "",
      strategyVersionId: "",
      action: "feature_deleted",
      fromStatus: "",
      toStatus: "",
      operator: toText(meta.operator || meta.createdBy || "ThunderClaw"),
      reason: toText(meta.reason || "删除交易特征"),
      detail: {
        featureId: toText(targetFeature.featureId || ""),
        featureName: toText(targetFeature.name || ""),
        affectedVersionCount,
        affectedStrategyCount,
        affectedStrategyVersionCount,
      },
    });

    saveStore();
    return {
      ok: true,
      featureId: toText(targetFeature.featureId || ""),
      featureName: toText(targetFeature.name || ""),
      affectedVersionCount,
      affectedStrategyCount,
      affectedStrategyVersionCount,
    };
  }

  function deleteStrategy(paramsLike = {}, metaLike = {}) {
    const store = loadStore();
    const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
    const meta = metaLike && typeof metaLike === "object" ? metaLike : {};
    const strategyId = toText(params.strategyId || params.id || "");
    if (!strategyId) throw new Error("strategyId is required");

    const strategies = Array.isArray(store.strategies) ? store.strategies : [];
    const target = strategies.find((item) => toText(item?.strategyId || "") === strategyId) || null;
    if (!target) throw new Error("strategy not found");

    const versionIds = new Set(
      (Array.isArray(store.strategyVersions) ? store.strategyVersions : [])
        .filter((row) => toText(row?.strategyId || "") === strategyId)
        .map((row) => toText(row?.strategyVersionId || ""))
        .filter(Boolean),
    );

    const beforeStrategyVersionCount = Array.isArray(store.strategyVersions) ? store.strategyVersions.length : 0;
    const beforeAuditCount = Array.isArray(store.strategyAudits) ? store.strategyAudits.length : 0;
    const beforeArtifactCount = Array.isArray(store.artifacts) ? store.artifacts.length : 0;

    store.strategies = strategies.filter((item) => toText(item?.strategyId || "") !== strategyId);
    store.strategyVersions = (Array.isArray(store.strategyVersions) ? store.strategyVersions : [])
      .filter((row) => toText(row?.strategyId || "") !== strategyId);
    store.strategyAudits = (Array.isArray(store.strategyAudits) ? store.strategyAudits : [])
      .filter((row) => toText(row?.strategyId || "") !== strategyId);
    store.artifacts = (Array.isArray(store.artifacts) ? store.artifacts : []).filter((rowLike) => {
      const row = rowLike && typeof rowLike === "object" ? rowLike : {};
      const config = row.config && typeof row.config === "object" ? row.config : {};
      const result = row.result && typeof row.result === "object" ? row.result : {};
      const artifactStrategyId = toText(config.strategyId || result.strategyId || "");
      const artifactVersionId = toText(config.strategyVersionId || result.strategyVersionId || "");
      if (artifactStrategyId && artifactStrategyId === strategyId) return false;
      if (artifactVersionId && versionIds.has(artifactVersionId)) return false;
      return true;
    });

    executionReportCache.clear();

    appendStrategyAudit(store, {
      strategyId: "",
      strategyVersionId: "",
      action: "strategy_deleted",
      fromStatus: toText(target.status || ""),
      toStatus: "deleted",
      operator: toText(meta.operator || meta.createdBy || "ThunderClaw"),
      reason: toText(meta.reason || "删除策略"),
      detail: {
        deletedStrategyId: strategyId,
        deletedStrategyName: toText(target.name || ""),
        removedStrategyVersionCount: Math.max(0, beforeStrategyVersionCount - store.strategyVersions.length),
        removedAuditCount: Math.max(0, beforeAuditCount - store.strategyAudits.length),
        removedArtifactCount: Math.max(0, beforeArtifactCount - store.artifacts.length),
      },
    });

    saveStore();
    return {
      ok: true,
      strategyId,
      strategyName: toText(target.name || ""),
      removedStrategyVersionCount: Math.max(0, beforeStrategyVersionCount - store.strategyVersions.length),
      removedAuditCount: Math.max(0, beforeAuditCount - store.strategyAudits.length),
      removedArtifactCount: Math.max(0, beforeArtifactCount - store.artifacts.length),
    };
  }

  function getStats() {
    const store = loadStore();
    return {
      featureCount: Array.isArray(store.features) ? store.features.length : 0,
      versionCount: Array.isArray(store.versions) ? store.versions.length : 0,
      artifactCount: Array.isArray(store.artifacts) ? store.artifacts.length : 0,
      strategyCount: Array.isArray(store.strategies) ? store.strategies.length : 0,
      strategyVersionCount: Array.isArray(store.strategyVersions) ? store.strategyVersions.length : 0,
      strategyAuditCount: Array.isArray(store.strategyAudits) ? store.strategyAudits.length : 0,
      updatedAt: String(store.updatedAt || ""),
    };
  }

  return {
    listFeatures,
    getFeatureFacets,
    listVersions,
    listStrategies,
    getStrategyDetail,
    listStrategyAudits,
    saveStrategyDraft,
    publishStrategyVersion,
    updateStrategyStatus,
    applyIntentCandidate,
    proposeVersionsFromMessage,
    evaluateVersion,
    reportArtifact,
    runStrategyReplay,
    deleteFeature,
    deleteStrategy,
    getStats,
  };
}
