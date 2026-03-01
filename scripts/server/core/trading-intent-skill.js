import { spawnSync } from "node:child_process";
import { runHeuristicIntentSkills } from "./intent-skills/index.js";

function clampNumber(valueLike, min, max, fallback = 0) {
  const n = Number(valueLike);
  if (!Number.isFinite(n)) return fallback;
  if (Number.isFinite(min) && n < min) return min;
  if (Number.isFinite(max) && n > max) return max;
  return n;
}

function toText(valueLike, fallback = "") {
  const s = String(valueLike ?? "").trim();
  return s || fallback;
}

function uniqStrings(valuesLike) {
  const rows = Array.isArray(valuesLike) ? valuesLike : [];
  const set = new Set();
  rows.forEach((item) => {
    const v = String(item ?? "").trim();
    if (v) set.add(v);
  });
  return Array.from(set);
}

function buildDynamicSignalPlan(textLike = "", featureCandidatesLike = []) {
  const text = toText(textLike).toLowerCase();
  const featureCandidates = Array.isArray(featureCandidatesLike) ? featureCandidatesLike : [];
  const featureSpecs = [];
  const requiredInputs = [];

  featureCandidates.forEach((itemLike) => {
    const feature = itemLike?.feature && typeof itemLike.feature === "object" ? itemLike.feature : {};
    const ref = toText(feature.name || "").toLowerCase();
    if (!ref) return;
    const kind = toText(feature.kind || "").toLowerCase();
    const params = feature.params && typeof feature.params === "object" ? feature.params : {};
    const spec = {
      ref,
      sourceType: toText(params.sourceType || "").toLowerCase(),
      provider: toText(params.provider || "").toLowerCase(),
      url: toText(params.url || ""),
      urlTemplate: toText(params.urlTemplate || ""),
      query: toText(params.query || ""),
      pythonIndicator: toText(params.pythonIndicator || ""),
      pipelineCode: toText(params.pipelineCode || ""),
    };
    if (ref.includes("social") || ref.includes("twitter") || ref.includes("x_") || kind.includes("social")) {
      spec.sourceType = spec.sourceType || "social";
      spec.provider = spec.provider || "twitter";
      spec.urlTemplate = toText(spec.urlTemplate || "https://api.github.com/search/issues?q={query}&sort=updated&order=desc&per_page=30");
      spec.query = spec.query || (text.includes("eth") ? "ETH lang:en" : "BTC lang:en");
    } else if (ref.includes("polymarket") || ref.includes("prediction") || kind.includes("prediction")) {
      spec.sourceType = spec.sourceType || "prediction";
      spec.provider = spec.provider || "polymarket";
    } else if (ref.includes("news") || ref.includes("sentiment")) {
      spec.sourceType = spec.sourceType || "news";
      if (text.includes("律动") || text.includes("blockbeats")) {
        spec.provider = spec.provider || "blockbeats";
      } else if (text.includes("金色") || text.includes("jinse")) {
        spec.provider = spec.provider || "jinse";
      } else if (text.includes("coindesk")) {
        spec.provider = spec.provider || "coindesk";
      } else {
        spec.provider = spec.provider || "coindesk";
      }
    }
    if (spec.sourceType || spec.provider || spec.url || spec.pythonIndicator || spec.pipelineCode) {
      featureSpecs.push(spec);
    }
  });
  return {
    dynamicFeatureSpecs: featureSpecs,
    requiredInputs,
  };
}

function sanitizeDynamicFeatureSpecs(rowsLike = []) {
  const rows = Array.isArray(rowsLike) ? rowsLike : [];
  return rows
    .map((itemLike) => {
      const item = itemLike && typeof itemLike === "object" ? itemLike : {};
      const ref = toText(item.ref || "").toLowerCase();
      if (!ref) return null;
      return {
        ref,
        sourceType: toText(item.sourceType || "").toLowerCase(),
        provider: toText(item.provider || "").toLowerCase(),
        url: toText(item.url || item.endpoint || ""),
        urlTemplate: toText(item.urlTemplate || ""),
        query: toText(item.query || ""),
        pythonIndicator: toText(item.pythonIndicator || ""),
        pipelineCode: toText(item.pipelineCode || ""),
      };
    })
    .filter(Boolean)
    .slice(0, 24);
}

