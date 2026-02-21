import path from 'node:path';
import { createAuditLog } from './audit-log.js';
import { createApprovalGate } from './approval-gate.js';
import { createMemoryManager } from './memory-manager.js';
import { createSessionManager } from './session-manager.js';
import { createTaskEngine } from './task-engine.js';
import { createToolRuntime } from './tool-runtime.js';
import { createSchedulerRuntime } from './scheduler-runtime.js';
import { createConversationRuntime } from './conversation-runtime.js';

export { createConversationRuntime };

export function createOpenClawRuntime(options = {}) {
  const workspaceDir = path.resolve(String(options.workspaceDir || process.cwd()));
  const auditLog = createAuditLog({
    filePath: path.resolve(workspaceDir, 'memory/runtime-audit.jsonl'),
  });
  const emitAudit = (event, payload) => auditLog.append(event, payload);
  const sessionManager = createSessionManager({
    storePath: path.resolve(workspaceDir, 'memory/runtime-sessions.json'),
  });
  const memoryManager = createMemoryManager({
    workspaceDir,
    buildLayeredMemoryBundle: options.buildLayeredMemoryBundle,
  });
  const toolRuntime = createToolRuntime({
    executeStrategyToolCalls: options.executeStrategyToolCalls,
    buildMcpStyleToolManifest: options.buildMcpStyleToolManifest,
    checkMcpBridgeConnectivity: options.checkMcpBridgeConnectivity,
    resolveToolAdapterMode: options.resolveToolAdapterMode,
    timeoutMs: Number(options.toolTimeoutMs || 6000),
    emitAudit,
  });
  const taskEngine = createTaskEngine({
    storePath: path.resolve(workspaceDir, 'memory/runtime-tasks.json'),
    executeTool: async (tool, args, context) =>
      toolRuntime.invokeTool(tool, args, {
        source: context?.sessionKey || 'runtime-task',
        rawMessage: `task:${context?.taskId || ''}:${tool}`,
      }),
  });
  const schedulerRuntime = createSchedulerRuntime({
    storePath: path.resolve(workspaceDir, 'memory/runtime-schedules.json'),
    taskEngine,
    emitAudit,
  });
  const approvalGate = createApprovalGate({
    defaults: {
      security: String(options.approvalSecurity || 'allowlist'),
      ask: String(options.approvalAsk || 'on-miss'),
      allowlist: Array.isArray(options.approvalAllowlist) ? options.approvalAllowlist : [],
    },
    emitAudit,
  });
  const conversation = createConversationRuntime({
    ...options,
    sessionManager,
    memoryManager,
    taskEngine,
    schedulerRuntime,
    approvalGate,
    toolRuntime,
    emitAudit,
  });
  schedulerRuntime.start();
  return {
    mode: 'openclaw-native',
    workspaceDir,
    auditLogPath: auditLog.filePath,
    sessionManager,
    memoryManager,
    taskEngine,
    schedulerRuntime,
    approvalGate,
    toolRuntime,
    conversation,
    shutdown() {
      schedulerRuntime.stop();
      conversation.dispose();
    },
  };
}
