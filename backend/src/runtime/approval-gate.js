import crypto from 'node:crypto';

function normalizeSecurity(rawLike) {
  const raw = String(rawLike || '').trim().toLowerCase();
  if (raw === 'full' || raw === 'allowlist' || raw === 'deny') return raw;
  return 'allowlist';
}

function normalizeAsk(rawLike) {
  const raw = String(rawLike || '').trim().toLowerCase();
  if (raw === 'always' || raw === 'on-miss' || raw === 'off') return raw;
  return 'on-miss';
}

function toWords(inputLike) {
  return String(inputLike || '')
    .toLowerCase()
    .split(/[^a-z0-9_\u4e00-\u9fff:/.-]+/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

function isHighRisk(summaryLike) {
  const words = toWords(summaryLike);
  return (
    words.includes('bash') ||
    words.includes('shell') ||
    words.includes('exec') ||
    words.includes('write') ||
    words.includes('delete') ||
    words.includes('curl') ||
    words.includes('http') ||
    words.includes('外联') ||
    words.includes('写入')
  );
}

export function createApprovalGate(options = {}) {
  const defaults = options.defaults && typeof options.defaults === 'object' ? options.defaults : {};
  let baseSecurity = normalizeSecurity(defaults.security || options.security || 'allowlist');
  let baseAsk = normalizeAsk(defaults.ask || options.ask || 'on-miss');
  const allowlist = new Set(
    Array.isArray(defaults.allowlist || options.allowlist)
      ? (defaults.allowlist || options.allowlist).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean)
      : [],
  );
  const pending = new Map();
  const emitAudit = typeof options.emitAudit === 'function' ? options.emitAudit : () => {};

  function isAllowlisted(textLike) {
    const text = String(textLike || '').toLowerCase();
    if (!text) return false;
    for (const pattern of allowlist.values()) {
      if (text.includes(pattern)) return true;
    }
    return false;
  }

  function createPending(rowLike = {}) {
    const row = {
      approvalId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'pending',
      decision: null,
      ...rowLike,
    };
    pending.set(row.approvalId, row);
    return row;
  }

  function evaluate(inputLike = {}) {
    const input = inputLike && typeof inputLike === 'object' ? inputLike : {};
    const action = String(input.action || input.tool || '').trim();
    const summary = String(input.summary || action || '').trim();
    const security = normalizeSecurity(input.security || baseSecurity);
    const ask = normalizeAsk(input.ask || baseAsk);
    const highRisk = isHighRisk(summary);
    const allowlisted = isAllowlisted(`${action} ${summary}`);

    let allowed = false;
    let needApproval = false;
    let reason = 'denied_by_default';
    let approvalId = null;

    if (security === 'full') {
      allowed = true;
      reason = 'full_mode';
    } else if (security === 'allowlist') {
      allowed = allowlisted || !highRisk;
      reason = allowlisted ? 'allowlisted' : allowed ? 'low_risk' : 'allowlist_miss';
    } else {
      allowed = false;
      reason = 'deny_mode';
    }

    if (ask === 'always') {
      needApproval = true;
      allowed = false;
      reason = 'approval_required_always';
    } else if (ask === 'on-miss' && highRisk && !allowlisted) {
      needApproval = true;
      if (allowed) {
        allowed = false;
        reason = 'approval_required_on_miss';
      }
    }

    if (needApproval) {
      const row = createPending({
        action,
        summary,
        security,
        ask,
        highRisk,
        allowlisted,
        reason,
      });
      approvalId = row.approvalId;
    }

    const result = {
      allowed,
      needApproval,
      reason,
      security,
      ask,
      highRisk,
      allowlisted,
      approvalId,
    };
    emitAudit('approval.evaluate', { action, summary, ...result });
    return result;
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
    emitAudit('approval.decide', { approvalId, decision: row.decision });
    return row;
  }

  function canProceed(approvalIdLike) {
    const approvalId = String(approvalIdLike || '').trim();
    const row = pending.get(approvalId);
    return Boolean(row && row.status === 'resolved' && row.decision === 'allow');
  }

  function listPending(limitLike = 100) {
    const limit = Math.max(1, Math.min(500, Number(limitLike || 100) || 100));
    return Array.from(pending.values())
      .filter((x) => x.status === 'pending')
      .slice(0, limit);
  }

  function grantAlways(patternLike) {
    const pattern = String(patternLike || '').trim().toLowerCase();
    if (!pattern) return false;
    allowlist.add(pattern);
    emitAudit('approval.allowlist.add', { pattern });
    return true;
  }

  function updateConfig(patchLike = {}) {
    const patch = patchLike && typeof patchLike === 'object' ? patchLike : {};
    if (patch.security) baseSecurity = normalizeSecurity(patch.security);
    if (patch.ask) baseAsk = normalizeAsk(patch.ask);
    if (Array.isArray(patch.allowlist)) {
      allowlist.clear();
      for (const item of patch.allowlist) {
        const s = String(item || '').trim().toLowerCase();
        if (s) allowlist.add(s);
      }
    }
    return getSnapshot();
  }

  function getSnapshot() {
    return {
      security: baseSecurity,
      ask: baseAsk,
      allowlist: Array.from(allowlist.values()),
      pendingCount: listPending(500).length,
    };
  }

  return {
    evaluate,
    decide,
    canProceed,
    listPending,
    grantAlways,
    updateConfig,
    getSnapshot,
  };
}
