export const SUPPORTED_OAUTH_PROVIDERS = new Set(["openai-codex"]);

export const PROVIDER_DEFAULT_MODEL_REFS = {
  deepseek: "deepseek/deepseek-chat",
  chatgpt: "openai-codex/gpt-5.3-codex",
  anthropic: "anthropic/claude-3-5-sonnet",
  openrouter: "openrouter/openai/gpt-4o-mini",
  gemini: "google/gemini-2.5-flash",
  zai: "zai/glm-4.5",
};

export const PROVIDER_TO_SETUP_PROVIDER = {
  deepseek: "deepseek-api-key",
  chatgpt: "openai-api-key",
  anthropic: "anthropic-api-key",
  openrouter: "openrouter-api-key",
  gemini: "gemini-api-key",
  zai: "zai-api-key",
};

export const PROVIDER_TO_OAUTH_PROVIDER = {
  chatgpt: "openai-codex",
};

export function normalizeProviderKey(providerRaw) {
  const value = String(providerRaw ?? "")
    .trim()
    .toLowerCase();
  if (!value) return "deepseek";
  if (value === "openai" || value === "openai-codex" || value === "chatgpt" || value === "codex") {
    return "chatgpt";
  }
  if (value === "claude") return "anthropic";
  if (value === "google" || value.startsWith("gemini")) return "gemini";
  if (value.startsWith("deepseek")) return "deepseek";
  if (value.startsWith("anthropic")) return "anthropic";
  return value;
}

export function inferProviderFromModelRef(modelRefRaw) {
  const modelRef = String(modelRefRaw ?? "").trim();
  if (!modelRef) {
    return { provider: "deepseek", modelId: "deepseek-chat", modelRef: "deepseek/deepseek-chat" };
  }
  if (!modelRef.includes("/")) {
    const maybeProvider = normalizeProviderKey(modelRef);
    const defaultRef = PROVIDER_DEFAULT_MODEL_REFS[maybeProvider];
    if (defaultRef) {
      return inferProviderFromModelRef(defaultRef);
    }
    return {
      provider: "deepseek",
      modelId: modelRef,
      modelRef: `deepseek/${modelRef}`,
    };
  }
  const [prefix, ...rest] = modelRef.split("/");
  const provider = normalizeProviderKey(prefix);
  let modelId = rest.join("/");
  if (!modelId) {
    const fallbackRef = PROVIDER_DEFAULT_MODEL_REFS[provider] || "";
    modelId = String(fallbackRef).split("/").slice(1).join("/");
  }
  return { provider, modelId, modelRef };
}

export function toModelRef(providerRaw, modelIdRaw) {
  const provider = normalizeProviderKey(providerRaw);
  const modelId = String(modelIdRaw ?? "").trim();
  if (!modelId) {
    return PROVIDER_DEFAULT_MODEL_REFS[provider] || "";
  }
  if (modelId.includes("/")) {
    return modelId;
  }
  if (provider === "chatgpt") return `openai-codex/${modelId}`;
  if (provider === "anthropic") return `anthropic/${modelId}`;
  if (provider === "gemini") return `google/${modelId}`;
  return `${provider || "deepseek"}/${modelId}`;
}

export function providerSupportsApiKey(providerRaw) {
  const provider = normalizeProviderKey(providerRaw);
  return Boolean(PROVIDER_TO_SETUP_PROVIDER[provider]);
}

export function providerSupportsOAuth(providerRaw) {
  const provider = normalizeProviderKey(providerRaw);
  return Boolean(PROVIDER_TO_OAUTH_PROVIDER[provider]);
}

export function providerAuthType(providerRaw) {
  const provider = normalizeProviderKey(providerRaw);
  if (providerSupportsOAuth(provider) && !providerSupportsApiKey(provider)) return "oauth";
  return providerSupportsApiKey(provider) ? "apiKey" : "external";
}
