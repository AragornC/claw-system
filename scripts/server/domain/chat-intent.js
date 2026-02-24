export function createChatIntentUtils(deps = {}) {
  const {
    normalizeProviderKey,
    uniqStrings,
    inferProviderFromModelRef,
    PROVIDER_DEFAULT_MODEL_REFS,
    getModelRegistry,
  } = deps;

  if (typeof normalizeProviderKey !== "function") throw new Error("normalizeProviderKey is required");
  if (typeof uniqStrings !== "function") throw new Error("uniqStrings is required");
  if (typeof inferProviderFromModelRef !== "function") throw new Error("inferProviderFromModelRef is required");
  if (!PROVIDER_DEFAULT_MODEL_REFS || typeof PROVIDER_DEFAULT_MODEL_REFS !== "object") {
    throw new Error("PROVIDER_DEFAULT_MODEL_REFS is required");
  }
  if (typeof getModelRegistry !== "function") throw new Error("getModelRegistry is required");

  function pickRegisteredModelRefByProvider(providerLike) {
    const provider = normalizeProviderKey(providerLike || "");
    const registry = uniqStrings(getModelRegistry());
    const picked = registry.find((ref) => inferProviderFromModelRef(ref).provider === provider);
    return String(picked || PROVIDER_DEFAULT_MODEL_REFS[provider] || "").trim();
  }

  function parseSlashCommandMessage(messageRaw) {
    const message = String(messageRaw || "").trim();
    if (!message.startsWith("/")) return { command: "", args: "", message };
    const spaceIdx = message.indexOf(" ");
    if (spaceIdx < 0) {
      return { command: message.toLowerCase(), args: "", message };
    }
    return {
      command: message.slice(0, spaceIdx).toLowerCase(),
      args: message.slice(spaceIdx + 1).trim(),
      message,
    };
  }

  function findTokenStartingWith(partsLike, prefixLike) {
    const parts = Array.isArray(partsLike) ? partsLike : [];
    const prefix = String(prefixLike || "").toLowerCase();
    for (const partRaw of parts) {
      const part = String(partRaw || "").trim();
      if (!part) continue;
      if (part.toLowerCase().startsWith(prefix)) return part;
    }
    return "";
  }

  function isDigitsOnly(valueRaw) {
    const value = String(valueRaw || "").trim();
    if (!value) return false;
    for (const ch of value) {
      if (ch < "0" || ch > "9") return false;
    }
    return true;
  }

  function resolveModelRefFromToken(tokenRaw) {
    const token = String(tokenRaw || "").trim();
    if (!token) return "";
    const normalized = token.toLowerCase();
    if (token.includes("/")) return token;

    if (normalized === "deepseek") return pickRegisteredModelRefByProvider("deepseek");
    if (normalized === "chatgpt" || normalized === "openai" || normalized === "codex" || normalized === "gpt") {
      return pickRegisteredModelRefByProvider("chatgpt");
    }
    if (normalized === "anthropic" || normalized === "claude") return pickRegisteredModelRefByProvider("anthropic");
    if (normalized === "openrouter") return pickRegisteredModelRefByProvider("openrouter");
    if (normalized === "gemini" || normalized === "google") return pickRegisteredModelRefByProvider("gemini");
    if (normalized === "zai" || normalized === "glm") return pickRegisteredModelRefByProvider("zai");

    const registry = uniqStrings(getModelRegistry());
    for (const refRaw of registry) {
      const ref = String(refRaw || "").trim();
      if (!ref) continue;
      const lower = ref.toLowerCase();
      const modelPart = lower.includes("/") ? lower.split("/").slice(1).join("/") : lower;
      if (normalized === lower || normalized === modelPart) return ref;
    }
    return "";
  }

  function parseSlashModelSwitchRef(messageRaw) {
    const { command, args } = parseSlashCommandMessage(messageRaw);
    if (command !== "/model" && command !== "/models") return "";
    const firstArg = String(args || "").split(/\s+/, 1)[0] || "";
    const target = String(firstArg || "").trim();
    if (!target) return "";
    const lower = target.toLowerCase();
    if (lower === "list" || lower === "status" || isDigitsOnly(target)) return "";
    return resolveModelRefFromToken(target);
  }

  function parseConfigIntent(messageRaw) {
    const message = String(messageRaw || "").trim();
    if (!message) return null;
    const { command, args } = parseSlashCommandMessage(message);
    if (!command) return null;

    if (command === "/model" || command === "/models") {
      const modelRef = parseSlashModelSwitchRef(message);
      if (!modelRef) return null;
      return { type: "switch_model", modelRef, from: "slash_command" };
    }

    if (command === "/deepseek") {
      const token = findTokenStartingWith(String(args || "").split(/\s+/), "sk-");
      if (!token) return { type: "deepseek_help" };
      return { type: "deepseek_key", key: token };
    }

    if (command === "/telegram") {
      const token = String(args || "").trim();
      if (!token) return { type: "telegram_help" };
      return { type: "telegram_token", token };
    }

    if (command === "/oauth" || command === "/openai" || command === "/chatgpt" || command === "/codex-login") {
      const providerText = String(args || "").trim().toLowerCase();
      if (providerText.includes("anthropic") || providerText.includes("claude")) {
        return { type: "oauth", provider: "anthropic" };
      }
      return { type: "oauth", provider: "chatgpt" };
    }

    if (command === "/anthropic" || command === "/claude-login") {
      return { type: "oauth", provider: "anthropic" };
    }

    if (command === "/xbrain" || command === "/xbrain-open" || command === "/onboard") {
      return { type: "open_xbrain" };
    }
    return null;
  }

  return {
    pickRegisteredModelRefByProvider,
    parseSlashCommandMessage,
    findTokenStartingWith,
    isDigitsOnly,
    resolveModelRefFromToken,
    parseSlashModelSwitchRef,
    parseConfigIntent,
  };
}
