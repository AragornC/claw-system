import { create } from "zustand";
import {
  getAllExchangeAuthStates,
  fetchExchangeBalance,
  type ExchangeAuthState,
  type AccountBalance,
} from "../lib/exchange";

import binanceLogo from "../assets/exchanges/binance.png";
import okxLogo from "../assets/exchanges/okx.png";
import bitgetLogo from "../assets/exchanges/bitget.png";

export const EXCHANGE_IDS = ["binance", "okx", "bitget"] as const;
export type ExchangeId = (typeof EXCHANGE_IDS)[number];

export interface ExchangeMeta {
  name: string;
  logo: string;
  needsPassphrase: boolean;
  keyPlaceholder: string;
  secretPlaceholder: string;
  apiLink: string;
}

export const EXCHANGE_META: Record<string, ExchangeMeta> = {
  binance: {
    name: "Binance",
    logo: binanceLogo,
    needsPassphrase: false,
    keyPlaceholder: "粘贴你的 API Key",
    secretPlaceholder: "粘贴你的 Secret Key",
    apiLink: "https://www.binance.com/zh-CN/my/settings/api-management",
  },
  okx: {
    name: "OKX",
    logo: okxLogo,
    needsPassphrase: true,
    keyPlaceholder: "粘贴你的 API Key",
    secretPlaceholder: "粘贴你的 Secret Key",
    apiLink: "https://www.okx.com/account/my-api",
  },
  bitget: {
    name: "Bitget",
    logo: bitgetLogo,
    needsPassphrase: true,
    keyPlaceholder: "粘贴你的 API Key",
    secretPlaceholder: "粘贴你的 Secret Key",
    apiLink: "https://www.bitget.com/zh-CN/account/newapi",
  },
};

interface ExchangeStoreState {
  auth: Record<string, ExchangeAuthState>;
  balances: Record<string, AccountBalance | null>;
  loadingBalance: Record<string, boolean>;

  activeId: string | null;

  setAuth: (exchangeId: string, state: ExchangeAuthState) => void;
  setAllAuth: (states: ExchangeAuthState[]) => void;
  setBalance: (exchangeId: string, balance: AccountBalance | null) => void;
  setLoadingBalance: (exchangeId: string, v: boolean) => void;

  initFromBackend: () => Promise<void>;
  refreshBalance: (exchangeId: string) => Promise<void>;
}

function deriveActiveId(auth: Record<string, ExchangeAuthState>): string | null {
  for (const id of EXCHANGE_IDS) {
    if (auth[id]?.connected) return id;
  }
  return null;
}

export const useExchangeStore = create<ExchangeStoreState>((set, get) => ({
  auth: {},
  balances: {},
  loadingBalance: {},
  activeId: null,

  setAuth(exchangeId, state) {
    set((s) => {
      const auth = { ...s.auth, [exchangeId]: state };
      return { auth, activeId: deriveActiveId(auth) };
    });
  },

  setAllAuth(states) {
    const auth: Record<string, ExchangeAuthState> = {};
    for (const s of states) auth[s.exchange_id] = s;
    set({ auth, activeId: deriveActiveId(auth) });
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
      get().setAllAuth(states);
      const active = deriveActiveId(
        Object.fromEntries(states.map((s) => [s.exchange_id, s]))
      );
      if (active) get().refreshBalance(active);
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
}));
