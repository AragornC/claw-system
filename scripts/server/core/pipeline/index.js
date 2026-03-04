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

import { toText, clampNumber, nowIso, parseJsonLoose } from "../../lib/utils.js";

import { createLlmClient } from "../llm-client.js";
import { createIntentDetector } from "./intent-detector.js";
import { createCodeGenerator } from "./code-generator.js";
import { createCodeValidator } from "./code-validator.js";
import {
  INTENT_CLARIFICATION_SYSTEM_PROMPT,
  buildClarificationUserMessage,
  FEATURE_FROM_CLARIFICATION_SYSTEM_PROMPT,
  buildFeatureFromClarificationUserMessage,
} from "./prompts/intent-clarification.js";

const MAX_REPAIR_ATTEMPTS = 2;

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

      // Generate code
      let codeResult = await codeGenerator.generateCode(feature);
      if (!codeResult.ok || !codeResult.code?.indicatorCode) {
        enrichedCandidates.push({
          ...candidate,
          feature: {
            ...feature,
            generatedCode: null,
            codegenStatus: "failed",
            codegenError: "Code generation failed",
          },
        });
        continue;
      }

      // Validate code
      let validation = codeValidator.validate(codeResult.code);
      let finalCode = codeResult.code;
      let codeSource = codeResult.source;

      // Auto-repair loop if validation fails
      if (!validation.valid && codeSource !== "template") {
        for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt++) {
          const repairResult = await codeGenerator.repairCode({
            originalCode: finalCode,
            errors: validation.errors,
            featureSpec: feature,
          });
          if (!repairResult.ok) break;
          finalCode = repairResult.code;
          codeSource = repairResult.source || "llm_repair";
          validation = codeValidator.validate(finalCode);
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

    let codeResult = await codeGenerator.generateCode(feature);
    if (!codeResult.ok || !codeResult.code?.indicatorCode) {
      return { ok: false, error: "Code generation failed" };
    }

    let validation = codeValidator.validate(codeResult.code);
    let finalCode = codeResult.code;
    let codeSource = codeResult.source;

    // Auto-repair
    if (!validation.valid && codeSource !== "template") {
      for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt++) {
        const repairResult = await codeGenerator.repairCode({
          originalCode: finalCode,
          errors: validation.errors,
          featureSpec: feature,
        });
        if (!repairResult.ok) break;
        finalCode = repairResult.code;
        codeSource = repairResult.source || "llm_repair";
        validation = codeValidator.validate(finalCode);
        if (validation.valid) break;
      }
    }

    return {
      ok: validation.valid,
      code: {
        ...finalCode,
        codeSource,
        validatedAt: validation.valid ? nowIso() : null,
        validationErrors: validation.errors,
        validationWarnings: validation.warnings || [],
      },
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

    // Step 1: Ask LLM to generate feature + code based on concept + user choices
    let llmResult;
    try {
      llmResult = await llmClient.chatCompletionJson({
        messages: [
          { role: "system", content: FEATURE_FROM_CLARIFICATION_SYSTEM_PROMPT + toText(params.memoryContext, "") },
          { role: "user", content: buildFeatureFromClarificationUserMessage({
            userMessage: params.userMessage,
            assistantReply: params.assistantReply,
            featureConcept,
            userChoices,
            conversationHistory: params.conversationHistory,
          }) },
        ],
        temperature: 0.2,
        maxTokens: 3072,
        timeoutMs: 90_000,
      });
    } catch (err) {
      return { ok: false, error: `LLM error: ${toText(err?.message || err)}` };
    }
    if (!llmResult.ok || !llmResult.data) {
      // Fallback: use template code generation
      const name = toText(featureConcept.name, "custom_feature");
      const result = await generateAndValidate({
        name,
        group: toText(featureConcept.category, "custom"),
        kind: toText(featureConcept.indicatorHint, "custom"),
        description: toText(featureConcept.description, ""),
        params: userChoices,
      });
      return {
        ok: result.ok,
        feature: { name, group: toText(featureConcept.category, "custom"), kind: "custom", description: toText(featureConcept.description, ""), params: userChoices },
        generatedCode: result.code || null,
        resultSummary: result.ok
          ? `已生成特征「${name}」，基于你的偏好选择使用了模板代码。`
          : `特征生成失败：${(result.errors || []).join("; ")}`,
        source: "template_fallback",
      };
    }

    const data = llmResult.data;
    const feature = data.feature && typeof data.feature === "object" ? data.feature : {};
    const code = data.generatedCode && typeof data.generatedCode === "object" ? data.generatedCode : {};
    const resultSummary = toText(data.resultSummary, "");

    // Step 2: Validate the generated code
    if (!code.indicatorCode) {
      // Try template fallback
      const name = toText(feature.name || featureConcept.name, "custom_feature");
      const templateResult = await generateAndValidate({
        name, group: toText(feature.group, "custom"),
        kind: toText(feature.kind, "custom"),
        description: toText(feature.description, ""),
        params: { ...userChoices, ...(feature.params || {}) },
      });
      return {
        ok: templateResult.ok,
        feature: { ...feature, name },
        generatedCode: templateResult.code || null,
        resultSummary: resultSummary || (templateResult.ok ? `已生成特征「${name}」。` : "特征代码生成失败"),
        source: "template_fallback",
      };
    }

    const validation = codeValidator.validate(code);
    let finalCode = code;
    let codeSource = "llm";

    // Auto-repair if needed
    if (!validation.valid) {
      for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt++) {
        const repairResult = await codeGenerator.repairCode({
          originalCode: finalCode,
          errors: validation.errors,
          featureSpec: feature,
        });
        if (!repairResult.ok) break;
        finalCode = repairResult.code;
        codeSource = "llm_repair";
        const revalidation = codeValidator.validate(finalCode);
        if (revalidation.valid) {
          return {
            ok: true,
            feature,
            generatedCode: { ...finalCode, codeSource, validatedAt: nowIso(), validationErrors: [], validationWarnings: revalidation.warnings || [] },
            resultSummary,
            source: codeSource,
          };
        }
      }
      // Validation still failed, return with errors
      return {
        ok: false,
        feature,
        generatedCode: { ...finalCode, codeSource, validatedAt: null, validationErrors: validation.errors, validationWarnings: validation.warnings || [] },
        resultSummary: `${resultSummary}\n（代码验证未通过：${validation.errors.join("; ")}）`,
        source: codeSource,
      };
    }

    return {
      ok: true,
      feature,
      generatedCode: { ...finalCode, codeSource, validatedAt: nowIso(), validationErrors: [], validationWarnings: validation.warnings || [] },
      resultSummary,
      source: codeSource,
    };
  }

  /**
   * Agent Loop: generate code with real feature evaluation verification.
   *
   * Loop:
   * 1. Generate code (LLM or template)
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

    const loopErrors = [];
    let finalCode = null;
    let finalEvalResult = null;
    let codeSource = "";

    for (let round = 0; round < maxRounds; round++) {
      // Step 1: Generate (or repair) code
      let codeResult;
      if (round === 0) {
        codeResult = await codeGenerator.generateCode(feature);
      } else {
        // Repair with accumulated error context
        codeResult = await codeGenerator.repairCode({
          originalCode: finalCode || {},
          errors: loopErrors.slice(-3),
          featureSpec: feature,
        });
      }
      if (!codeResult.ok || !codeResult.code?.indicatorCode) {
        loopErrors.push(`Round ${round + 1}: code generation failed`);
        continue;
      }
      finalCode = codeResult.code;
      codeSource = codeResult.source || (round === 0 ? "llm" : "llm_repair");

      // Step 2: Validate (syntax + runtime mock)
      const validation = codeValidator.validate(finalCode);
      if (!validation.valid) {
        loopErrors.push(`Round ${round + 1} validation: ${validation.errors.join("; ")}`);
        // Try to repair in next round
        continue;
      }

      // Step 3: Run real feature evaluation (if backtestEngine available)
      if (backtestEngine && typeof backtestEngine.runFeatureEvaluation === "function") {
        try {
          // Inject user config as environment variables for the evaluation
          const prevEnv = {};
          if (userConfig) {
            Object.entries(userConfig).forEach(([key, value]) => {
              if (key && value) {
                prevEnv[key] = process.env[key] || "";
                process.env[key] = String(value);
              }
            });
          }

          const evalResult = backtestEngine.runFeatureEvaluation({
            features: [{
              name: feature.name,
              generatedCode: finalCode,
            }],
            rangeDays: 14,
            pair: "BTC/USDT",
            timeframe: "1h",
          });

          // Restore env
          Object.entries(prevEnv).forEach(([key, value]) => {
            if (value) process.env[key] = value;
            else delete process.env[key];
          });

          if (!evalResult.ok) {
            loopErrors.push(`Round ${round + 1} evaluation: ${toText(evalResult.error, "evaluation failed")}`);
            continue;
          }

          finalEvalResult = evalResult;

          // Step 4: Check evaluation quality
          const stats = evalResult.featureStats || {};
          const featureCol = `tc_feat_${toText(feature.name).toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
          const colStats = stats[featureCol] || null;

          if (colStats) {
            const allNaN = !Number.isFinite(colStats.mean);
            const allZeros = Math.abs(colStats.mean || 0) < 1e-10 && Math.abs(colStats.std || 0) < 1e-10;
            const noVariance = Number.isFinite(colStats.std) && colStats.std < 1e-8 && evalResult.barCount > 10;

            if (allNaN) {
              loopErrors.push(`Round ${round + 1}: feature column '${featureCol}' is all NaN — code may not be computing correctly`);
              continue;
            }
            if (allZeros) {
              loopErrors.push(`Round ${round + 1}: feature column '${featureCol}' is all zeros — code may be using a placeholder or failing silently`);
              continue;
            }
            if (noVariance) {
              loopErrors.push(`Round ${round + 1}: feature column '${featureCol}' has no variance (constant value ${colStats.mean}) — likely not computing a meaningful signal`);
              continue;
            }
          }

          // All checks passed!
          return {
            ok: true,
            code: {
              ...finalCode,
              codeSource,
              validatedAt: nowIso(),
              validationErrors: [],
              validationWarnings: validation.warnings || [],
            },
            evalResult: {
              barCount: evalResult.barCount || 0,
              stats: colStats || null,
              columns: evalResult.featureColumns || [],
            },
            rounds: round + 1,
            errors: loopErrors,
          };
        } catch (evalError) {
          loopErrors.push(`Round ${round + 1} eval error: ${toText(evalError?.message || evalError)}`);
          continue;
        }
      } else {
        // No backtest engine — accept validation-only result
        return {
          ok: true,
          code: {
            ...finalCode,
            codeSource,
            validatedAt: nowIso(),
            validationErrors: [],
            validationWarnings: validation.warnings || [],
          },
          evalResult: null,
          rounds: round + 1,
          errors: loopErrors,
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
        code: finalCode ? {
          ...finalCode,
          codeSource,
          validatedAt: null,
        } : null,
        rounds: maxRounds,
        errors: loopErrors,
        error: `需要用户提供配置：${missingConfig.map((c) => c.label || c.key).join("、")}`,
      };
    }

    return {
      ok: false,
      code: finalCode ? { ...finalCode, codeSource, validatedAt: null } : null,
      evalResult: null,
      rounds: maxRounds,
      errors: loopErrors,
      error: `经过 ${maxRounds} 轮尝试后仍未通过验证：${loopErrors.slice(-2).join("; ")}`,
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
    generateFromClarification,
    healthCheck,
    intentDetector,
    codeGenerator,
    codeValidator,
    llmClient,
  };
}