function sanitizeRequiredInputs(rowsLike = []) {
  const rows = Array.isArray(rowsLike) ? rowsLike : [];
  return rows
    .map((itemLike) => {
      const item = itemLike && typeof itemLike === "object" ? itemLike : {};
      return {
        key: toText(item.key || ""),
        label: toText(item.label || ""),
        type: toText(item.type || "text"),
        required: item.required !== false,
      };
    })
    .filter((item) => item.key && item.label)
    .slice(0, 16);
}

function parseJsonLoose(textLike) {
  const text = String(textLike ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(String(fencedMatch[1]).trim());
    } catch {}
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  return null;
}


function hasExternalDataFetchPattern(codeLike = "") {
  const code = toText(codeLike || "").toLowerCase();
  if (!code) return false;
  const markers = [
    "http://",
    "https://",
    "requests.get(",
    "requests.post(",
    "httpx.get(",
    "httpx.post(",
    "urllib.request",
    "urlopen(",
    "aiohttp",
    "curl",
    "api_endpoint",
  ];
  return markers.some((m) => code.includes(m));
}

function shouldRequireExternalFetch(paramsLike = {}, contextLike = {}) {
  const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
  const sourceType = toText(params.sourceType || "").toLowerCase();
  if (!sourceType || !(sourceType === "news" || sourceType === "social" || sourceType === "prediction")) return false;
  if (toText(params.url || "") || toText(params.urlTemplate || "") || toText(params.query || "")) return true;
  const context = contextLike && typeof contextLike === "object" ? contextLike : {};
  const msg = `${toText(context.userMessage || "")} ${toText(context.assistantReply || "")}`.toLowerCase();
  const cues = [
    "实时", "最新", "抓取", "获取", "查询", "联网", "接口", "api", "rss", "feed", "live", "fresh", "fetch", "pull", "crawl", "source",
  ];
  return cues.some((k) => msg.includes(k));
}

function appendRequiredInput(params = {}, inputLike = {}) {
  const input = inputLike && typeof inputLike === "object" ? inputLike : {};
  const key = toText(input.key || "");
  if (!key) return;
  const list = Array.isArray(params.requiredInputs) ? [...params.requiredInputs] : [];
  const exists = list.some((item) => toText(item && item.key).toLowerCase() === key.toLowerCase());
  if (exists) return;
  list.push({
    key,
    label: toText(input.label || key),
    type: toText(input.type || "text"),
    required: input.required !== false,
    hint: toText(input.hint || ""),
  });
  params.requiredInputs = list;
}

function validateModelExternalCode(paramsLike = {}) {
  const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
  const pythonIndicator = toText(params.pythonIndicator || "");
  const pipelineCode = toText(params.pipelineCode || "");
  if (!pythonIndicator || !pipelineCode) {
    return { ok: false, reason: "pythonIndicator/pipelineCode missing" };
  }
  const indicatorLower = pythonIndicator.toLowerCase();
  if (!indicatorLower.includes("dataframe[") || !indicatorLower.includes("{col}")) {
    return { ok: false, reason: "pythonIndicator must write dataframe['{col}']" };
  }
  const bannedTokens = [
    "parse_rss_titles",
    "json_load",
    "keyword_score",
    "price_of",
    "score_by_lexicon",
    "count_mentions",
    "normalize_prob",
  ];
  const pipelineLower = pipelineCode.toLowerCase();
  if (bannedTokens.some((token) => pipelineLower.includes(token))) {
    return { ok: false, reason: "pipelineCode contains pseudo helper token" };
  }
  const pythonSignal = /\b(def|import|from|for\s+\w+\s+in|return|lambda|try:|except|if\s+.+:)/i;
  if (!pythonSignal.test(pipelineCode)) {
    return { ok: false, reason: "pipelineCode is not executable python-like code" };
  }
  const esc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  const py = [
    "import ast, sys",
    `pipeline_code = '''${esc(pipelineCode).replace(/'''/g, "\\'\\'\\'")}'''`,
    `indicator_code = '''${esc(pythonIndicator).replace(/'''/g, "\\'\\'\\'")}'''`,
    "try:",
    "  ast.parse(pipeline_code)",
    "  ast.parse(indicator_code)",
    "except Exception as exc:",
    "  print('syntax_error:' + str(exc))",
    "  sys.exit(2)",
    "ns = {}",
    "try:",
    "  exec(pipeline_code, ns, ns)",
    "except Exception as exc:",
    "  print('runtime_error:' + str(exc))",
    "  sys.exit(3)",
    "sample_payload = {'texts':['btc panic then rebound'], 'meta':{'pair':'BTC/USDT'}}",
    "candidates = ['compute_external_signal', 'compute_signal', 'run', 'main']",
    "selected = None",
    "for fn in candidates:",
    "  if fn in ns and callable(ns[fn]):",
    "    selected = ns[fn]",
    "    break",
    "if selected is not None:",
    "  try:",
    "    out = selected(sample_payload)",
    "    if not isinstance(out, (int, float)):",
    "      print('invalid_return_type')",
    "      sys.exit(4)",
    "  except Exception as exc:",
    "    print('pipeline_callable_error:' + str(exc))",
    "    sys.exit(5)",
    "else:",
    "  if 'raw_score' not in ns:",
    "    print('missing_callable_or_raw_score')",
    "    sys.exit(6)",
  ].join("\n");
  const run = spawnSync("python", ["-c", py], { encoding: "utf8", timeout: 10_000 });
  if (run.status !== 0) {
    return { ok: false, reason: toText(run.stderr || run.stdout || "python_exec_failed") };
  }
  return { ok: true, reason: "" };
}

