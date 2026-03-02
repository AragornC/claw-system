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
import { createLlmClient, createDeepSeekClient } from "../llm-client.js";
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
 *   Legacy: DeepSeek-only API key getter (backward compat).
 */
export function createFeaturePipeline(deps = {}) {
  let llmClient;
  if (typeof deps.getModelConfig === "function") {
    llmClient = createLlmClient({ getModelConfig: deps.getModelConfig });
  } else {
    // Backward compat: getApiKey → DeepSeek-only client
    llmClient = createDeepSeekClient({
      getApiKey: deps.getApiKey || (() => toText(process.env.DEEPSEEK_API_KEY || "")),
    });
  }
  const intentDetector = createIntentDetector({ deepseekClient: llmClient });
  const codeGenerator = createCodeGenerator({ deepseekClient: llmClient });
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
          codeSource = repairResult.source || "deepseek_repair";
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
        codeSource = repairResult.source || "deepseek_repair";
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
    if (!userMessage && !assistantReply) {
      return { ok: true, intentDetected: false, headline: "", featureConcept: null, clarifyingQuestions: [] };
    }

    try {
      const result = await llmClient.chatCompletionJson({
        messages: [
          { role: "system", content: INTENT_CLARIFICATION_SYSTEM_PROMPT },
          { role: "user", content: buildClarificationUserMessage({ userMessage, assistantReply, conversationHistory }) },
        ],
        temperature: 0.3,
        maxTokens: 2048,
        timeoutMs: 30_000,
      });
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
        const concept = data.featureConcept && typeof data.featureConcept === "object"
          ? {
              name: toText(data.featureConcept.name, "custom_feature"),
              description: toText(data.featureConcept.description, ""),
              category: toText(data.featureConcept.category, "custom"),
              indicatorHint: toText(data.featureConcept.indicatorHint, ""),
              technicalApproach: toText(data.featureConcept.technicalApproach, ""),
            }
          : null;
        return {
          ok: true,
          intentDetected: Boolean(data.intentDetected) && concept !== null,
          confidence: clampNumber(data.confidence, 0, 1, 0.7),
          headline: toText(data.headline, ""),
          featureConcept: concept,
          clarifyingQuestions: questions,
          source: "llm",
        };
      }
    } catch {}

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
          { role: "system", content: FEATURE_FROM_CLARIFICATION_SYSTEM_PROMPT },
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
   * Health check for the pipeline (tests current model connectivity).
   */
  async function healthCheck() {
    return llmClient.ping();
  }

  return {
    run,
    generateAndValidate,
    detectAndClarify,
    generateFromClarification,
    healthCheck,
    intentDetector,
    codeGenerator,
    codeValidator,
    llmClient,
  };
}
