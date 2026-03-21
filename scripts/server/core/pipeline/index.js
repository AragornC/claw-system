/**
 * ThunderClaw Feature Generation Pipeline
 *
 * Orchestrates the three-stage pipeline:
 *   Stage 1: Intent Detection (conversation → feature specs)
 *   Stage 2: Code Generation (feature spec → Python code)
 *   Stage 3: Code Validation (Python code → verified executable)
 *
 * Provides a single entry point for the entire flow.
 */

import { toText, clampNumber, nowIso } from "../../lib/utils.js";

import { createLlmClient } from "../llm-client.js";
import { createIntentDetector } from "./intent-detector.js";
import { createCodeGenerator } from "./code-generator.js";
import { createCodeValidator } from "./code-validator.js";
import {
  INTENT_CLARIFICATION_SYSTEM_PROMPT,
  buildClarificationUserMessage,
  FEATURE_REASONING_SYSTEM_PROMPT,
  buildFeatureReasoningUserMessage,
  FEATURE_PLAN_FROM_REASONING_SYSTEM_PROMPT,
  buildPlanFromReasoningUserMessage,
} from "./prompts/intent-clarification.js";
import {
  CODE_REPAIR_SYSTEM_PROMPT,
  buildCodeRepairUserMessage,
} from "./prompts/code-generation.js";
import {
  buildFeatureSpecArtifact,
  buildCodeDiffArtifact,
  generateTemplateCode,
} from "./feature-workbench.js";

const MAX_REPAIR_ATTEMPTS = 3;

function buildRepairHistory(params = {}) {
  const history = Array.isArray(params.history) ? params.history.slice() : [];
  if (history.length) return history;
  return [
    { role: "system", content: CODE_REPAIR_SYSTEM_PROMPT },
    { role: "user", content: buildCodeRepairUserMessage(params) },
  ];
}

function cloneStructured(valueLike) {
  if (valueLike == null) return null;
  try {
    return JSON.parse(JSON.stringify(valueLike));
  } catch {
    return null;
  }
}

function sanitizeFeatureName(valueLike, fallback = "custom_feature") {
  const name = toText(valueLike, fallback).toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return name || fallback;
}

function buildRunArtifacts(params = {}) {
  const artifacts = {};
  if (params.mockValidation && typeof params.mockValidation === "object") {
    artifacts.mockValidation = cloneStructured(params.mockValidation);
  }
  if (params.evaluationInput && typeof params.evaluationInput === "object") {
    artifacts.evaluationInput = cloneStructured(params.evaluationInput);
  }
  if (params.evaluationOutput && typeof params.evaluationOutput === "object") {
    artifacts.evaluationOutput = cloneStructured(params.evaluationOutput);
  }
  if (params.logs && typeof params.logs === "object") {
    artifacts.logs = cloneStructured(params.logs);
  }
  if (params.samples && typeof params.samples === "object") {
    artifacts.samples = cloneStructured(params.samples);
  }
  return artifacts;
}

function buildFailureArtifact(params = {}) {
  const errors = Array.isArray(params.errors) ? params.errors.filter(Boolean) : [];
  const warnings = Array.isArray(params.warnings) ? params.warnings.filter(Boolean) : [];
  const stage = toText(params.stage, "engineering");
  const failureType = toText(params.failureType, stage === "semantic" ? "semantics_mismatch" : (stage === "numeric" ? "low_variance" : "runtime_contract_error"));
  const stats = params.stats && typeof params.stats === "object" ? cloneStructured(params.stats) : null;
  const runContext = params.runContext && typeof params.runContext === "object" ? cloneStructured(params.runContext) : null;
  return {
    failureType,
    rootCauseHypothesis: toText(
      params.rootCauseHypothesis,
      errors[0] || warnings[0] || `${stage} validation failed`,
    ),
    repairGoal: toText(
      params.repairGoal,
      stage === "semantic"
        ? "修复代码，使输出重新满足 spec 约束和交易语义。"
        : (stage === "numeric"
          ? "修复代码，使输出不再全零、全 NaN 或低波动。"
          : "修复代码，使其通过工程与运行时契约验证。"),
    ),
    stage,
    issues: errors,
    warnings,
    stats,
    runContext,
  };
}

function attachCodeArtifacts(codeLike, extra = {}) {
  const code = codeLike && typeof codeLike === "object" ? { ...codeLike } : {};
  if (extra.specArtifact !== undefined) code.specArtifact = cloneStructured(extra.specArtifact);
  if (extra.failureType !== undefined) code.failureType = toText(extra.failureType, "");
  if (extra.repairSummary !== undefined) code.repairSummary = cloneStructured(extra.repairSummary);
  if (extra.codeDiff !== undefined) code.codeDiff = cloneStructured(extra.codeDiff);
  if (extra.runArtifacts !== undefined) code.runArtifacts = cloneStructured(extra.runArtifacts);
  if (extra.validationLayers !== undefined) code.validationLayers = cloneStructured(extra.validationLayers);
  return code;
}

function buildFeatureFromClarificationDraft(params = {}) {
  const featureConcept = params.featureConcept && typeof params.featureConcept === "object"
    ? params.featureConcept
    : {};
  const userChoices = params.userChoices && typeof params.userChoices === "object"
    ? params.userChoices
    : {};
  const draftName = toText(featureConcept.name, "custom_feature").toLowerCase().replace(/[^a-z0-9_]/g, "_") || "custom_feature";
  const kindHint = toText(featureConcept.indicatorHint, "custom").toLowerCase();
  const kind = /atr/.test(kindHint)
    ? "atr"
    : (/boll/.test(kindHint)
      ? "bollinger"
      : (/rsi/.test(kindHint)
        ? "rsi"
        : (/ema|trend/.test(kindHint) ? "ema" : "custom")));
  const group = toText(featureConcept.category, "custom").toLowerCase() || "custom";
  return {
    name: draftName,
    group,
    kind,
    description: toText(featureConcept.description, toText(featureConcept.name, "交易特征")),
    params: { ...userChoices },
    indicatorLogic: toText(featureConcept.technicalApproach || featureConcept.indicatorHint || featureConcept.description, ""),
  };
}

function normalizePlanArtifact(rawLike, fallbackLike = {}) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  const fallback = fallbackLike && typeof fallbackLike === "object" ? fallbackLike : {};
  const normalizeList = (valueLike, fallbackListLike = []) => {
    const value = Array.isArray(valueLike) ? valueLike : fallbackListLike;
    return value.map((item) => toText(item, "")).filter(Boolean).slice(0, 8);
  };
  const goal = toText(raw.goal, toText(fallback.goal, ""));
  const summary = toText(raw.summary, toText(fallback.summary, ""));
  const approach = normalizeList(raw.approach, fallback.approach);
  const inputs = normalizeList(raw.inputs, fallback.inputs);
  const outputs = normalizeList(raw.outputs, fallback.outputs);
  const validation = normalizeList(raw.validation, fallback.validation);
  const repairStrategy = normalizeList(raw.repairStrategy, fallback.repairStrategy);
  return {
    goal: goal || "围绕用户确认的特征方向，生成一个可运行且具备可解释性的交易信号。",
    summary: summary || "先生成首版代码，再进行结构校验与真实特征评估，若发现问题则基于当前版本继续修复。",
    approach: approach.length ? approach : ["结合用户选择确定指标、参数和信号归一化方式。"],
    inputs: inputs.length ? inputs : ["OHLCV K 线数据，以及用户确认的参数约束。"],
    outputs: outputs.length ? outputs : ["输出与输入 K 线等长的 pandas Series 特征列。"],
    validation: validation.length ? validation : ["先验证 Python 语法和 mock DataFrame 运行，再验证真实特征评估结果。"],
    repairStrategy: repairStrategy.length ? repairStrategy : ["若出现报错、全零、全 NaN 或无波动，则在当前代码基础上定向修复。"],
  };
}

