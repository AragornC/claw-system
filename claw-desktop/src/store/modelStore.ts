import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  getAllAuthStates,
  getProviderModels,
  refreshOAuthStatus,
  type AuthState,
} from "../lib/llm";

/* ── Types ── */
export interface ModelMeta {
  id: string;
  badge: string;
  badgeClass: string;
  ctx: string;
}

export interface AuthInfo {
  connected: boolean;
  method: "oauth" | "api_key" | "none";
  email: string;
  maskedKey: string;
}

export interface SelectedModel {
  providerId: string;
  modelId: string;
}

export interface ProviderMeta {
  name: string;
  supportsOAuth: boolean;
  oauthLabel: string;
  placeholder: string;
  hint: string;
  logo: string;
  logoBg: string;
  logoFilter: string;
}

/* ── Static provider metadata ── */
export const PROVIDER_IDS = [
  "anthropic",
  "openai",
  "deepseek",
  "google",
  "xai",
] as const;

export const PROVIDER_META: Record<string, ProviderMeta> = {
  anthropic: {
    name: "Anthropic",
    supportsOAuth: false,
    oauthLabel: "",
    placeholder: "sk-ant-api03-…",
    hint: "console.anthropic.com",
    logo: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/anthropic.svg",
    logoBg: "#cc785c",
    logoFilter: "brightness(10)",
  },
  openai: {
    name: "OpenAI",
    supportsOAuth: true,
    oauthLabel: "Sign in with ChatGPT",
    placeholder: "sk-proj-…",
    hint: "platform.openai.com",
    logo: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/openai.svg",
    logoBg: "#fff",
    logoFilter: "",
  },
  deepseek: {
    name: "DeepSeek",
    supportsOAuth: false,
    oauthLabel: "",
    placeholder: "sk-…",
    hint: "platform.deepseek.com",
    logo: "https://upload.wikimedia.org/wikipedia/commons/e/ec/DeepSeek_logo.svg",
    logoBg: "#fff",
    logoFilter: "",
  },
  google: {
    name: "Google Gemini",
    supportsOAuth: false,
    oauthLabel: "",
    placeholder: "AIza…",
    hint: "aistudio.google.com",
    logo: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/gemini.svg",
    logoBg: "#fff",
    logoFilter: "",
  },
  xai: {
    name: "xAI Grok",
    supportsOAuth: false,
    oauthLabel: "",
    placeholder: "xai-…",
    hint: "console.x.ai",
    logo: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/grok.svg",
    logoBg: "#fff",
    logoFilter: "",
  },
};

/* ── Default models per provider ── */
const DEFAULT_MODELS: Record<string, ModelMeta[]> = {
  anthropic: [
    { id: "claude-sonnet-4-6", badge: "推荐", badgeClass: "badge-green", ctx: "1M" },
    { id: "claude-opus-4-6", badge: "旗舰", badgeClass: "badge-gold", ctx: "1M" },
    { id: "claude-haiku-4-5", badge: "快速", badgeClass: "badge-blue", ctx: "200K" },
  ],
  openai: [
    { id: "gpt-5.4", badge: "推荐", badgeClass: "badge-green", ctx: "1M" },
    { id: "gpt-5.4-mini", badge: "快速", badgeClass: "badge-blue", ctx: "400K" },
    { id: "gpt-5.4-nano", badge: "极速", badgeClass: "badge-blue", ctx: "400K" },
  ],
  deepseek: [
    { id: "deepseek-chat", badge: "低成本", badgeClass: "badge-blue", ctx: "128K" },
    { id: "deepseek-reasoner", badge: "推理", badgeClass: "badge-gold", ctx: "128K" },
  ],
  google: [
    { id: "gemini-2.5-pro", badge: "推荐", badgeClass: "badge-green", ctx: "1M" },
    { id: "gemini-2.5-flash", badge: "快速", badgeClass: "badge-blue", ctx: "1M" },
  ],
  xai: [
    { id: "grok-3", badge: "推荐", badgeClass: "badge-green", ctx: "128K" },
    { id: "grok-3-mini", badge: "快速", badgeClass: "badge-blue", ctx: "128K" },
  ],
};

const DEFAULT_ENABLED: Record<string, string[]> = {
  anthropic: ["claude-sonnet-4-6"],
  openai: ["gpt-5.4", "gpt-5.4-mini"],
  deepseek: ["deepseek-chat"],
  google: ["gemini-2.5-pro"],
  xai: ["grok-3"],
};

/* ── OpenAI model badge helper ── */
const OPENAI_MODEL_CTX: Record<string, string> = {
  "gpt-5.4":            "1M",
  "gpt-5.4-mini":       "400K",
  "gpt-5.4-nano":       "400K",
  "gpt-5.3-codex":      "1M",
  "gpt-5.2-codex":      "256K",
  "gpt-5.2":            "400K",
  "gpt-5.1-codex-max":  "400K",
  "gpt-5.1-codex":      "200K",
  "gpt-5.1":            "200K",
  "gpt-5":              "400K",
};

export function openAiModelMeta(
  name: string
): Pick<ModelMeta, "badge" | "badgeClass" | "ctx"> {
  const ctx = OPENAI_MODEL_CTX[name] ?? "—";

  if (name === "gpt-5.4") return { badge: "推荐", badgeClass: "badge-green", ctx };
  if (name === "gpt-5.4-mini") return { badge: "快速", badgeClass: "badge-blue", ctx };
  if (name === "gpt-5.4-nano") return { badge: "极速", badgeClass: "badge-blue", ctx };
  if (name.includes("codex-max")) return { badge: "Codex Max", badgeClass: "badge-gold", ctx };
  if (name.includes("codex")) return { badge: "Codex", badgeClass: "badge-gold", ctx };
  if (name.includes("mini")) return { badge: "快速", badgeClass: "badge-blue", ctx };
  if (name.includes("nano")) return { badge: "极速", badgeClass: "badge-blue", ctx };
  return { badge: "", badgeClass: "", ctx };
}

