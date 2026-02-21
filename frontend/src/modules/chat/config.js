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

/** OpenClaw 风格运行时 API（会话 / 任务 / 调度）由后端能力驱动 */
export const RUNTIME_API_ROUTES = Object.freeze({
  sessions: '/api/runtime/sessions',
  tasks: '/api/runtime/tasks',
  tasksRetry: '/api/runtime/tasks/retry',
  schedules: '/api/runtime/schedules',
  schedulesPatch: '/api/runtime/schedules/patch',
  schedulesDelete: '/api/runtime/schedules/delete',
  toolsManifest: '/api/runtime/tools/manifest',
  toolsBridgeCheck: '/api/runtime/tools/bridge-check',
});

export const CHAT_DEFAULTS = Object.freeze({
  historyPollMs: 1200,
  historyLimit: 220,
});
