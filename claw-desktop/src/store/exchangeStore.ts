import { create } from "zustand";
import {
  getAllExchangeAuthStates,
  fetchExchangeBalance,
  type ExchangeAuthState,
  type ExchangeBalance,
} from "../lib/exchange";

export const EXCHANGE_IDS = ["binance", "okx", "bitget"] as const;
export type ExchangeId = (typeof EXCHANGE_IDS)[number];

export interface ExchangeMeta {
  name: string;
  needsPassphrase: boolean;
  passphraseLabel: string;
  keyPlaceholder: string;
  secretPlaceholder: string;
  hint: string;
}

export const EXCHANGE_META: Record<string, ExchangeMeta> = {
  binance: {
    name: "Binance",
    needsPassphrase: false,
    passphraseLabel: "",
    keyPlaceholder: "API Key",
    secretPlaceholder: "Secret Key",
    hint: "binance.com/zh-CN/my/settings/api-management",
  },
  okx: {
    name: "OKX",
    needsPassphrase: true,
    passphraseLabel: "Passphrase",
    keyPlaceholder: "API Key",
    secretPlaceholder: "Secret Key",
    hint: "okx.com/account/my-api",
  },
  bitget: {
    name: "Bitget",
    needsPassphrase: true,
    passphraseLabel: "Passphrase",
    keyPlaceholder: "API Key",
    secretPlaceholder: "Secret Key",
    hint: "bitget.com/zh-CN/account/newapi",
  },
};

interface ExchangeStore {
  auth: Record<string, ExchangeAuthState>;
  balances: Record<string, ExchangeBalance | null>;
  loadingBalance: Record<string, boolean>;

  setAuth: (exchangeId: string, state: ExchangeAuthState) => void;
  setBalance: (exchangeId: string, balance: ExchangeBalance | null) => void;
  setLoadingBalance: (exchangeId: string, v: boolean) => void;

  initFromBackend: () => Promise<void>;
  refreshBalance: (exchangeId: string) => Promise<void>;

  // Computed helper — total USD across all connected exchanges
  totalUsd: () => number;
  availableUsd: () => number;
}

export const useExchangeStore = create<ExchangeStore>((set, get) => ({
  auth: {},
  balances: {},
  loadingBalance: {},

  setAuth(exchangeId, state) {
    set((s) => ({ auth: { ...s.auth, [exchangeId]: state } }));
  },

  setBalance(exchangeId, balance) {
    set((s) => ({ balances: { ...s.balances, [exchangeId]: balance } }));
  },

  setLoadingBalance(exchangeId, v) {
    set((s) => ({ loadingBalance: { ...s.loadingBalance, [exchangeId]: v } }));
  },

  async initFromBackend() {
    try {
      const states = await getAllExchangeAuthStates();
      const auth: Record<string, ExchangeAuthState> = {};
      for (const s of states) {
        auth[s.exchange_id] = s;
      }
      set({ auth });

      for (const s of states) {
        if (s.connected) {
          get().refreshBalance(s.exchange_id);
        }
      }
    } catch {
      // backend not ready
    }
  },

  async refreshBalance(exchangeId) {
    get().setLoadingBalance(exchangeId, true);
    try {
      const balance = await fetchExchangeBalance(exchangeId);
      get().setBalance(exchangeId, balance);
    } catch {
      get().setBalance(exchangeId, null);
    } finally {
      get().setLoadingBalance(exchangeId, false);
    }
  },

  totalUsd() {
    const { auth, balances } = get();
    return EXCHANGE_IDS.reduce((sum, id) => {
      if (auth[id]?.connected && balances[id]) {
        return sum + (balances[id]?.total_usd ?? 0);
      }
      return sum;
    }, 0);
  },

  availableUsd() {
    const { auth, balances } = get();
    return EXCHANGE_IDS.reduce((sum, id) => {
      if (auth[id]?.connected && balances[id]) {
        return sum + (balances[id]?.available_usd ?? 0);
      }
      return sum;
    }, 0);
  },
}));
