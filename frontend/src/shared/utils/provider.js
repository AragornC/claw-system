const PROVIDERS = ['deepseek', 'chatgpt', 'anthropic'];

export function normalizeProviderKey(providerLike) {
  const raw = String(providerLike || '').trim().toLowerCase();
  if (raw === 'codex' || raw === 'openai' || raw === 'openai-codex') return 'chatgpt';
  if (raw === 'claude') return 'anthropic';
  if (PROVIDERS.includes(raw)) return raw;
  return 'deepseek';
}

export function providerLabel(providerLike) {
  const key = normalizeProviderKey(providerLike);
  if (key === 'chatgpt') return 'OpenAI(ChatGPT/Codex)';
  if (key === 'anthropic') return 'Anthropic';
  return 'DeepSeek';
}

export function getDefaultProviderCatalog() {
  return PROVIDERS.slice();
}
