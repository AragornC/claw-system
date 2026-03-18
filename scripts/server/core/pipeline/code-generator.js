/**
 * Pipeline Stage 2: Code Generation
 *
 * Given a structured feature specification, generates a standalone Python
 * module that exposes compute_feature(df, ...) -> pd.Series.
 */

import { sleepMs, toText } from "../../lib/utils.js";
import {
  CODE_GENERATION_SYSTEM_PROMPT,
  CODE_GENERATION_STREAM_SYSTEM_PROMPT,
  buildCodeGenerationUserMessage,
  CODE_REPAIR_SYSTEM_PROMPT,
  buildCodeRepairUserMessage,
} from "./prompts/code-generation.js";
import {
  detectTemplateRoute,
  generateTemplateCode,
} from "./feature-workbench.js";

/**
 * Normalize code generation output from model.
 */
function normalizeCodeOutput(rawLike, featureName) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  const name = toText(raw.featureName || featureName).toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const result = {
    featureName: name,
    featureCode: toText(raw.featureCode, ""),
    description: toText(raw.description, ""),
    route: toText(raw.route, ""),
    templateId: toText(raw.templateId, ""),
  };
  if (raw.repairSummary && typeof raw.repairSummary === "object") {
    result.repairSummary = {
      failureType: toText(raw.repairSummary.failureType, ""),
      repairGoal: toText(raw.repairSummary.repairGoal, ""),
      changes: Array.isArray(raw.repairSummary.changes)
        ? raw.repairSummary.changes.map((item) => toText(item, "")).filter(Boolean).slice(0, 8)
        : [],
      preservedConstraints: Array.isArray(raw.repairSummary.preservedConstraints)
        ? raw.repairSummary.preservedConstraints.map((item) => toText(item, "")).filter(Boolean).slice(0, 10)
        : [],
    };
  }
  if (raw.specOverride !== undefined) {
    result.specOverride = Boolean(raw.specOverride);
  }
  // Optional: requiredConfig for features that need user-provided configuration (API keys, URLs, etc.)
  if (Array.isArray(raw.requiredConfig) && raw.requiredConfig.length) {
    result.requiredConfig = raw.requiredConfig
      .filter((c) => c && typeof c === "object" && toText(c.key, ""))
      .map((c) => ({
        key: toText(c.key, ""),
        label: toText(c.label, c.key || ""),
        description: toText(c.description, ""),
      }));
  }
  return result;
}

