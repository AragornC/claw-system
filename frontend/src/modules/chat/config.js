export const CHAT_API = '/api/ai/chat';
export const CONFIG_CHAT_API = '/api/config/chat';
export const CHAT_HISTORY_API = '/api/chat/history';

export const CHAT_POLL_INTERVAL_MS = 1200;
export const CHAT_TYPEWRITER_TICK_MS = 14;
export const CHAT_TYPEWRITER_MAX_MS = 2600;
export const CHAT_LOG_MAX = 800;

export const SUPPORTED_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];
export const SUPPORTED_STRATEGIES = ['v5_hybrid', 'v5_retest', 'v5_reentry', 'v4_breakout'];
export const CHAT_API_ROUTES = Object.freeze({
  aiChat: '/api/ai/chat',
  configChat: '/api/config/chat',
  chatHistory: '/api/chat/history',
  aiHealth: '/api/ai/health',
});

export const CHAT_DEFAULTS = Object.freeze({
  historyPollMs: 1200,
  historyLimit: 220,
});