function normalizeReasoningArtifact(rawLike, fallbackLike = {}) {
  const raw = rawLike && typeof rawLike === "object"
    ? rawLike
    : (typeof rawLike === "string"
      ? {
          lines: String(rawLike || "").split(/\n+/).map((item) => toText(item, "")).filter(Boolean),
          summary: toText(String(rawLike || "").split(/\n+/)[0], ""),
        }
      : {});
  const fallback = fallbackLike && typeof fallbackLike === "object" ? fallbackLike : {};
  const fallbackLines = Array.isArray(fallback.lines) ? fallback.lines : [];
  const lines = (Array.isArray(raw.lines) ? raw.lines : fallbackLines)
    .map((item) => toText(item, ""))
    .filter(Boolean)
    .slice(0, 12);
  const summary = toText(raw.summary, toText(fallback.summary, ""));
  return {
    summary: summary || "先收敛目标，再明确技术路线、验证方式和修复路径。",
    lines,
  };
}

/**
 * Create the full feature generation pipeline.
 *
 * @param {Object} deps
 * @param {() => {provider:string, model:string, apiKey:string, apiBase?:string}} [deps.getModelConfig]
 *   Returns current model config from xbrainStore (follows model switching).
 * @param {() => string} [deps.getApiKey]
 *   Legacy: API key getter (backward compat, defaults to DEEPSEEK_API_KEY env var).
 */