function stripMarkdownCodeFence(textLike) {
  const text = toText(textLike, "");
  if (!text) return "";
  const fenced = text.match(/```(?:python)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return String(fenced[1]).trim();
  return text.trim();
}

/**
 * Create the code generator with an LLM client dependency.
 * @param {{ llmClient: Object }} deps
 */
export function createCodeGenerator(deps = {}) {
  const llmClient = deps.llmClient;

  /**
   * Generate standalone Python feature code for a feature.
   * @param {Object} feature - Feature specification from intent detection
   * @returns {Promise<Object>} Generated code object
   */
  async function generateCode(feature) {
    const featureName = toText(feature?.name, "custom_feature");
    const specArtifact = feature?.specArtifact && typeof feature.specArtifact === "object"
      ? feature.specArtifact
      : null;
    const route = detectTemplateRoute(feature, specArtifact);
    const templateResult = generateTemplateCode(feature, specArtifact);
    if (templateResult) {
      return {
        ok: true,
        code: normalizeCodeOutput(templateResult, featureName),
        source: "template",
      };
    }

    if (llmClient) {
      try {
        const result = await llmClient.chatCompletionJson({
          messages: [
            { role: "system", content: CODE_GENERATION_SYSTEM_PROMPT },
            { role: "user", content: buildCodeGenerationUserMessage({ feature, specArtifact, route }) },
          ],
          temperature: 0.2,
          maxTokens: 3072,
          timeoutMs: 90_000,
        });
        if (result.ok && result.data) {
          const code = normalizeCodeOutput(result.data, featureName);
          if (code.featureCode) {
            return { ok: true, code, source: "llm" };
          }
        }
        return { ok: false, error: "Code generation did not return featureCode", code: null };
      } catch (err) {
        return { ok: false, error: String(err?.message || err), code: null };
      }
    }
    return { ok: false, error: "No LLM client available for code generation", code: null };
  }

  async function generateCodeStream(feature, options = {}) {
    const onChunk = typeof options.onChunk === "function" ? options.onChunk : null;
    const featureName = toText(feature?.name, "custom_feature");
    const specArtifact = feature?.specArtifact && typeof feature.specArtifact === "object"
      ? feature.specArtifact
      : null;
    const route = detectTemplateRoute(feature, specArtifact);
    const templateResult = generateTemplateCode(feature, specArtifact);
    if (templateResult) {
      const code = normalizeCodeOutput(templateResult, featureName);
      if (onChunk) {
        const lines = String(code.featureCode || "").split("\n");
        let buffer = "";
        for (let i = 0; i < lines.length; i += 2) {
          const chunk = lines.slice(i, i + 2).join("\n");
          buffer += (buffer ? "\n" : "") + chunk;
          await Promise.resolve(onChunk({
            codeSnippet: buffer,
            delta: chunk,
            source: "template",
            done: i + 2 >= lines.length,
          }));
          if (i + 2 < lines.length) await sleepMs(35);
        }
      }
      return { ok: true, code, source: "template" };
    }

    if (!llmClient || typeof llmClient.chatCompletionStream !== "function") {
      return generateCode(feature);
    }

    let rawText = "";
    let lastEmission = "";
    try {
      for await (const event of llmClient.chatCompletionStream({
        messages: [
          { role: "system", content: CODE_GENERATION_STREAM_SYSTEM_PROMPT },
          { role: "user", content: buildCodeGenerationUserMessage({ feature, specArtifact, route }) },
        ],
        temperature: 0.2,
        maxTokens: 3072,
        timeoutMs: 90_000,
      })) {
        if (event?.type === "error") {
          return { ok: false, error: toText(event.error, "stream generation failed"), code: null };
        }
        if (event?.type !== "token") continue;
        rawText += toText(event.text, "");
        const codeSnippet = stripMarkdownCodeFence(rawText);
        if (onChunk && codeSnippet && codeSnippet !== lastEmission) {
          lastEmission = codeSnippet;
          await Promise.resolve(onChunk({
            codeSnippet,
            delta: toText(event.text, ""),
            source: "llm_stream",
            done: false,
          }));
        }
      }
      const featureCode = stripMarkdownCodeFence(rawText);
      if (!featureCode) {
        return { ok: false, error: "Stream generation did not return code", code: null };
      }
      return {
        ok: true,
        code: normalizeCodeOutput({
          featureName,
          featureCode,
          description: toText(feature?.description, ""),
          route: route.route,
          templateId: route.templateId,
        }, featureName),
        source: "llm_stream",
      };
    } catch (err) {
      return { ok: false, error: String(err?.message || err), code: null };
    }
  }

  /**
   * Attempt to repair code that failed validation.
   * @param {Object} params
   * @param {Object} params.originalCode - The failed code
   * @param {string[]} params.errors - Validation error messages
   * @param {Object} params.featureSpec - Original feature spec
   * @returns {Promise<Object>} Repaired code
   */
  async function repairCode(params = {}) {
    if (!llmClient) {
      return { ok: false, code: params.originalCode || {}, error: "No LLM client for repair" };
    }
    try {
      const messages = Array.isArray(params.messages) && params.messages.length
        ? params.messages
        : [
            { role: "system", content: CODE_REPAIR_SYSTEM_PROMPT },
            { role: "user", content: buildCodeRepairUserMessage(params) },
          ];
      const result = await llmClient.chatCompletionJson({
        messages,
        temperature: 0.1,
        maxTokens: 3072,
        timeoutMs: 90_000,
      });
      if (result.ok && result.data) {
        const code = normalizeCodeOutput(result.data, params.featureSpec?.name || "custom");
        if (code.featureCode) {
          return { ok: true, code, source: "llm_repair" };
        }
      }
      return { ok: false, code: params.originalCode || {}, error: "Repair failed to produce code" };
    } catch (err) {
      return { ok: false, code: params.originalCode || {}, error: String(err?.message || err) };
    }
  }

  return { generateCode, generateCodeStream, repairCode };
}