function markCodeNeedsUserInput(paramsLike = {}, reason = "", options = {}) {
  const params = paramsLike && typeof paramsLike === "object" ? paramsLike : {};
  const message = toText(reason || "模型生成代码未通过执行校验");
  params.codegenStatus = "needs_user_input";
  params.codeValidationError = message;
  appendRequiredInput(params, {
    key: "code_refine_instruction",
    label: "补充代码改造要求",
    type: "textarea",
    required: true,
    hint: message,
  });
  const opts = options && typeof options === "object" ? options : {};
  if (opts.requireFetch) {
    appendRequiredInput(params, {
      key: "external_data_source",
      label: "外部数据源 URL 或 API",
      type: "text",
      required: true,
      hint: "当前代码缺少可识别的实时取数逻辑，请补充可访问的数据源",
    });
    params.codeDataSourceWarning = "pipelineCode_missing_external_fetch";
  }
  return params;
}

function pickEnum(valueLike, allowedSet, fallback) {
  const v = String(valueLike ?? "").trim().toLowerCase();
  if (allowedSet.has(v)) return v;
  return fallback;
}

const FEATURE_GROUPS = new Set(["trend", "momentum", "volatility", "risk", "execution", "signal_external", "custom"]);
const FEATURE_KINDS = new Set([
  "ema",
  "sma",
  "rsi",
  "adx",
  "atr",
  "volume",
  "price_action",
  "risk_rule",
  "news_sentiment",
  "social_sentiment",
  "prediction_market",
  "custom",
]);

function normalizeFeature(rawLike = {}) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  const name = toText(raw.name || raw.featureId || raw.title || "");
  if (!name) return null;
  const group = pickEnum(raw.group, FEATURE_GROUPS, "custom");
  const kind = pickEnum(raw.kind, FEATURE_KINDS, "custom");
  const description = toText(raw.description || raw.summary || "来自对话候选");
  const paramsRaw = raw.params && typeof raw.params === "object" ? raw.params : {};
  const params = {};
  Object.entries(paramsRaw)
    .slice(0, 16)
    .forEach(([k, v]) => {
      const key = toText(k).replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 32);
      if (!key) return;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        params[key] = v;
      }
    });
  if ((toText(params.pythonIndicator || "") || toText(params.pipelineCode || "")) && !toText(params.codeSource || "")) {
    params.codeSource = "model_generated";
  }
  const sourceType = toText(params.sourceType || "").toLowerCase();
  const isExternal = sourceType === "news" || sourceType === "social" || sourceType === "prediction";
  if (isExternal) {
    const hasCode = Boolean(toText(params.pythonIndicator || "") && toText(params.pipelineCode || ""));
    if (!hasCode) {
      markCodeNeedsUserInput(params, "pythonIndicator/pipelineCode missing", {
        requireFetch: shouldRequireExternalFetch(params, {}),
      });
    } else if (params.codeSource === "model_generated") {
      const validation = validateModelExternalCode(params);
      if (!validation.ok) {
        markCodeNeedsUserInput(params, validation.reason, {
          requireFetch: shouldRequireExternalFetch(params, {}),
        });
      } else {
        delete params.codegenStatus;
        delete params.codeValidationError;
        delete params.codeDataSourceWarning;
        if (Array.isArray(params.requiredInputs)) {
          params.requiredInputs = params.requiredInputs.filter((row) => {
            const key = toText(row && row.key).toLowerCase();
            return key !== "code_refine_instruction" && key !== "external_data_source";
          });
        }
        if (!Array.isArray(params.requiredInputs) || params.requiredInputs.length === 0) delete params.requiredInputs;
      }
    }
  }
  return {
    name,
    group,
    kind,
    description,
    params,
  };
}

