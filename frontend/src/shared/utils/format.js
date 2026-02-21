export function fmtTsShort(tsLike) {
  const d = new Date(tsLike || Date.now());
  if (Number.isNaN(d.getTime())) return '-';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function fmtPrice(vLike) {
  const n = Number(vLike);
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtDurationMin(startLike, endLike = Date.now()) {
  const s = new Date(startLike || 0).getTime();
  const e = new Date(endLike || 0).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return '0m';
  const min = Math.floor((e - s) / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${m}m`;
}
