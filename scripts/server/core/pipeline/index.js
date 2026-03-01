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
import { createDeepSeekClient } from "../deepseek-client.js";
import { createIntentDetector } from "./intent-detector.js";
import { createCodeGenerator } from "./code-generator.js";
import { createCodeValidator } from "./code-validator.js";

const MAX_REPAIR_ATTEMPTS = 2;

/**
 * Create the full feature generation pipeline.
 * @param {{ getApiKey: () => string }} deps
 */
export function createFeaturePipeline(deps = {}) {
  const deepseekClient = createDeepSeekClient({
    getApiKey: deps.getApiKey || (() => toText(process.env.DEEPSEEK_API_KEY || "")),
  });
  const intentDetector = createIntentDetector({ deepseekClient });
  const codeGenerator = createCodeGenerator({ deepseekClient });
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
   * Health check for the pipeline (tests DeepSeek connectivity).
   */
  async function healthCheck() {
    return deepseekClient.ping();
  }

  return {
    run,
    generateAndValidate,
    healthCheck,
    // Expose sub-components for direct access
    intentDetector,
    codeGenerator,
    codeValidator,
    deepseekClient,
  };
}
