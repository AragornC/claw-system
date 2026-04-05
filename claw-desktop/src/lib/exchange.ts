import { invoke } from "@tauri-apps/api/core";

export interface ExchangeAuthState {
  exchange_id: string;
  connected: boolean;
  masked_key: string | null;
  error: string | null;
}

export interface AssetBalance {
  asset: string;
  free: number;
  locked: number;
}

export interface ExchangeBalance {
  total_usd: number;
  available_usd: number;
  assets: AssetBalance[];
}

export interface ExchangeTestResult {
  success: boolean;
  message: string;
}

export async function saveExchangeKey(
  exchangeId: string,
  apiKey: string,
  apiSecret: string,
  passphrase?: string
): Promise<ExchangeAuthState> {
  return invoke("save_exchange_key", {
    exchangeId,
    apiKey,
    apiSecret,
    passphrase: passphrase ?? null,
  });
}

export async function deleteExchangeKey(
  exchangeId: string
): Promise<ExchangeAuthState> {
  return invoke("delete_exchange_key", { exchangeId });
}

export async function getAllExchangeAuthStates(): Promise<ExchangeAuthState[]> {
  return invoke("get_all_exchange_auth_states");
}

export async function testExchangeConnection(
  exchangeId: string
): Promise<ExchangeTestResult> {
  return invoke("test_exchange_connection", { exchangeId });
}

export async function fetchExchangeBalance(
  exchangeId: string
): Promise<ExchangeBalance> {
  return invoke("fetch_exchange_balance", { exchangeId });
}