function normalizeCandidate(rawLike = {}, index = 0) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  const kind = String(raw.kind || "").trim().toLowerCase();
  const confidence = clampNumber(raw.confidence, 0, 1, 0.6);
  if (kind === "feature") {
    const feature = normalizeFeature(raw.feature || raw);
    if (!feature) return null;
    const title = toText(raw.title || feature.name || `特征候选 ${index + 1}`);
    const summary = toText(raw.summary || feature.description || "来自交易对话的特征候选");
    return {
      candidateId: toText(raw.candidateId || `cand_feature_${index + 1}`),
      kind: "feature",
      title,
      summary,
      confidence,
      feature,
    };
  }
  if (kind === "strategy") return null;
  return null;
}

function normalizeSkillResult(rawLike = {}) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  const candidates = (Array.isArray(raw.candidates) ? raw.candidates : [])
    .map((item, idx) => normalizeCandidate(item, idx))
    .filter(Boolean)
    .slice(0, 4);
  const intentDetected = Boolean(raw.intentDetected) && candidates.length > 0;
  const confidence = clampNumber(raw.confidence, 0, 1, candidates.length ? 0.72 : 0.15);
  return {
    intentDetected,
    confidence,
    reasoning: toText(raw.reasoning || raw.rationale || ""),
    candidates,
  };
}


function buildHeuristicIntentFromText(params = {}) {
  const userMessage = toText(params.userMessage).toLowerCase();
  const assistantReply = toText(params.assistantReply).toLowerCase();
  const merged = `${userMessage}
${assistantReply}`;

  const skillPack = runHeuristicIntentSkills({
    userMessage,
    assistantReply,
    mergedText: merged,
  });

  if (!skillPack.intentDetected) {
    return {
      intentDetected: false,
      confidence: 0.2,
      reasoning: toText(skillPack.reasoning || "对话中缺少明确交易对象或策略描述"),
      candidates: [],
    };
  }

  const featureCandidates = Array.isArray(skillPack.featureCandidates)
    ? skillPack.featureCandidates.slice(0, 4)
    : [];

  if (featureCandidates.length === 0) {
    featureCandidates.push({
      candidateId: "cand_feature_ema_default",
      kind: "feature",
      title: "EMA 趋势特征",
      summary: "默认趋势特征（降级兜底）",
      confidence: 0.68,
      feature: {
        name: "ema_trend",
        group: "trend",
        kind: "ema",
        description: "EMA 快慢线趋势判断",
        params: { fast: 12, slow: 26 },
      },
    });
    featureCandidates.push({
      candidateId: "cand_feature_atr_default",
      kind: "feature",
      title: "ATR 波动过滤",
      summary: "默认波动特征（降级兜底）",
      confidence: 0.66,
      feature: {
        name: "atr_filter",
        group: "volatility",
        kind: "atr",
        description: "ATR 波动率过滤",
        params: { period: 14 },
      },
    });
  }

  const dynamicPlan = buildDynamicSignalPlan(merged, featureCandidates);
  const dynamicByRef = new Map();
  dynamicPlan.dynamicFeatureSpecs.forEach((row) => {
    const ref = toText(row?.ref || "").toLowerCase();
    if (ref) dynamicByRef.set(ref, row);
  });
  const cards = featureCandidates.map((cand, idx) => {
    const feature = cand?.feature && typeof cand.feature === "object" ? { ...cand.feature } : {};
    const ref = toText(feature.name || "").toLowerCase();
    const patch = dynamicByRef.get(ref) || {};
    const params = feature.params && typeof feature.params === "object" ? { ...feature.params } : {};
    feature.params = {
      ...params,
      sourceType: toText(patch.sourceType || params.sourceType || ""),
      provider: toText(patch.provider || params.provider || ""),
      url: toText(patch.url || params.url || ""),
      urlTemplate: toText(patch.urlTemplate || params.urlTemplate || ""),
      query: toText(patch.query || params.query || ""),
      timeframe: toText(params.timeframe || "1h"),
      inputDeps: Array.isArray(params.inputDeps) ? params.inputDeps : ["ohlcv"],
      outputColumn: toText(params.outputColumn || `tc_feat_${idx}`),
      pythonIndicator: toText(patch.pythonIndicator || params.pythonIndicator || ""),
      pipelineCode: toText(patch.pipelineCode || params.pipelineCode || ""),
      codeSource: toText(params.codeSource || ""),
      requiredInputs: dynamicPlan.requiredInputs,
    };
    return { ...cand, kind: "feature", feature };
  });

  return {
    intentDetected: true,
    confidence: clampNumber(skillPack.confidence, 0, 1, 0.74),
    reasoning: toText(skillPack.reasoning || "启用本地技能编排交易意图提取（仅特征卡片）"),
    candidates: cards.slice(0, 8),
  };
}

