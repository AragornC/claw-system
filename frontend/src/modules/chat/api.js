/**
 * Chat API 封装：由后端能力驱动，无硬编码分支
 * 供 perp-report-viewer 或其它前端消费
 */

import {
  CHAT_API_ROUTES,
  RUNTIME_API_ROUTES,
  CHAT_DEFAULTS,
} from './config.js';

/**
 * 发送聊天消息
 * @param {string} message
 * @param {object} [clientContext] - { sessionKey, source, currentView }
 * @returns {Promise<{ ok: boolean, reply?: string, executionTrace?: array, source?: string, error?: string }>}
 */
export async function sendChatMessage(message, clientContext = {}) {
  const base = typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : '';
  const url = base + CHAT_API_ROUTES.aiChat;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: String(message || '').trim(),
      clientContext: clientContext && typeof clientContext === 'object' ? clientContext : {},
    }),
  });
  const payload = await resp.json().catch(() => ({}));
  return {
    ok: resp.ok && payload?.ok !== false,
    reply: payload?.reply,
    source: payload?.source,
    executionTrace: Array.isArray(payload?.executionTrace) ? payload.executionTrace : [],
    actions: Array.isArray(payload?.actions) ? payload.actions : [],
    meta: payload?.meta,
    error: payload?.error,
  };
}

/**
 * 获取聊天历史
 * @param {number} [afterId]
 * @param {number} [limit]
 * @returns {Promise<{ ok: boolean, items?: array, error?: string }>}
 */
export async function fetchChatHistory(afterId = 0, limit = CHAT_DEFAULTS.historyLimit) {
  const base = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
  const qs = new URLSearchParams({
    afterId: String(afterId),
    limit: String(limit),
  });
  const url = base + CHAT_API_ROUTES.chatHistory + '?' + qs.toString();
  const resp = await fetch(url, { cache: 'no-store' });
  const payload = await resp.json().catch(() => ({}));
  return {
    ok: resp.ok,
    items: Array.isArray(payload?.items) ? payload.items : [],
    error: payload?.error,
  };
}

/**
 * 获取运行时会话列表
 * @returns {Promise<{ ok: boolean, sessions?: array }>}
 */
export async function fetchRuntimeSessions() {
  const base = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
  const resp = await fetch(base + RUNTIME_API_ROUTES.sessions, { cache: 'no-store' });
  const payload = await resp.json().catch(() => ({}));
  return {
    ok: resp.ok && payload?.ok !== false,
    sessions: Array.isArray(payload?.sessions) ? payload.sessions : [],
  };
}

/**
 * 获取运行时任务列表
 * @returns {Promise<{ ok: boolean, tasks?: array }>}
 */
export async function fetchRuntimeTasks() {
  const base = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
  const resp = await fetch(base + RUNTIME_API_ROUTES.tasks, { cache: 'no-store' });
  const payload = await resp.json().catch(() => ({}));
  return {
    ok: resp.ok && payload?.ok !== false,
    tasks: Array.isArray(payload?.tasks) ? payload.tasks : [],
  };
}

/**
 * 获取运行时调度列表
 * @returns {Promise<{ ok: boolean, jobs?: array }>}
 */
export async function fetchRuntimeSchedules() {
  const base = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
  const resp = await fetch(base + RUNTIME_API_ROUTES.schedules, { cache: 'no-store' });
  const payload = await resp.json().catch(() => ({}));
  return {
    ok: resp.ok && payload?.ok !== false,
    jobs: Array.isArray(payload?.jobs) ? payload.jobs : [],
  };
}
