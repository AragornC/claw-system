import {
  handleAiContextRequest,
  handleChatHistoryRequest,
} from '../services/chat-service.js';

export async function handleChatRoute(url, req, res, deps) {
  const pathname = String(url?.pathname || '');
  const d = deps && typeof deps === 'object' ? deps : {};
  const useOpenclawNative = String(d.runtimeMode || '').toLowerCase() === 'openclaw-native';

  if (pathname === '/api/chat/history') {
    handleChatHistoryRequest(req, res, url, d);
    return true;
  }
  if (pathname === '/api/ai/context') {
    handleAiContextRequest(req, res, url, d);
    return true;
  }
  if (pathname === '/api/config/chat') {
    if (useOpenclawNative && typeof d.legacyHandleConfigChatApi === 'function') {
      await d.legacyHandleConfigChatApi(req, res);
    } else {
      await d.handleConfigChatApi?.(req, res);
    }
    return true;
  }
  if (pathname === '/api/ai/chat') {
    if (useOpenclawNative && typeof d.handleChatApiOpenClaw === 'function') {
      await d.handleChatApiOpenClaw(req, res);
    } else {
      await d.handleChatApi?.(req, res);
    }
    return true;
  }
  if (pathname === '/api/runtime/tasks') {
    if (typeof d.handleRuntimeTasksApi === 'function') {
      await d.handleRuntimeTasksApi(req, res);
    } else if (typeof d.runtimeHandleRoute === 'function') {
      await d.runtimeHandleRoute(url, req, res);
    }
    return true;
  }
  if (pathname === '/api/runtime/tasks/retry') {
    if (typeof d.handleRuntimeTaskRetryApi === 'function') {
      await d.handleRuntimeTaskRetryApi(req, res);
    } else if (typeof d.runtimeHandleRoute === 'function') {
      await d.runtimeHandleRoute(url, req, res);
    }
    return true;
  }
  if (pathname === '/api/runtime/schedules') {
    if (typeof d.handleRuntimeSchedulesApi === 'function') {
      await d.handleRuntimeSchedulesApi(req, res);
    } else if (typeof d.runtimeHandleRoute === 'function') {
      await d.runtimeHandleRoute(url, req, res);
    }
    return true;
  }
  if (pathname === '/api/runtime/schedules/patch') {
    if (typeof d.handleRuntimeSchedulesPatchApi === 'function') {
      await d.handleRuntimeSchedulesPatchApi(req, res);
    } else if (typeof d.runtimeHandleRoute === 'function') {
      await d.runtimeHandleRoute(url, req, res);
    }
    return true;
  }
  if (pathname === '/api/runtime/schedules/delete') {
    if (typeof d.handleRuntimeSchedulesDeleteApi === 'function') {
      await d.handleRuntimeSchedulesDeleteApi(req, res);
    } else if (typeof d.runtimeHandleRoute === 'function') {
      await d.runtimeHandleRoute(url, req, res);
    }
    return true;
  }
  if (pathname.startsWith('/api/runtime/')) {
    if (typeof d.runtimeHandleRoute === 'function') {
      const handled = await d.runtimeHandleRoute(url, req, res);
      if (handled) return true;
    }
  }
  return false;
}
