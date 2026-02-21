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
