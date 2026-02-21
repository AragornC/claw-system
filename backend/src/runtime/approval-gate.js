function normalizeSecurity(rawLike) {
  const raw = String(rawLike || '').trim().toLowerCase();
  if (raw === 'full' || raw === 'allowlist' || raw === 'deny') return raw;
  return 'deny';
}

function normalizeAsk(rawLike) {
  const raw = String(rawLike || '').trim().toLowerCase();
  if (raw === 'always' || raw === 'on-miss' || raw === 'off') return raw;
  return 'on-miss';
}

function toWords(inputLike) {
  return String(inputLike || '')
    .toLowerCase()
    .split(/[^a-z0-9_:/.-]+/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function createApprovalGate(options = {}) {
  const defaults = options.defaults && typeof options.defaults === 'object' ? options.defaults : {};
  const baseSecurity = normalizeSecurity(defaults.security || 'allowlist');
  const baseAsk = normalizeAsk(defaults.ask || 'on-miss');
  const allowlist = new Set(
    Array.isArray(defaults.allowlist)
      ? defaults.allowlist.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean)
      : [],
  );
  const emitAudit = typeof options.emitAudit === 'function' ? options.emitAudit : () => {};

  function isAllowlisted(textLike) {
    const text = String(textLike || '').toLowerCase();
    if (!text) return false;
    for (const p of allowlist.values()) {
      if (text.includes(p)) return true;
    }
    return false;
  }

  function evaluate(inputLike = {}) {
    const input = inputLike && typeof inputLike === 'object' ? inputLike : {};
    const action = String(input.action || input.tool || '').trim();
    const summary = String(input.summary || action || '').trim();
    const requestedSecurity = normalizeSecurity(input.security || baseSecurity);
    const requestedAsk = normalizeAsk(input.ask || baseAsk);
    const words = toWords(summary);
    const highRisk =
      words.includes('bash') ||
      words.includes('shell') ||
      words.includes('exec') ||
      words.includes('write') ||
      words.includes('delete') ||
      words.includes('http') ||
      words.includes('curl');
    const allowlisted = isAllowlisted(summary);
    let allowed = false;
    let needApproval = false;
    let reason = 'denied_by_default';

    if (requestedSecurity === 'full') {
      allowed = true;
      reason = 'full_mode';
    } else if (requestedSecurity === 'allowlist') {
      allowed = allowlisted || !highRisk;
      reason = allowlisted ? 'allowlisted' : allowed ? 'low_risk' : 'allowlist_miss';
    } else {
      allowed = false;
      reason = 'deny_mode';
    }

    if (requestedAsk === 'always') {
      needApproval = true;
      if (allowed) {
        allowed = false;
        reason = 'approval_required_always';
      }
    } else if (requestedAsk === 'on-miss' && !allowlisted && highRisk) {
      needApproval = true;
      if (allowed) {
        allowed = false;
        reason = 'approval_required_on_miss';
      }
    }

    const result = {
      allowed,
      needApproval,
      reason,
      security: requestedSecurity,
      ask: requestedAsk,
      highRisk,
      allowlisted,
    };
    emitAudit('approval.evaluate', { action, summary, ...result });
    return result;
  }

  function grantAlways(patternLike) {
    const pattern = String(patternLike || '').trim().toLowerCase();
    if (!pattern) return false;
    allowlist.add(pattern);
    emitAudit('approval.allowlist.add', { pattern });
    return true;
  }

  return {
    evaluate,
    grantAlways,
    getSnapshot() {
      return {
        security: baseSecurity,
        ask: baseAsk,
        allowlist: Array.from(allowlist.values()),
      };
    },
  };
}
import crypto from 'node:crypto';

function defaultIsSensitive(actionLike = {}) {
  const action = actionLike && typeof actionLike === 'object' ? actionLike : {};
  const type = String(action.type || '').toLowerCase();
  if (type === 'shell' || type === 'file_write' || type === 'external_request') return true;
  const tool = String(action.tool || '').toLowerCase();
  if (/bash|shell|exec|write|delete|curl|fetch|http/.test(tool)) return true;
  return false;
}

function parseAllowlist(rawLike = '') {
  return String(rawLike || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

export function createApprovalGate(options = {}) {
  const policy = String(options.policy || process.env.THUNDERCLAW_APPROVAL_POLICY || 'allowlist').trim().toLowerCase();
  const askMode = String(options.askMode || process.env.THUNDERCLAW_APPROVAL_ASK || 'on-miss').trim().toLowerCase();
  const allowlist = Array.isArray(options.allowlist)
    ? options.allowlist
    : parseAllowlist(process.env.THUNDERCLAW_APPROVAL_ALLOWLIST || '');
  const pending = new Map();
  const isSensitive = typeof options.isSensitive === 'function' ? options.isSensitive : defaultIsSensitive;

  function matchAllowlist(action = {}) {
    const target = `${String(action.type || '')} ${String(action.tool || '')} ${String(action.command || '')}`.toLowerCase();
    if (!allowlist.length) return false;
    return allowlist.some((x) => target.includes(String(x).toLowerCase()));
  }

  function evaluate(actionLike = {}, contextLike = {}) {
    const action = actionLike && typeof actionLike === 'object' ? actionLike : {};
    const context = contextLike && typeof contextLike === 'object' ? contextLike : {};
    if (!isSensitive(action, context)) {
      return { allowed: true, requiresApproval: false, reason: 'non_sensitive' };
    }
    if (policy === 'full') {
      if (askMode === 'always') return request(action, context, 'ask_always');
      return { allowed: true, requiresApproval: false, reason: 'policy_full' };
    }
    if (policy === 'deny') {
      return { allowed: false, requiresApproval: false, reason: 'policy_deny' };
    }
    const allow = matchAllowlist(action);
    if (allow) {
      if (askMode === 'always') return request(action, context, 'ask_always_allowlist');
      return { allowed: true, requiresApproval: false, reason: 'allowlist_matched' };
    }
    if (askMode === 'off') {
      return { allowed: false, requiresApproval: false, reason: 'allowlist_miss' };
    }
    return request(action, context, 'allowlist_miss');
  }

  function request(action, context, reason) {
    const approvalId = crypto.randomUUID();
    const row = {
      approvalId,
      createdAt: new Date().toISOString(),
      action,
      context,
      reason,
      status: 'pending',
      decision: null,
    };
    pending.set(approvalId, row);
    return {
      allowed: false,
      requiresApproval: true,
      reason,
      approvalId,
      pending: row,
    };
  }

  function decide(approvalIdLike, decisionLike) {
    const approvalId = String(approvalIdLike || '').trim();
    if (!approvalId) return null;
    const row = pending.get(approvalId);
    if (!row) return null;
    const decision = String(decisionLike || '').trim().toLowerCase();
    row.status = 'resolved';
    row.decision = decision === 'allow' ? 'allow' : 'deny';
    row.resolvedAt = new Date().toISOString();
    pending.set(approvalId, row);
    return row;
  }

  function canProceed(approvalIdLike) {
    const approvalId = String(approvalIdLike || '').trim();
    const row = pending.get(approvalId);
    if (!row) return false;
    return row.status === 'resolved' && row.decision === 'allow';
  }

  function listPending(limitLike = 100) {
    const limit = Math.max(1, Math.min(300, Number(limitLike || 100) || 100));
    return Array.from(pending.values())
      .filter((x) => x.status === 'pending')
      .slice(0, limit);
  }

  return {
    evaluate,
    decide,
    canProceed,
    listPending,
    getConfig() {
      return { policy, askMode, allowlist };
    },
  };
}
function csvToList(v) {
  return String(v || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

export function createApprovalGate(options = {}) {
  const security = String(options.security || process.env.THUNDERCLAW_APPROVAL_SECURITY || 'allowlist').trim();
  const ask = String(options.ask || process.env.THUNDERCLAW_APPROVAL_ASK || 'on-miss').trim();
  const allowlistRaw = options.allowlist || process.env.THUNDERCLAW_APPROVAL_ALLOWLIST || '';
  const allowPatterns = csvToList(allowlistRaw).map((p) => {
    try {
      return new RegExp(p, 'i');
    } catch {
      return null;
    }
  }).filter(Boolean);

  function isAllowedByAllowlist(actionLike) {
    const action = String(actionLike || '');
    if (!allowPatterns.length) return false;
    return allowPatterns.some((re) => re.test(action));
  }

  function evaluate(request = {}) {
    const action = String(request.action || '').trim();
    if (!action) {
      return { allowed: false, requiresApproval: false, reason: 'missing_action' };
    }
    if (security === 'full') {
      return { allowed: true, requiresApproval: ask === 'always', reason: 'full_security' };
    }
    if (security === 'deny') {
      if (request.approvalDecision === 'allow-once' || request.approvalDecision === 'allow-always') {
        return { allowed: true, requiresApproval: false, reason: 'explicit_approval' };
      }
      return { allowed: false, requiresApproval: true, reason: 'deny_by_default' };
    }
    const allowlistOk = isAllowedByAllowlist(action);
    if (allowlistOk && ask !== 'always') {
      return { allowed: true, requiresApproval: false, reason: 'allowlist' };
    }
    if (request.approvalDecision === 'allow-once' || request.approvalDecision === 'allow-always') {
      return { allowed: true, requiresApproval: false, reason: 'approved' };
    }
    return {
      allowed: false,
      requiresApproval: ask === 'off' ? false : true,
      reason: allowlistOk ? 'ask_always' : 'allowlist_miss',
    };
  }

  return {
    evaluate,
    config: { security, ask, allowlist: csvToList(allowlistRaw) },
  };
}
