import { invoke } from "@tauri-apps/api/core";
import type { AgentConfig } from "../types/agent";

export async function loadAgentConfig(): Promise<AgentConfig | null> {
  return invoke<AgentConfig | null>("load_agent_config");
}

export async function saveAgentConfig(config: AgentConfig): Promise<void> {
  return invoke("save_agent_config", { config });
}