function buildSkillPrompt(params = {}) {
  const userMessage = toText(params.userMessage).slice(0, 1600);
  const assistantReply = toText(params.assistantReply).slice(0, 2000);
  const runtimeModelRef = toText(params.runtimeModelRef);
  const clientContext = params.clientContext && typeof params.clientContext === "object"
    ? params.clientContext
    : {};
  const context = {
    userMessage,
    assistantReply,
    runtimeModelRef,
    clientContext,
  };
  return [
    "你是 ThunderClaw 的 Trading Intent Skill（交易意图技能）。",
    "你的职责：基于用户与助手本轮对话，判断是否存在“可落地到虾策”的交易特征卡片候选。",
    "必须输出严格 JSON，不要 markdown，不要解释文本。",
    "",
    "输出 Schema：",
    "{",
    '  "intentDetected": boolean,',
    '  "confidence": number,',
    '  "reasoning": string,',
    '  "candidates": [',
    "    {",
    '      "candidateId": "string",',
    '      "kind": "feature",',
    '      "title": "string",',
    '      "summary": "string",',
    '      "confidence": number,',
    '      "feature": {',
    '        "name": "string",',
    '        "group": "trend|momentum|volatility|risk|execution|signal_external|custom",',
    '        "kind": "ema|sma|rsi|adx|atr|volume|price_action|risk_rule|news_sentiment|social_sentiment|prediction_market|custom",',
    '        "description": "string",',
    '        "params": {}',
    "      }",
    "    }",
    "  ]",
    "}",
    "",
    "决策规则：",
    "1) 只有在“交易目标/风格/约束/策略构思/指标偏好”明确时，intentDetected 才为 true。",
    "2) 若信息不足，intentDetected=false，candidates=[]。",
    "3) 候选最多 3 个；优先可执行、可验证、低歧义。",
    "4) 不要编造不存在的上下文。",
    "",
    "[CONTEXT]",
    JSON.stringify(context),
  ].join("\n");
}

