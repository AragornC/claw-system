import { invoke, Channel } from "@tauri-apps/api/core";

export interface AuthState {
  provider_id: string;
  method: "api_key" | "oauth" | "none";
  connected: boolean;
  masked_key: string | null;
  email: string | null;
  error: string | null;
}

export interface TestResult {
  success: boolean;
  message: string;
  model: string | null;
}

export interface StreamChunk {
  delta: string;
  done: boolean;
  error: string | null;
}

export async function saveApiKey(
  providerId: string,
  apiKey: string
): Promise<AuthState> {
  return invoke("save_api_key", {
    providerId,
    apiKey,
  });
}

export async function getApiKey(providerId: string): Promise<AuthState> {
  return invoke("get_api_key", { providerId });
}

export async function deleteApiKey(providerId: string): Promise<AuthState> {
  return invoke("delete_api_key", { providerId });
}

export async function getAllAuthStates(): Promise<AuthState[]> {
  return invoke("get_all_auth_states");
}

export async function testConnection(
  providerId: string
): Promise<TestResult> {
  return invoke("test_connection", { providerId });
}

export async function startOAuth(providerId: string): Promise<AuthState> {
  return invoke("start_oauth", { providerId });
}

export async function refreshOAuthStatus(
  providerId: string
): Promise<AuthState> {
  return invoke("refresh_oauth_status", { providerId });
}

export async function oauthDisconnect(
  providerId: string
): Promise<AuthState> {
  return invoke("oauth_disconnect", { providerId });
}

export async function getProviderModels(providerId: string): Promise<string[]> {
  return invoke("get_provider_models", { providerId });
}

export async function chatStream(
  providerId: string,
  model: string,
  messages: { role: string; content: string }[],
  onChunk: (chunk: StreamChunk) => void
): Promise<void> {
  const channel = new Channel<StreamChunk>();
  channel.onmessage = onChunk;

  await invoke("chat_stream", {
    providerId,
    model,
    messages,
    channel,
  });
}