export function createFeaturePipeline(deps = {}) {
  let llmClient;
  if (typeof deps.getModelConfig === "function") {
    llmClient = createLlmClient({ getModelConfig: deps.getModelConfig });
  } else {
    // Backward compat: getApiKey → generic LLM client with default config
    llmClient = createLlmClient({
      getModelConfig: () => ({
        provider: "deepseek",
        model: "deepseek-chat",
        apiKey: (typeof deps.getApiKey === "function" ? deps.getApiKey() : "")
          || toText(process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || ""),
        apiBase: "",
      }),
    });
  }
  const intentDetector = createIntentDetector({ llmClient });
  const codeGenerator = createCodeGenerator({ llmClient });
  const codeValidator = createCodeValidator();

  /**
   * Run the full pipeline: detect intent → generate code → validate.
   * @param {Object} params
   * @param {string} params.userMessage
   * @param {string} params.assistantReply
   * @returns {Promise<Object>} Pipeline result with candidates including validated code
   */
  async function run(params = {}) {
    const userMessage = toText(params.userMessage);
    const assistantReply = toText(params.assistantReply);

    // Stage 1: Intent Detection
    const intentResult = await intentDetector.detectIntent({ userMessage, assistantReply });
    if (!intentResult.intentDetected || !intentResult.candidates?.length) {
      return {
        ok: true,
        intentDetected: false,
        confidence: intentResult.confidence || 0,
        reasoning: intentResult.reasoning || "",
        candidates: [],
        source: intentResult.source || "none",
      };
    }

    // Stage 2 + 3: Code Generation + Validation for each candidate
    const enrichedCandidates = [];
    for (const candidate of intentResult.candidates) {
      const feature = candidate.feature;
      if (!feature || !feature.name) {
        enrichedCandidates.push(candidate);
        continue;
      }
      const specArtifact = buildFeatureSpecArtifact({ feature });
      const featureWithSpec = { ...feature, specArtifact };

      // Generate code
      let codeResult = await codeGenerator.generateCode(featureWithSpec);
      if (!codeResult.ok || !codeResult.code?.featureCode) {
        enrichedCandidates.push({
          ...candidate,
          feature: {
            ...feature,
            generatedCode: null,
            codegenStatus: "failed",
            codegenError: toText(codeResult.error, "Code generation failed"),
          },
        });
        continue;
      }

      // Validate code
      let validation = codeValidator.validate(codeResult.code, {
        featureName: feature.name,
        specArtifact,
      });
      let finalCode = attachCodeArtifacts(codeResult.code, {
        specArtifact,
        failureType: validation.failureType,
        validationLayers: {
          engineering: validation.engineering,
          numeric: validation.numeric,
          semantic: validation.semantic,
        },
        runArtifacts: buildRunArtifacts({
          mockValidation: validation.runtimeArtifacts,
        }),
      });
      let codeSource = codeResult.source;

      // Auto-repair loop if validation fails
      if (!validation.valid) {
        let repairHistory = buildRepairHistory({
          featureSpec: featureWithSpec,
          originalCode: finalCode,
          errors: validation.errors,
          specArtifact,
          failureType: validation.failureType,
          rootCauseHypothesis: validation.errors[0] || "",
          repairGoal: "修复工程、数值或语义问题并保持 spec 不变。",
          stats: validation.numeric?.stats || validation.semantic?.stats || validation.runtimeArtifacts?.stats || null,
          runContext: buildRunArtifacts({
            mockValidation: validation.runtimeArtifacts,
          }),
          preservedConstraints: specArtifact.preservedConstraints || [],
        });
        for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt++) {
          const previousCode = finalCode;
          repairHistory.push({
            role: "assistant",
            content: JSON.stringify(finalCode),
          });
          repairHistory.push({
            role: "user",
            content: JSON.stringify({
              validationErrors: validation.errors,
              validationWarnings: validation.warnings || [],
            }),
          });
          const repairResult = await codeGenerator.repairCode({
            originalCode: finalCode,
            errors: validation.errors,
            featureSpec: featureWithSpec,
            specArtifact,
            failureType: validation.failureType,
            rootCauseHypothesis: validation.errors[0] || "",
            repairGoal: "仅做最小必要修改，使代码重新通过验证，并保持 spec 约束不变。",
            stats: validation.numeric?.stats || validation.semantic?.stats || validation.runtimeArtifacts?.stats || null,
            runContext: buildRunArtifacts({
              mockValidation: validation.runtimeArtifacts,
            }),
            preservedConstraints: specArtifact.preservedConstraints || [],
            messages: repairHistory,
          });
          if (!repairResult.ok) break;
          validation = codeValidator.validate(repairResult.code, {
            featureName: feature.name,
            specArtifact,
          });
          finalCode = attachCodeArtifacts(repairResult.code, {
            specArtifact,
            failureType: validation.failureType,
            repairSummary: repairResult.code?.repairSummary || null,
            codeDiff: buildCodeDiffArtifact(previousCode?.featureCode, repairResult.code?.featureCode),
            validationLayers: {
              engineering: validation.engineering,
              numeric: validation.numeric,
              semantic: validation.semantic,
            },
            runArtifacts: buildRunArtifacts({
              mockValidation: validation.runtimeArtifacts,
            }),
          });
          codeSource = repairResult.source || "llm_repair";
          if (validation.valid) break;
        }
      }

      enrichedCandidates.push({
        ...candidate,
        feature: {
          ...feature,
          generatedCode: {
            ...finalCode,
            codeSource,
            validatedAt: validation.valid ? nowIso() : null,
            validationErrors: validation.errors,
            validationWarnings: validation.warnings || [],
          },
          specArtifact,
          codegenStatus: validation.valid ? "validated" : "validation_failed",
          codegenError: validation.valid ? "" : validation.errors.join("; "),
        },
      });
    }

    return {
      ok: true,
      intentDetected: true,
      confidence: intentResult.confidence,
      reasoning: intentResult.reasoning,
      candidates: enrichedCandidates,
      source: intentResult.source,
    };
  }

  /**
   * Generate and validate code for a single feature (used for re-generation).
   * @param {Object} feature - Feature specification
   * @returns {Promise<Object>} Code generation result
   */
  async function generateAndValidate(feature) {
    if (!feature || !feature.name) {
      return { ok: false, error: "Feature name is required" };
    }
    const specArtifact = buildFeatureSpecArtifact({ feature });
    const featureWithSpec = { ...feature, specArtifact };

    let codeResult = await codeGenerator.generateCode(featureWithSpec);
    if (!codeResult.ok || !codeResult.code?.featureCode) {
      return { ok: false, error: toText(codeResult.error, "Code generation failed") };
    }

    let validation = codeValidator.validate(codeResult.code, {
      featureName: feature.name,
      specArtifact,
    });
    let finalCode = attachCodeArtifacts(codeResult.code, {
      specArtifact,
      failureType: validation.failureType,
      validationLayers: {
        engineering: validation.engineering,
        numeric: validation.numeric,
        semantic: validation.semantic,
      },
      runArtifacts: buildRunArtifacts({
        mockValidation: validation.runtimeArtifacts,
      }),
    });
    let codeSource = codeResult.source;

    // Auto-repair
    if (!validation.valid) {
      let repairHistory = buildRepairHistory({
        featureSpec: featureWithSpec,
        originalCode: finalCode,
        errors: validation.errors,
        specArtifact,
        failureType: validation.failureType,
        rootCauseHypothesis: validation.errors[0] || "",
        repairGoal: "修复失败并保持 spec 约束不变。",
        stats: validation.numeric?.stats || validation.semantic?.stats || validation.runtimeArtifacts?.stats || null,
        runContext: buildRunArtifacts({
          mockValidation: validation.runtimeArtifacts,
        }),
        preservedConstraints: specArtifact.preservedConstraints || [],
      });
      for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt++) {
        const previousCode = finalCode;
        repairHistory.push({
          role: "assistant",
          content: JSON.stringify(finalCode),
        });
        repairHistory.push({
          role: "user",
          content: JSON.stringify({
            validationErrors: validation.errors,
            validationWarnings: validation.warnings || [],
          }),
        });
        const repairResult = await codeGenerator.repairCode({
          originalCode: finalCode,
          errors: validation.errors,
          featureSpec: featureWithSpec,
          specArtifact,
          failureType: validation.failureType,
          rootCauseHypothesis: validation.errors[0] || "",
          repairGoal: "仅做最小修改并重新通过验证。",
          stats: validation.numeric?.stats || validation.semantic?.stats || validation.runtimeArtifacts?.stats || null,
          runContext: buildRunArtifacts({
            mockValidation: validation.runtimeArtifacts,
          }),
          preservedConstraints: specArtifact.preservedConstraints || [],
          messages: repairHistory,
        });
        if (!repairResult.ok) break;
        validation = codeValidator.validate(repairResult.code, {
          featureName: feature.name,
          specArtifact,
        });
        finalCode = attachCodeArtifacts(repairResult.code, {
          specArtifact,
          failureType: validation.failureType,
          repairSummary: repairResult.code?.repairSummary || null,
          codeDiff: buildCodeDiffArtifact(previousCode?.featureCode, repairResult.code?.featureCode),
          validationLayers: {
            engineering: validation.engineering,
            numeric: validation.numeric,
            semantic: validation.semantic,
          },
          runArtifacts: buildRunArtifacts({
            mockValidation: validation.runtimeArtifacts,
          }),
        });
        codeSource = repairResult.source || "llm_repair";
        if (validation.valid) break;
      }
    }

    return {
      ok: validation.valid,
      code: attachCodeArtifacts({
        ...finalCode,
        codeSource,
        validatedAt: validation.valid ? nowIso() : null,
        validationErrors: validation.errors,
        validationWarnings: validation.warnings || [],
      }, { specArtifact }),
      errors: validation.errors,
      warnings: validation.warnings || [],
    };
  }

  /**
   * Detect intent and generate AI-driven clarifying questions (no code generation).
   * This is the fast first step — only 1 LLM call.
   *
   * @param {Object} params
   * @param {string} params.userMessage
   * @param {string} params.assistantReply
   * @returns {Promise<Object>} { intentDetected, headline, featureConcept, clarifyingQuestions }
   */
  async function detectAndClarify(params = {}) {
    const userMessage = toText(params.userMessage);
    const assistantReply = toText(params.assistantReply);
    const conversationHistory = Array.isArray(params.conversationHistory) ? params.conversationHistory : [];
    const memoryContext = toText(params.memoryContext, "");
    if (!userMessage && !assistantReply) {
      return { ok: true, intentDetected: false, headline: "", featureConcept: null, clarifyingQuestions: [] };
    }

    try {
      // Inject memory context (L2+L3+L4) into system prompt
      const systemPrompt = INTENT_CLARIFICATION_SYSTEM_PROMPT + (memoryContext || "");
      const result = await llmClient.chatCompletionJson({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: buildClarificationUserMessage({ userMessage, assistantReply, conversationHistory }) },
        ],
        temperature: 0.3,
        maxTokens: 2048,
        timeoutMs: 45_000,
      });
      if (!result.ok) {
        console.warn("[detectAndClarify] LLM call failed:", result.error, "| raw:", (result.raw || "").slice(0, 200));
      }
      if (result.ok && result.data) {
        const data = result.data;
        // Flexible question parsing — no rigid count/option limits
        const questions = Array.isArray(data.clarifyingQuestions)
          ? data.clarifyingQuestions.map((q) => ({
              id: toText(q.id, "q"),
              question: toText(q.question, ""),
              purpose: toText(q.purpose, ""),
              options: Array.isArray(q.options)
                ? q.options.map((o) => ({ value: toText(o.value, ""), label: toText(o.label, "") })).filter((o) => o.value && o.label)
                : [],
            })).filter((q) => q.question)
          : [];
        // Parse featureConcept flexibly — handle string or object
        let concept = null;
        if (data.featureConcept && typeof data.featureConcept === "object") {
          concept = {
            name: toText(data.featureConcept.name, "custom_feature"),
            description: toText(data.featureConcept.description, ""),
            category: toText(data.featureConcept.category, "custom"),
            indicatorHint: toText(data.featureConcept.indicatorHint, ""),
            technicalApproach: toText(data.featureConcept.technicalApproach, ""),
          };
        } else if (typeof data.featureConcept === "string" && data.featureConcept.trim()) {
          // LLM returned a string name instead of object — construct concept from it
          concept = {
            name: toText(data.featureConcept, "custom_feature").toLowerCase().replace(/[^a-z0-9_]/g, "_"),
            description: toText(data.headline || data.featureConcept, ""),
            category: "custom",
            indicatorHint: "",
            technicalApproach: "",
          };
        }
        // intentDetected should be true even if featureConcept is minimal but headline exists
        const hasIntent = Boolean(data.intentDetected);
        const hasMinimalConcept = concept !== null || Boolean(toText(data.headline, ""));
        if (!hasIntent && concept) {
          console.warn("[detectAndClarify] LLM returned featureConcept but intentDetected=false. Headline:", toText(data.headline, "none"));
        }
        // If no concept but has headline, create a minimal concept from headline
        if (hasIntent && !concept && toText(data.headline, "")) {
          concept = {
            name: "custom_feature",
            description: toText(data.headline, ""),
            category: "custom",
            indicatorHint: "",
            technicalApproach: "",
          };
        }
        return {
          ok: true,
          intentDetected: hasIntent && hasMinimalConcept,
          confidence: clampNumber(data.confidence, 0, 1, 0.7),
          headline: toText(data.headline, ""),
          featureConcept: concept,
          clarifyingQuestions: questions,
          source: "llm",
        };
      }
    } catch (err) {
      console.warn("[detectAndClarify] exception:", String(err?.message || err).slice(0, 200));
    }

    // Fallback: use heuristic intent detection without questions
    const heuristic = await intentDetector.detectIntent({ userMessage, assistantReply });
    if (heuristic.intentDetected && heuristic.candidates?.length) {
      const first = heuristic.candidates[0];
      return {
        ok: true,
        intentDetected: true,
        confidence: heuristic.confidence,
        headline: `检测到你可能需要一个${toText(first.feature?.description || first.title, "交易特征")}`,
        featureConcept: {
          name: toText(first.feature?.name, "custom_feature"),
          description: toText(first.feature?.description, ""),
          category: toText(first.feature?.group, "custom"),
          indicatorHint: toText(first.feature?.kind, ""),
        },
        clarifyingQuestions: [
          {
            id: "confirm",
            question: "这个理解对吗？",
            options: [
              { value: "yes", label: "对，就是这个" },
              { value: "close", label: "差不多，可以在此基础上调整" },
              { value: "no", label: "不太对，我再描述一下" },
            ],
          },
        ],
        source: "heuristic",
      };
    }
    return { ok: true, intentDetected: false, headline: "", featureConcept: null, clarifyingQuestions: [] };
  }

  /**
   * Generate a single high-quality feature from user's clarification choices.
   * This is the heavy step — LLM code generation + validation.
   *
   * @param {Object} params
   * @param {Object} params.featureConcept - The original concept
   * @param {Object} params.userChoices - User's selected options { questionId: selectedValue }
   * @param {string} params.userMessage - Original user message
   * @param {string} params.assistantReply - Original assistant reply
   * @returns {Promise<Object>} { ok, feature, generatedCode, resultSummary }
   */
  async function generateFromClarification(params = {}) {
    const featureConcept = params.featureConcept && typeof params.featureConcept === "object"
      ? params.featureConcept : {};
    const userChoices = params.userChoices && typeof params.userChoices === "object"
      ? params.userChoices : {};
    const onProgress = typeof params.onProgress === "function"
      ? params.onProgress
      : null;
    async function reportProgress(payloadLike) {
      if (!onProgress) return;
      await Promise.resolve(onProgress(payloadLike));
    }
    const generationPlan = params.generationPlan && typeof params.generationPlan === "object"
      ? normalizePlanArtifact(params.generationPlan)
      : null;
    const feature = buildFeatureFromClarificationDraft({
      featureConcept,
      userChoices,
    });
    const specArtifact = buildFeatureSpecArtifact({
      feature,
      featureConcept,
      userChoices,
      planArtifact: generationPlan,
    });
    const resultSummary = toText(
      featureConcept.description,
      `${toText(feature.name, "该特征")}会根据你确认的方向生成，并在后续运行与检测中验证可用性。`,
    );

    await reportProgress({
      phase: "spec_lock",
      title: "架构设计",
      status: "done",
      message: "已确认特征架构设计。",
      details: {
        specArtifact,
        actionLabel: "spec_locked",
        executionMode: "spec_inference",
      },
    });
    await reportProgress({
      phase: "write",
      title: "首版代码",
      attempt: 1,
      status: "running",
      message: "正在生成首版代码...",
      details: {
        specArtifact,
        actionLabel: "code_generation_start",
        executionMode: "code_generation",
      },
    });

    const codeResult = await codeGenerator.generateCodeStream({
      ...feature,
      specArtifact,
    }, {
      async onChunk(chunkLike) {
        const chunk = chunkLike && typeof chunkLike === "object" ? chunkLike : {};
        await reportProgress({
          phase: "write",
          title: "首版代码",
          attempt: 1,
          status: chunk.done ? "done" : "running",
          message: chunk.done ? "已拿到首版代码，准备开始运行与检测。" : "正在生成首版代码...",
          details: {
            codeSnippet: toText(chunk.codeSnippet, ""),
            codeSource: toText(chunk.source, "llm_stream"),
            specArtifact,
            actionLabel: chunk.done ? "code_generation_done" : "code_generation_chunk",
            executionMode: toText(chunk.source, "llm_stream"),
            streamMode: "code_accumulate",
          },
        });
      },
    });

    if (!codeResult.ok || !codeResult.code?.featureCode) {
      return {
        ok: false,
        feature,
        generatedCode: null,
        resultSummary: resultSummary || "特征代码生成失败",
        source: toText(codeResult.source, "code_generation"),
        error: toText(codeResult.error, "generatedCode.featureCode is required"),
        planArtifact: generationPlan,
        specArtifact,
      };
    }
    const code = codeResult.code;
    const draftCodeSource = toText(codeResult.source, "llm_stream");

    if (params.skipValidation === true) {
      return {
        ok: true,
        feature: { ...feature, specArtifact },
        generatedCode: attachCodeArtifacts({
          ...code,
          codeSource: draftCodeSource,
          validatedAt: null,
          validationErrors: [],
          validationWarnings: [],
        }, { specArtifact }),
        resultSummary,
        source: draftCodeSource,
        planArtifact: generationPlan,
        specArtifact,
      };
    }

    let validation = codeValidator.validate(code, {
      featureName: feature.name || featureConcept.name,
      specArtifact,
    });
    let finalCode = attachCodeArtifacts(code, {
      specArtifact,
      failureType: validation.failureType,
      validationLayers: {
        engineering: validation.engineering,
        numeric: validation.numeric,
        semantic: validation.semantic,
      },
      runArtifacts: buildRunArtifacts({
        mockValidation: validation.runtimeArtifacts,
      }),
    });
    let codeSource = "llm";
    if (templateCode) codeSource = "template";

    if (!validation.valid) {
      let repairHistory = buildRepairHistory({
        featureSpec: { ...feature, specArtifact },
        originalCode: finalCode,
        errors: validation.errors,
        specArtifact,
        failureType: validation.failureType,
        rootCauseHypothesis: validation.errors[0] || "",
        repairGoal: "修复失败并保持原始 spec 与用户选择不变。",
        stats: validation.numeric?.stats || validation.semantic?.stats || validation.runtimeArtifacts?.stats || null,
        runContext: buildRunArtifacts({
          mockValidation: validation.runtimeArtifacts,
        }),
        preservedConstraints: specArtifact.preservedConstraints || [],
      });
      let lastValidation = validation;
      for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt++) {
        const previousCode = finalCode;
        repairHistory.push({
          role: "assistant",
          content: JSON.stringify(finalCode),
        });
        repairHistory.push({
          role: "user",
          content: JSON.stringify({
            validationErrors: lastValidation.errors,
            validationWarnings: lastValidation.warnings || [],
          }),
        });
        const repairResult = await codeGenerator.repairCode({
          originalCode: finalCode,
          errors: lastValidation.errors,
          featureSpec: { ...feature, specArtifact },
          specArtifact,
          failureType: lastValidation.failureType,
          rootCauseHypothesis: lastValidation.errors[0] || "",
          repairGoal: "仅做最小必要修改并保持 spec 约束不变。",
          stats: lastValidation.numeric?.stats || lastValidation.semantic?.stats || lastValidation.runtimeArtifacts?.stats || null,
          runContext: buildRunArtifacts({
            mockValidation: lastValidation.runtimeArtifacts,
          }),
          preservedConstraints: specArtifact.preservedConstraints || [],
          messages: repairHistory,
        });
        if (!repairResult.ok) break;
        const revalidation = codeValidator.validate(repairResult.code, {
          featureName: feature.name || featureConcept.name,
          specArtifact,
        });
        finalCode = attachCodeArtifacts(repairResult.code, {
          specArtifact,
          failureType: revalidation.failureType,
          repairSummary: repairResult.code?.repairSummary || null,
          codeDiff: buildCodeDiffArtifact(previousCode?.featureCode, repairResult.code?.featureCode),
          validationLayers: {
            engineering: revalidation.engineering,
            numeric: revalidation.numeric,
            semantic: revalidation.semantic,
          },
          runArtifacts: buildRunArtifacts({
            mockValidation: revalidation.runtimeArtifacts,
          }),
        });
        codeSource = "llm_repair";
        lastValidation = revalidation;
        if (revalidation.valid) {
          return {
            ok: true,
            feature: { ...feature, specArtifact },
            generatedCode: attachCodeArtifacts({
              ...finalCode,
              codeSource,
              validatedAt: nowIso(),
              validationErrors: [],
              validationWarnings: revalidation.warnings || [],
            }, { specArtifact }),
            resultSummary,
            source: codeSource,
            planArtifact: generationPlan,
            specArtifact,
          };
        }
      }
      return {
        ok: false,
        feature: { ...feature, specArtifact },
        generatedCode: attachCodeArtifacts({
          ...finalCode,
          codeSource,
          validatedAt: null,
          validationErrors: lastValidation.errors,
          validationWarnings: lastValidation.warnings || [],
        }, { specArtifact }),
        resultSummary: `${resultSummary}\n（代码验证未通过：${validation.errors.join("; ")}）`,
        source: codeSource,
        planArtifact: generationPlan,
        specArtifact,
      };
    }

    return {
      ok: true,
      feature: { ...feature, specArtifact },
      generatedCode: attachCodeArtifacts({
        ...finalCode,
        codeSource,
        validatedAt: nowIso(),
        validationErrors: [],
        validationWarnings: validation.warnings || [],
      }, { specArtifact }),
      resultSummary,
      source: codeSource,
      planArtifact: generationPlan,
      specArtifact,
    };
  }

  async function reasonFromClarification(params = {}) {
    const featureConcept = params.featureConcept && typeof params.featureConcept === "object"
      ? params.featureConcept : {};
    const userChoices = params.userChoices && typeof params.userChoices === "object"
      ? params.userChoices : {};
    const onChunk = typeof params.onChunk === "function" ? params.onChunk : null;
    const messages = [
      { role: "system", content: FEATURE_REASONING_SYSTEM_PROMPT + toText(params.memoryContext, "") },
      { role: "user", content: buildFeatureReasoningUserMessage({
        userMessage: params.userMessage,
        assistantReply: params.assistantReply,
        featureConcept,
        userChoices,
        conversationHistory: params.conversationHistory,
      }) },
    ];
    let rawText = "";
    if (llmClient && typeof llmClient.chatCompletionStream === "function") {
      let pending = "";
      async function flushPending(done = false) {
        const chunkText = pending;
        pending = "";
        if (!chunkText && !done) return;
        if (onChunk && chunkText) {
          await Promise.resolve(onChunk({
            delta: chunkText,
            text: rawText,
            done,
          }));
        }
      }
      for await (const event of llmClient.chatCompletionStream({
        messages,
        temperature: 0.2,
        maxTokens: 1800,
        timeoutMs: 60_000,
      })) {
        if (event?.type === "error") {
          throw new Error(toText(event.error, "reasoning generation failed"));
        }
        if (event?.type !== "token") continue;
        const token = toText(event.text, "");
        if (!token) continue;
        rawText += token;
        pending += token;
        const shouldFlush = pending.length >= 48 || /[，。！？；\n]$/.test(pending);
        if (shouldFlush) {
          await flushPending(false);
        }
      }
      await flushPending(true);
    } else {
      const result = await llmClient.chatCompletion({
        messages,
        temperature: 0.2,
        maxTokens: 1800,
        timeoutMs: 60_000,
      });
      if (!result.ok) {
        throw new Error(toText(result.error, "reasoning generation failed"));
      }
      rawText = toText(result.text, "");
      if (onChunk && rawText) {
        await Promise.resolve(onChunk({
          delta: rawText,
          text: rawText,
          done: true,
        }));
      }
    }
    const normalized = normalizeReasoningArtifact(rawText);
    if (!normalized.lines.length) {
      throw new Error("reasoning lines is empty");
    }
    return {
      ok: true,
      reasoningArtifact: normalized,
      source: "llm",
    };
  }

  async function planFromReasoning(params = {}) {
    const featureConcept = params.featureConcept && typeof params.featureConcept === "object"
      ? params.featureConcept : {};
    const userChoices = params.userChoices && typeof params.userChoices === "object"
      ? params.userChoices : {};
    const reasoningArtifact = params.reasoningArtifact && typeof params.reasoningArtifact === "object"
      ? params.reasoningArtifact
      : null;
    if (!reasoningArtifact) {
      throw new Error("reasoningArtifact is required");
    }
    const result = await llmClient.chatCompletionJson({
      messages: [
        { role: "system", content: FEATURE_PLAN_FROM_REASONING_SYSTEM_PROMPT + toText(params.memoryContext, "") },
        { role: "user", content: buildPlanFromReasoningUserMessage({
          userMessage: params.userMessage,
          assistantReply: params.assistantReply,
          featureConcept,
          userChoices,
          reasoningArtifact,
          conversationHistory: params.conversationHistory,
        }) },
      ],
      temperature: 0.2,
      maxTokens: 1600,
      timeoutMs: 60_000,
    });
    if (!result.ok || !result.data || typeof result.data !== "object") {
      throw new Error(toText(result.error, "plan generation from reasoning failed"));
    }
    return {
      ok: true,
      planArtifact: normalizePlanArtifact(result.data),
      source: "llm",
    };
  }

  /**
   * Agent Loop: generate code with real feature evaluation verification.
   *
   * Loop:
 * 1. Generate code
   * 2. Validate (syntax + runtime mock)
   * 3. Run real feature evaluation on OHLCV data (if backtestEngine provided)
   * 4. Check evaluation quality (all NaN? all zeros? runtime error?)
   * 5. If issues → feed error context back to LLM → regenerate
   * 6. Max N rounds (default 3)
   *
   * If the code needs user-provided config (API key etc.), returns
   * { status: "needs_user_input", requiredConfig: [...] } without failing.
   *
   * @param {Object} params
   * @param {Object} params.feature - Feature spec
   * @param {Object} [params.backtestEngine] - Freqtrade backtest adapter
   * @param {number} [params.maxRounds=3] - Max repair rounds
   * @param {Object} [params.userConfig] - User-provided config values
   * @returns {Promise<Object>} { ok, code, evalResult, rounds, errors }
   */
  async function generateWithAgentLoop(params = {}) {
    const feature = params.feature;
    if (!feature || !feature.name) {
      return { ok: false, error: "Feature name is required", rounds: 0 };
    }
    const backtestEngine = params.backtestEngine || null;
    const maxRounds = Math.max(1, Math.min(5, Number(params.maxRounds || 3) || 3));
    const userConfig = params.userConfig && typeof params.userConfig === "object" ? params.userConfig : {};
    const onProgress = typeof params.onProgress === "function" ? params.onProgress : null;
    async function reportProgress(payloadLike) {
      if (!onProgress) return;
      await Promise.resolve(onProgress(payloadLike));
    }
    const initialCode = params.initialCode && typeof params.initialCode === "object" ? params.initialCode : null;
    const suppressInitialWriteProgress = params.suppressInitialWriteProgress === true;
    const specArtifact = feature.specArtifact && typeof feature.specArtifact === "object"
      ? cloneStructured(feature.specArtifact)
      : buildFeatureSpecArtifact({ feature });
    const evaluationInput = {
      pair: toText(params.pair, "BTC/USDT"),
      timeframe: toText(params.timeframe, "1h"),
      rangeDays: Math.max(1, Math.min(365, Number(params.rangeDays || 14) || 14)),
      barCount: Array.isArray(params.bars) ? params.bars.length : 0,
    };

    const loopErrors = [];
    const loopFailures = [];
    let finalCode = null;
    let finalEvalResult = null;
    let codeSource = "";
    let latestFailure = null;

    for (let round = 0; round < maxRounds; round++) {
      const attempt = round + 1;
      let codeResult;
      if (!(round === 0 && suppressInitialWriteProgress)) {
        await reportProgress({
          phase: round === 0 ? "write" : "repair",
          title: round === 0 ? "首版代码" : `第 ${attempt} 轮修复`,
          attempt,
          status: "running",
          message: round === 0
            ? (initialCode?.featureCode ? "正在整理首版代码，准备进入运行与检测。" : "正在生成首版代码...")
            : "正在根据上一轮检测结果修复代码...",
          details: {
            actionLabel: round === 0 ? "code_generation" : "code_repair",
            executionMode: round === 0 ? "llm_or_template_generation" : "llm_repair",
            fixSummary: round === 0 ? "代码生成中，完成后会立刻进入运行与检测。" : `第 ${attempt} 轮正在修复上一轮发现的问题。`,
          },
        });
      }
      if (round === 0) {
        codeResult = initialCode?.featureCode
          ? { ok: true, code: initialCode, source: toText(initialCode.codeSource, "llm_initial") }
          : await codeGenerator.generateCode({ ...feature, specArtifact });
      } else {
        let repairHistory = buildRepairHistory({
          featureSpec: { ...feature, specArtifact },
          originalCode: finalCode || {},
          errors: loopErrors.slice(-3),
          specArtifact,
          failureType: latestFailure?.failureType || "",
          rootCauseHypothesis: latestFailure?.rootCauseHypothesis || loopErrors.slice(-1)[0] || "",
          repairGoal: latestFailure?.repairGoal || "仅做最小必要修改并重新通过验证。",
          stats: latestFailure?.stats || null,
          runContext: latestFailure?.runContext || null,
          preservedConstraints: specArtifact.preservedConstraints || [],
        });
        repairHistory.push({
          role: "assistant",
          content: JSON.stringify(finalCode || {}),
        });
        repairHistory.push({
          role: "user",
          content: buildCodeRepairUserMessage({
            originalCode: finalCode || {},
            lastCode: finalCode || {},
            errors: latestFailure?.issues?.length ? latestFailure.issues : loopErrors.slice(-3),
            featureSpec: feature,
            specArtifact,
            failureType: latestFailure?.failureType || "",
            rootCauseHypothesis: latestFailure?.rootCauseHypothesis || loopErrors.slice(-1)[0] || "",
            repairGoal: latestFailure?.repairGoal || "仅做最小必要修改并重新通过验证。",
            stats: latestFailure?.stats || null,
            runContext: latestFailure?.runContext || null,
            preservedConstraints: specArtifact.preservedConstraints || [],
          }),
        });
        codeResult = await codeGenerator.repairCode({
          originalCode: finalCode || {},
          errors: latestFailure?.issues?.length ? latestFailure.issues : loopErrors.slice(-3),
          featureSpec: { ...feature, specArtifact },
          specArtifact,
          failureType: latestFailure?.failureType || "",
          rootCauseHypothesis: latestFailure?.rootCauseHypothesis || loopErrors.slice(-1)[0] || "",
          repairGoal: latestFailure?.repairGoal || "仅做最小必要修改并重新通过验证。",
          stats: latestFailure?.stats || null,
          runContext: latestFailure?.runContext || null,
          preservedConstraints: specArtifact.preservedConstraints || [],
          messages: repairHistory,
        });
      }
      if (!(round === 0 && suppressInitialWriteProgress)) {
        const diffArtifact = round > 0
          ? buildCodeDiffArtifact(finalCode?.featureCode, codeResult.code?.featureCode)
          : null;
        await reportProgress({
          phase: round === 0 ? "write" : "repair",
          title: round === 0 ? "首版代码" : `第 ${attempt} 轮修复`,
          attempt,
          status: codeResult.ok && codeResult.code?.featureCode ? "done" : "error",
          message: round === 0
            ? "已拿到首版代码，准备开始运行与检测。"
            : "已完成修复，准备重新运行与检测。",
          details: {
            codeSnippet: toText(codeResult.code?.featureCode, "").slice(0, 2400),
            codeSource: toText(codeResult.source, round === 0 ? "llm" : "llm_repair"),
            specArtifact,
            repairSummary: codeResult.code?.repairSummary || null,
            codeDiff: diffArtifact,
            actionLabel: round === 0 ? "code_ready" : "repair_ready",
            executionMode: round === 0 ? "code_generation" : "code_repair",
            fixSummary: round === 0
              ? "已生成首版代码，接下来进入工程、数值和语义检测。"
              : (codeResult.code?.repairSummary?.changes?.join("；") || `第 ${attempt} 轮基于上一版代码继续修复`),
          },
        });
      }
      if (!codeResult.ok || !codeResult.code?.featureCode) {
        loopErrors.push(`Round ${attempt}: code generation failed: ${toText(codeResult.error, "unknown error")}`);
        latestFailure = buildFailureArtifact({
          stage: "engineering",
          failureType: "runtime_contract_error",
          errors: [loopErrors.slice(-1)[0]],
          repairGoal: "修复生成失败问题，拿到一份可运行的完整代码。",
          runContext: { attempt },
        });
        loopFailures.push(latestFailure);
        continue;
      }
      const diffArtifact = round > 0
        ? buildCodeDiffArtifact(finalCode?.featureCode, codeResult.code?.featureCode)
        : null;
      finalCode = attachCodeArtifacts(codeResult.code, {
        specArtifact,
        repairSummary: codeResult.code?.repairSummary || null,
        codeDiff: diffArtifact,
      });
      codeSource = codeResult.source || (round === 0 ? "llm" : "llm_repair");

      await reportProgress({
          phase: "run",
          title: `第 ${attempt} 轮运行`,
          attempt,
          status: "running",
          message: "正在执行语法检查与 mock DataFrame 运行验证。",
          details: {
            actionLabel: "mock_eval_start",
            executionMode: "mock_dataframe_validation",
            codeSnippet: toText(finalCode.featureCode, "").slice(0, 2400),
          },
        });
      const engineering = codeValidator.validateEngineering(finalCode);
      if (!engineering.valid) {
        latestFailure = buildFailureArtifact({
          stage: "engineering",
          failureType: "",
          errors: engineering.errors,
          warnings: engineering.warnings,
          rootCauseHypothesis: engineering.errors[0] || "",
          repairGoal: "修复语法、返回契约、长度或 DataFrame 污染问题。",
          stats: engineering.runtimeArtifacts?.stats || null,
          runContext: buildRunArtifacts({
            mockValidation: engineering.runtimeArtifacts,
          }),
        });
        latestFailure.failureType = toText(
          latestFailure.failureType,
          codeValidator.validate(finalCode, { featureName: feature.name, specArtifact }).failureType || "runtime_contract_error",
        );
        loopFailures.push(latestFailure);
        loopErrors.push(`Round ${attempt} validation: ${engineering.errors.join("; ")}`);
        await reportProgress({
            phase: "detect",
            title: `第 ${attempt} 轮检测`,
            attempt,
            status: "error",
            message: "结构或 mock 运行未通过，准备继续修复。",
            details: {
              failureType: latestFailure.failureType,
              issues: engineering.errors,
              warnings: engineering.warnings || [],
              runArtifacts: buildRunArtifacts({
                mockValidation: engineering.runtimeArtifacts,
              }),
            },
          });
        continue;
      }
      await reportProgress({
          phase: "run",
          title: `第 ${attempt} 轮运行`,
          attempt,
          status: "running",
          message: "mock 校验通过，正在执行真实特征评估。",
          details: {
            actionLabel: "feature_eval_start",
            executionMode: "real_feature_evaluation",
            warnings: engineering.warnings || [],
            runArtifacts: buildRunArtifacts({
              mockValidation: engineering.runtimeArtifacts,
            }),
          },
        });

      if (backtestEngine && typeof backtestEngine.runFeatureEvaluation === "function") {
        try {
          const prevEnv = {};
          if (userConfig) {
            Object.entries(userConfig).forEach(([key, value]) => {
              if (key && value) {
                prevEnv[key] = process.env[key] || "";
                process.env[key] = String(value);
              }
            });
          }

          const evalResult = await backtestEngine.runFeatureEvaluation({
            features: [{
              name: feature.name,
              generatedCode: finalCode,
            }],
            rangeDays: evaluationInput.rangeDays,
            pair: evaluationInput.pair,
            timeframe: evaluationInput.timeframe,
            bars: Array.isArray(params.bars) ? params.bars : undefined,
          });

          Object.entries(prevEnv).forEach(([key, value]) => {
            if (value) process.env[key] = value;
            else delete process.env[key];
          });

          if (!evalResult.ok) {
            latestFailure = buildFailureArtifact({
              stage: "numeric",
              failureType: /network|timeout|api|unavailable/i.test(toText(evalResult.error, ""))
                ? "external_data_unavailable"
                : "runtime_contract_error",
              errors: [toText(evalResult.error, "evaluation failed")],
              repairGoal: "修复真实运行失败问题，确保在真实 OHLCV 数据上可执行。",
              runContext: {
                ...evaluationInput,
                stage: "feature_evaluation",
              },
            });
            loopFailures.push(latestFailure);
            loopErrors.push(`Round ${attempt} evaluation: ${toText(evalResult.error, "evaluation failed")}`);
            await reportProgress({
                phase: "detect",
                title: `第 ${attempt} 轮检测`,
                attempt,
                status: "error",
                message: "真实特征评估失败，准备继续修复。",
                details: {
                  failureType: latestFailure.failureType,
                  issues: [toText(evalResult.error, "evaluation failed")],
                },
              });
            continue;
          }

          finalEvalResult = evalResult;
          const numeric = codeValidator.validateNumeric(finalCode, engineering.runtimeArtifacts, {
            featureName: feature.name,
            specArtifact,
            evaluationResult: evalResult,
          });
          const semantic = codeValidator.validateSemantic(finalCode, engineering.runtimeArtifacts, {
            featureName: feature.name,
            specArtifact,
            evaluationResult: evalResult,
          });
          const runArtifacts = buildRunArtifacts({
            mockValidation: engineering.runtimeArtifacts,
            evaluationInput: {
              ...evaluationInput,
              barCount: evalResult.barCount || evaluationInput.barCount,
            },
            evaluationOutput: {
              pair: evalResult.pair,
              timeframe: evalResult.timeframe,
              rangeDays: evalResult.rangeDays,
              barCount: evalResult.barCount || 0,
              featureColumns: evalResult.featureColumns || [],
              stats: evalResult.featureStats || {},
            },
            logs: evalResult.logs || null,
            samples: {
              timeSeries: Array.isArray(evalResult.featureTimeSeries)
                ? evalResult.featureTimeSeries.slice(0, 12)
                : [],
            },
          });
          await reportProgress({
              phase: "run",
              title: `第 ${attempt} 轮运行`,
              attempt,
              status: "done",
              message: "真实评估完成，已拿到统计结果。",
              details: {
                actionLabel: "feature_eval_done",
                executionMode: "real_feature_evaluation",
                runResult: {
                  barCount: evalResult.barCount || 0,
                  stats: numeric.stats || semantic.stats || null,
                  columns: evalResult.featureColumns || [],
                },
                runArtifacts,
              },
            });
            await reportProgress({
              phase: "detect",
              title: `第 ${attempt} 轮检测`,
              attempt,
              status: "running",
              message: "正在根据真实评估结果检查数值质量与语义约束。",
              details: {
                actionLabel: "spec_and_quality_check",
                executionMode: "post_eval_detection",
                warnings: [...(engineering.warnings || []), ...(numeric.warnings || []), ...(semantic.warnings || [])],
                runArtifacts,
              },
            });

          if (!numeric.valid || !semantic.valid) {
            const failingStage = !numeric.valid ? "numeric" : "semantic";
            const failingErrors = !numeric.valid ? numeric.errors : semantic.errors;
            const failingWarnings = !numeric.valid ? numeric.warnings : semantic.warnings;
            latestFailure = buildFailureArtifact({
              stage: failingStage,
              failureType: !numeric.valid ? "low_variance" : "semantics_mismatch",
              errors: failingErrors,
              warnings: failingWarnings,
              repairGoal: !numeric.valid
                ? "修复数值质量问题，使输出不再全零、全 NaN 或低波动。"
                : "修复语义问题，使输出重新符合 spec 中的范围、类型和输入约束。",
              stats: (!numeric.valid ? numeric.stats : semantic.stats) || null,
              runContext: runArtifacts,
            });
            latestFailure.failureType = !numeric.valid
              ? (numeric.errors.join(" ").toLowerCase().includes("nan")
                ? "all_nan"
                : (numeric.errors.join(" ").toLowerCase().includes("零") || numeric.errors.join(" ").toLowerCase().includes("zero")
                  ? "all_zero"
                  : "low_variance"))
              : "semantics_mismatch";
            loopFailures.push(latestFailure);
            loopErrors.push(`Round ${attempt} ${failingStage}: ${failingErrors.join("; ")}`);
            await reportProgress({
                phase: "detect",
                title: `第 ${attempt} 轮检测`,
                attempt,
                status: "error",
                message: !numeric.valid
                  ? "真实运行后发现数值质量问题，准备修复。"
                  : "真实运行后发现语义与 spec 不匹配，准备修复。",
                details: {
                  failureType: latestFailure.failureType,
                  issues: failingErrors,
                  warnings: failingWarnings,
                  runResult: {
                    barCount: evalResult.barCount || 0,
                    stats: (numeric.stats || semantic.stats) || null,
                    columns: evalResult.featureColumns || [],
                  },
                  runArtifacts,
                },
              });
            continue;
          }

          await reportProgress({
              phase: "detect",
              title: `第 ${attempt} 轮检测`,
              attempt,
              status: "done",
              message: "真实评估通过，当前代码可作为最终结果。",
              details: {
                failureType: "",
                specArtifact,
                repairSummary: finalCode.repairSummary || null,
                codeDiff: finalCode.codeDiff || null,
                runResult: {
                  barCount: evalResult.barCount || 0,
                  stats: numeric.stats || semantic.stats || null,
                  columns: evalResult.featureColumns || [],
                },
                warnings: [...(engineering.warnings || []), ...(numeric.warnings || []), ...(semantic.warnings || [])],
                runArtifacts,
              },
            });
          return {
            ok: true,
            code: attachCodeArtifacts({
              ...finalCode,
              codeSource,
              validatedAt: nowIso(),
              validationErrors: [],
              validationWarnings: [...(engineering.warnings || []), ...(numeric.warnings || []), ...(semantic.warnings || [])],
            }, {
              specArtifact,
              failureType: "",
              runArtifacts,
              validationLayers: {
                engineering,
                numeric,
                semantic,
              },
            }),
            evalResult: {
              barCount: evalResult.barCount || 0,
              stats: numeric.stats || semantic.stats || null,
              columns: evalResult.featureColumns || [],
              pair: evalResult.pair,
              timeframe: evalResult.timeframe,
              rangeDays: evalResult.rangeDays,
            },
            rounds: round + 1,
            errors: loopErrors,
            failures: loopFailures,
            specArtifact,
          };
        } catch (evalError) {
          latestFailure = buildFailureArtifact({
            stage: "numeric",
            failureType: "runtime_contract_error",
            errors: [toText(evalError?.message || evalError, "evaluation error")],
            repairGoal: "修复真实评估阶段异常，确保代码能在真实数据上执行。",
            runContext: { ...evaluationInput, stage: "feature_evaluation" },
          });
          loopFailures.push(latestFailure);
          loopErrors.push(`Round ${attempt} eval error: ${toText(evalError?.message || evalError)}`);
          await reportProgress({
              phase: "detect",
              title: `第 ${attempt} 轮检测`,
              attempt,
              status: "error",
              message: "真实评估阶段出现异常，准备继续修复。",
              details: {
                failureType: latestFailure.failureType,
                issues: [toText(evalError?.message || evalError, "evaluation error")],
              },
            });
          continue;
        }
      } else {
        await reportProgress({
            phase: "detect",
            title: `第 ${attempt} 轮检测`,
            attempt,
            status: "done",
            message: "当前环境未启用真实评估，结构校验通过。",
            details: {
              specArtifact,
              warnings: engineering.warnings || [],
              runArtifacts: buildRunArtifacts({
                mockValidation: engineering.runtimeArtifacts,
              }),
            },
          });
        return {
          ok: true,
          code: attachCodeArtifacts({
            ...finalCode,
            codeSource,
            validatedAt: nowIso(),
            validationErrors: [],
            validationWarnings: engineering.warnings || [],
          }, {
            specArtifact,
            failureType: "",
            runArtifacts: buildRunArtifacts({
              mockValidation: engineering.runtimeArtifacts,
            }),
            validationLayers: {
              engineering,
              numeric: null,
              semantic: null,
            },
          }),
          evalResult: null,
          rounds: round + 1,
          errors: loopErrors,
          failures: loopFailures,
          specArtifact,
        };
      }
    }

    // Check if the code needs user config (API key etc.)
    const reqConfig = finalCode?.requiredConfig || [];
    const missingConfig = reqConfig.filter((c) => !userConfig[c.key]);
    if (missingConfig.length > 0) {
      return {
        ok: false,
        status: "needs_user_input",
        requiredConfig: missingConfig,
        code: finalCode ? attachCodeArtifacts({
          ...finalCode,
          codeSource,
          validatedAt: null,
        }, { specArtifact, failureType: latestFailure?.failureType || "" }) : null,
        rounds: maxRounds,
        errors: loopErrors,
        failures: loopFailures,
        error: `需要用户提供配置：${missingConfig.map((c) => c.label || c.key).join("、")}`,
        specArtifact,
      };
    }

    return {
      ok: false,
      code: finalCode ? attachCodeArtifacts({ ...finalCode, codeSource, validatedAt: null }, {
        specArtifact,
        failureType: latestFailure?.failureType || "",
      }) : null,
      evalResult: null,
      rounds: maxRounds,
      errors: loopErrors,
      failures: loopFailures,
      error: `经过 ${maxRounds} 轮尝试后仍未通过验证：${loopErrors.slice(-2).join("; ")}`,
      specArtifact,
    };
  }

  /**
   * Health check for the pipeline (tests current model connectivity).
   */
  async function healthCheck() {
    return llmClient.ping();
  }

  return {
    run,
    generateAndValidate,
    generateWithAgentLoop,
    detectAndClarify,
    reasonFromClarification,
    planFromReasoning,
    generateFromClarification,
    healthCheck,
    intentDetector,
    codeGenerator,
    codeValidator,
    llmClient,
  };
}