/* ── Store interface ── */
interface ModelStore {
  auth: Record<string, AuthInfo>;
  enabledModels: Record<string, string[]>;
  allModels: Record<string, ModelMeta[]>;
  selectedModel: SelectedModel;
  selectedProvider: string;

  // Actions
  setAuth: (providerId: string, info: AuthInfo) => void;
  toggleModel: (providerId: string, modelId: string) => void;
  selectModel: (providerId: string, modelId: string) => void;
  setSelectedProvider: (providerId: string) => void;
  setAllModels: (providerId: string, models: ModelMeta[]) => void;
  disconnect: (providerId: string) => void;
  applyAuthState: (state: AuthState) => void;
  initFromBackend: () => Promise<void>;
}

function makeDefaultAuth(): Record<string, AuthInfo> {
  const auth: Record<string, AuthInfo> = {};
  for (const pid of PROVIDER_IDS) {
    auth[pid] = { connected: false, method: "none", email: "", maskedKey: "" };
  }
  return auth;
}

function findFallbackModel(
  auth: Record<string, AuthInfo>,
  enabledModels: Record<string, string[]>,
  excludeProvider?: string
): SelectedModel | null {
  for (const pid of PROVIDER_IDS) {
    if (pid === excludeProvider) continue;
    if (auth[pid]?.connected && enabledModels[pid]?.length > 0) {
      return { providerId: pid, modelId: enabledModels[pid][0] };
    }
  }
  return null;
}

export const useModelStore = create<ModelStore>()(
  persist(
    (set, get) => ({
      auth: makeDefaultAuth(),
      enabledModels: { ...DEFAULT_ENABLED },
      allModels: { ...DEFAULT_MODELS },
      selectedModel: { providerId: "openai", modelId: "gpt-5.4" },
      selectedProvider: "openai",

      setAuth(providerId, info) {
        set((s) => ({
          auth: { ...s.auth, [providerId]: info },
        }));
      },

      toggleModel(providerId, modelId) {
        const { enabledModels, selectedModel } = get();
        const enabled = enabledModels[providerId] || [];
        const idx = enabled.indexOf(modelId);

        if (idx >= 0) {
          if (enabled.length <= 1) return;
          const next = enabled.filter((m) => m !== modelId);
          const updates: Partial<ModelStore> = {
            enabledModels: { ...enabledModels, [providerId]: next },
          };
          if (
            selectedModel.providerId === providerId &&
            selectedModel.modelId === modelId
          ) {
            updates.selectedModel = { providerId, modelId: next[0] };
          }
          set(updates);
        } else {
          set({
            enabledModels: {
              ...enabledModels,
              [providerId]: [...enabled, modelId],
            },
          });
        }
      },

      selectModel(providerId, modelId) {
        set({ selectedModel: { providerId, modelId } });
      },

      setSelectedProvider(providerId) {
        set({ selectedProvider: providerId });
      },

      setAllModels(providerId, models) {
        set((s) => ({
          allModels: { ...s.allModels, [providerId]: models },
        }));
      },

      disconnect(providerId) {
        const { auth, enabledModels, selectedModel } = get();
        const nextAuth: Record<string, AuthInfo> = {
          ...auth,
          [providerId]: {
            connected: false,
            method: "none",
            email: "",
            maskedKey: "",
          },
        };
        const updates: Partial<ModelStore> = { auth: nextAuth };

        if (selectedModel.providerId === providerId) {
          const fb = findFallbackModel(nextAuth, enabledModels, providerId);
          if (fb) updates.selectedModel = fb;
        }
        set(updates);
      },

      applyAuthState(state) {
        const info: AuthInfo = {
          connected: state.connected,
          method: state.method,
          email: state.email ?? "",
          maskedKey: state.masked_key ?? "",
        };
        get().setAuth(state.provider_id, info);
      },

      async initFromBackend() {
        try {
          const states = await getAllAuthStates();
          const auth = { ...get().auth };
          for (const s of states) {
            auth[s.provider_id] = {
              connected: s.connected,
              method: s.method,
              email: s.email ?? "",
              maskedKey: s.masked_key ?? "",
            };
          }

          // Always refresh OpenAI OAuth status to get fresh email and token
          try {
            const oauthState = await refreshOAuthStatus("openai");
            auth.openai = {
              connected: oauthState.connected,
              method: oauthState.method,
              email: oauthState.email ?? "",
              maskedKey: oauthState.masked_key ?? "",
            };
          } catch {
            // keep whatever getAllAuthStates returned
          }

          set({ auth });

          // Fetch dynamic models for connected OpenAI
          if (auth.openai?.connected) {
            try {
              const names = await getProviderModels("openai");
              if (names.length > 0) {
                const models = names.map((name) => ({
                  id: name,
                  ...openAiModelMeta(name),
                }));
                get().setAllModels("openai", models);
              }
            } catch {
              // keep defaults
            }
          }

          // Validate selectedModel still points to a connected provider
          const { selectedModel, enabledModels } = get();
          if (!auth[selectedModel.providerId]?.connected) {
            const fb = findFallbackModel(auth, enabledModels);
            if (fb) set({ selectedModel: fb });
          }
        } catch {
          // backend not ready yet
        }
      },
    }),
    {
      name: "claw-model-store",
      partialize: (state) => ({
        enabledModels: state.enabledModels,
        selectedModel: state.selectedModel,
      }),
    }
  )
);