export function createTradingIntentSkill(deps = {}) {
  const runOpenClawCommand = deps.runOpenClawCommand;
  const parseJsonSafe = deps.parseJsonSafe;
  const extractAgentReply = deps.extractAgentReply;
  const normalizeSessionId = deps.normalizeSessionId;
  if (typeof runOpenClawCommand !== "function") throw new Error("runOpenClawCommand is required");
  if (typeof parseJsonSafe !== "function") throw new Error("parseJsonSafe is required");
  if (typeof extractAgentReply !== "function") throw new Error("extractAgentReply is required");
  if (typeof normalizeSessionId !== "function") throw new Error("normalizeSessionId is required");

  async function requestModelCodeRepair(params = {}) {
    const candidateId = toText(params.candidateId || "");
    const feature = params.feature && typeof params.feature === "object" ? params.feature : {};
    if (!candidateId || !toText(feature.name || "")) return null;
    const message = [
      "你是 ThunderClaw 外部信号代码修复器。",
      "目标：把现有代码修成可执行 Python。",
      "硬要求：",
      "1) 返回 JSON；",
      "2) pythonIndicator 必须可执行并写入 dataframe['{col}']；",
      "3) pipelineCode 必须是可执行 Python；",
      "4) pipelineCode 必须包含外部数据获取步骤（HTTP API/RSS/SDK 调用其一），不能只在本地 payload 上空算；",
      "5) 如果定义函数，建议签名为 func(payload) 并返回 float；也允许直接在顶层产出 raw_score；",
      "6) 禁止 parse_rss_titles/json_load/score_by_lexicon 等伪函数。",
      "输出 Schema:",
      '{"featurePlan":{"candidateId":"string","feature":{"name":"string","params":{"pythonIndicator":"string","pipelineCode":"string","codeSource":"model_generated"}}}}',
      "[INPUT]",
      JSON.stringify({
        candidateId,
        feature,
        reason: toText(params.reason || "validation_failed"),
        userMessage: toText(params.userMessage || ""),
      }),
    ].join("\n");
    const args = [
      "agent",
      "--session-id",
      normalizeSessionId(`${toText(params.sessionId || "main")}-code-repair`),
      "--message",
      message,
      "--json",
    ];
    const result = await runOpenClawCommand(args, { timeoutMs: 120_000 });
    if (!result.ok) return null;
    const payload = parseJsonSafe(result.stdout);
    const replyText = toText(extractAgentReply(payload) || "");
    const parsed = parseJsonLoose(replyText) || parseJsonLoose(result.stdout) || payload || {};
    const plan = parsed?.featurePlan && typeof parsed.featurePlan === "object" ? parsed.featurePlan : null;
    if (!plan) return null;
    const outFeature = plan.feature && typeof plan.feature === "object" ? plan.feature : {};
    const outParams = outFeature.params && typeof outFeature.params === "object" ? outFeature.params : {};
    return {
      candidateId: toText(plan.candidateId || candidateId),
      featureName: toText(outFeature.name || feature.name || "").toLowerCase(),
      params: {
        pythonIndicator: toText(outParams.pythonIndicator || ""),
        pipelineCode: toText(outParams.pipelineCode || ""),
        codeSource: toText(outParams.codeSource || "model_generated"),
      },
    };
  }

  async function enrichCandidatesWithDynamicPlan(params = {}) {
    const candidates = Array.isArray(params.candidates) ? params.candidates : [];
    if (!candidates.length) return candidates;
    const sessionId = normalizeSessionId(toText(params.sessionId || "thunderclaw-main", "thunderclaw-main"));
    const runtimeModelRef = toText(params.runtimeModelRef || "");
    const requestUserMessage = toText(params.userMessage || "");
    const requestAssistantReply = toText(params.assistantReply || "");
    const message = [
      "你是 ThunderClaw 动态信号代码规划器。",
      "任务：基于当前对话上下文和特征候选卡片，补全每个特征卡片参数（用于运行时代码生成）。",
      "要求：",
      "1) 必须返回 JSON。",
      "2) 不要把 URL 写死为同一个默认值；应结合对话语义给出 provider/source 规划。",
      "3) 若无法确定 URL，允许 url 为空，但不要伪造 pythonIndicator/pipelineCode。",
      "4) pipelineCode 必须体现外部数据获取逻辑（HTTP API/RSS/SDK），不能只有本地 payload 计算。",
      "5) pythonIndicator 和 pipelineCode 必须是可执行 Python，不要输出 parse_rss_titles/json_load/score_by_lexicon 这类伪函数。",
      "6) 输出中不得删除已有候选，只能做增强。",
      "输出 Schema:",
      "{",
      '  "featurePlans": [',
      "    {",
      '      "candidateId": "string",',
      '      "feature": {"name":"string","params":{"sourceType":"news|social|prediction|custom","provider":"string","url":"string","urlTemplate":"string","query":"string","pythonIndicator":"string","pipelineCode":"string","timeframe":"string","outputColumn":"string"}},',
      '      "requiredInputs": [{"key":"string","label":"string","type":"string","required":true}]',
      "    }",
      "  ]",
      "}",
      "[CONTEXT]",
      JSON.stringify({
        userMessage: toText(params.userMessage || ""),
        assistantReply: toText(params.assistantReply || ""),
        runtimeModelRef,
        candidates,
      }),
    ].join("\n");
    const args = [
      "agent",
      "--session-id",
      normalizeSessionId(`${sessionId}-dynamic-plan`),
      "--message",
      message,
      "--json",
    ];
    const result = await runOpenClawCommand(args, { timeoutMs: 120_000 });
    if (!result.ok) return candidates;
    const payload = parseJsonSafe(result.stdout);
    const replyText = toText(extractAgentReply(payload) || "");
    const parsed = parseJsonLoose(replyText) || parseJsonLoose(result.stdout) || payload || {};
    const plans = Array.isArray(parsed?.featurePlans) ? parsed.featurePlans : [];
    const byId = new Map();
    plans.forEach((itemLike) => {
      const item = itemLike && typeof itemLike === "object" ? itemLike : {};
      const candidateId = toText(item.candidateId || "");
      if (!candidateId) return;
      const feature = item.feature && typeof item.feature === "object" ? item.feature : {};
      const params = feature.params && typeof feature.params === "object" ? feature.params : {};
      byId.set(candidateId, {
        featureName: toText(feature.name || "").toLowerCase(),
        params: {
          sourceType: toText(params.sourceType || "").toLowerCase(),
          provider: toText(params.provider || "").toLowerCase(),
          url: toText(params.url || ""),
          urlTemplate: toText(params.urlTemplate || ""),
          query: toText(params.query || ""),
          pythonIndicator: toText(params.pythonIndicator || ""),
          pipelineCode: toText(params.pipelineCode || ""),
          timeframe: toText(params.timeframe || ""),
          outputColumn: toText(params.outputColumn || ""),
          codeSource: toText(params.codeSource || ""),
        },
        requiredInputs: sanitizeRequiredInputs(item.requiredInputs || []),
      });
    });
    const out = [];
    for (const candLike of candidates) {
      const cand = candLike && typeof candLike === "object" ? candLike : {};
      const candidateId = toText(cand.candidateId || "");
      const patchRaw = byId.get(candidateId);
      const patch = patchRaw && typeof patchRaw === "object"
        ? patchRaw
        : { featureName: "", params: {}, requiredInputs: [] };
      const feature = cand.feature && typeof cand.feature === "object" ? { ...cand.feature } : null;
      if (!feature) {
        out.push(cand);
        continue;
      }
      const featureName = toText(feature.name || "").toLowerCase();
      if (patch.featureName && patch.featureName !== featureName) {
        out.push(cand);
        continue;
      }
      const params = feature.params && typeof feature.params === "object" ? { ...feature.params } : {};
      Object.entries(patch.params || {}).forEach(([k, v]) => {
        if (toText(v || "")) params[k] = v;
      });
      if (!toText(params.codeSource || "") && (toText(params.pythonIndicator || "") || toText(params.pipelineCode || ""))) {
        params.codeSource = "model_generated";
      }
      if (toText(params.sourceType || "")) {
        const hasCode = Boolean(toText(params.pythonIndicator || "") && toText(params.pipelineCode || ""));
        const requireFetch = shouldRequireExternalFetch(params, {
          userMessage: requestUserMessage,
          assistantReply: requestAssistantReply,
        });
        if (!hasCode) {
          markCodeNeedsUserInput(params, "pythonIndicator/pipelineCode missing", { requireFetch });
        } else if (params.codeSource === "model_generated") {
          const validation = validateModelExternalCode(params);
          if (!validation.ok) {
            markCodeNeedsUserInput(params, validation.reason, { requireFetch });
          } else if (requireFetch && !hasExternalDataFetchPattern(params.pipelineCode || "")) {
            markCodeNeedsUserInput(params, "pipelineCode 缺少外部数据获取步骤", { requireFetch: true });
          } else {
            delete params.codegenStatus;
            delete params.codeValidationError;
            delete params.codeDataSourceWarning;
            if (Array.isArray(params.requiredInputs)) {
              params.requiredInputs = params.requiredInputs.filter((row) => {
                const key = toText(row && row.key).toLowerCase();
                return key !== "code_refine_instruction" && key !== "external_data_source";
              });
            }
            if (!Array.isArray(params.requiredInputs) || params.requiredInputs.length === 0) delete params.requiredInputs;
          }
        } else {
          markCodeNeedsUserInput(params, "external feature codeSource must be model_generated", { requireFetch });
        }
      }
      if (patch.requiredInputs.length > 0) params.requiredInputs = patch.requiredInputs;
      feature.params = params;
      out.push({
        ...cand,
        feature,
      });
    }
    return out;
  }

  async function extractTradingIntentCandidates(params = {}) {
    const userMessage = toText(params.userMessage);
    const assistantReply = toText(params.assistantReply);
    if (!userMessage && !assistantReply) {
      return {
        ok: true,
        intentDetected: false,
        confidence: 0,
        reasoning: "",
        candidates: [],
      };
    }
    const baseSessionId = normalizeSessionId(toText(params.sessionId || "thunderclaw-main", "thunderclaw-main"));
    const skillSessionId = normalizeSessionId(`${baseSessionId}-xstrategy-skill`);
    const runtimeModelRef = toText(params.runtimeModelRef || "");
    const message = buildSkillPrompt({
      userMessage,
      assistantReply,
      runtimeModelRef,
      clientContext: params.clientContext,
    });
    const args = [
      "agent",
      "--session-id",
      skillSessionId,
      "--message",
      message,
      "--json",
    ];
    const result = await runOpenClawCommand(args, { timeoutMs: 120_000 });
    if (!result.ok) {
      const heuristic = buildHeuristicIntentFromText({ userMessage, assistantReply });
      const enrichedCandidates = await enrichCandidatesWithDynamicPlan({
        candidates: heuristic.candidates,
        userMessage,
        assistantReply,
        runtimeModelRef,
        sessionId: skillSessionId,
      });
      return {
        ok: true,
        intentDetected: heuristic.intentDetected,
        confidence: heuristic.confidence,
        reasoning: heuristic.reasoning,
        candidates: enrichedCandidates,
        modelRef: runtimeModelRef,
        sessionId: skillSessionId,
        error: toText(result.stderr || result.stdout || "intent skill fallback"),
      };
    }
    const payload = parseJsonSafe(result.stdout);
    const replyText = toText(extractAgentReply(payload) || "");
    const parsed = parseJsonLoose(replyText) || parseJsonLoose(result.stdout) || payload || null;
    const normalized = normalizeSkillResult(parsed || {});
    if (!normalized.intentDetected || !Array.isArray(normalized.candidates) || normalized.candidates.length === 0) {
      const heuristic = buildHeuristicIntentFromText({ userMessage, assistantReply });
      const enrichedCandidates = await enrichCandidatesWithDynamicPlan({
        candidates: heuristic.candidates,
        userMessage,
        assistantReply,
        runtimeModelRef,
        sessionId: skillSessionId,
      });
      return {
        ok: true,
        intentDetected: heuristic.intentDetected,
        confidence: heuristic.confidence,
        reasoning: heuristic.reasoning,
        candidates: enrichedCandidates,
        modelRef: runtimeModelRef,
        sessionId: skillSessionId,
      };
    }
    const enrichedCandidates = await enrichCandidatesWithDynamicPlan({
      candidates: normalized.candidates,
      userMessage,
      assistantReply,
      runtimeModelRef,
      sessionId: skillSessionId,
    });
    return {
      ok: true,
      intentDetected: normalized.intentDetected,
      confidence: normalized.confidence,
      reasoning: normalized.reasoning,
      candidates: enrichedCandidates,
      modelRef: runtimeModelRef,
      sessionId: skillSessionId,
    };
  }

  async function generateFeatureCodeForCandidate(params = {}) {
    const candidate = normalizeCandidate(params.candidate || {}, 0);
    if (!candidate || candidate.kind !== "feature") {
      return { ok: false, error: "feature candidate is required" };
    }
    const userMessage = toText(params.userMessage || "");
    const assistantReply = toText(params.assistantReply || "");
    const runtimeModelRef = toText(params.runtimeModelRef || "");
    const sessionId = normalizeSessionId(toText(params.sessionId || "thunderclaw-main", "thunderclaw-main"));
    const refineInstruction = toText(params.refineInstruction || "");
    const featureParams = candidate.feature && typeof candidate.feature === "object" && candidate.feature.params && typeof candidate.feature.params === "object"
      ? candidate.feature.params
      : {};
    const lastValidationError = toText(featureParams.codeValidationError || "");
    const requiredInputs = Array.isArray(featureParams.requiredInputs)
      ? featureParams.requiredInputs.map((row) => {
        const item = row && typeof row === "object" ? row : {};
        return toText(item.label || item.key || "");
      }).filter(Boolean)
      : [];
    const refineContext = [
      refineInstruction ? `用户补充要求：${refineInstruction}` : "",
      lastValidationError ? `上次失败原因：${lastValidationError}` : "",
      requiredInputs.length ? `待补充项：${requiredInputs.join("、")}` : "",
    ].filter(Boolean).join("\n");
    const requestUserMessage = refineContext
      ? [userMessage, refineContext].filter(Boolean).join("\n\n")
      : userMessage;
    const enriched = await enrichCandidatesWithDynamicPlan({
      candidates: [candidate],
      userMessage: requestUserMessage,
      assistantReply,
      runtimeModelRef,
      sessionId,
    });
    return {
      ok: true,
      candidate: enriched[0] || candidate,
      sessionId,
      modelRef: runtimeModelRef,
    };
  }

  return {
    extractTradingIntentCandidates,
    generateFeatureCodeForCandidate,
  };
}
