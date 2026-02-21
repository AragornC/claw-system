export function normalizeXseaPostsList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && typeof item === 'object' && item.id && item.title && item.plan)
    .slice()
    .sort((a, b) => (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0));
}

export function normalizeXseaSelected(one) {
  if (!one || typeof one !== 'object') return null;
  if (!one.id || !one.title || !one.plan) return null;
  return one;
}

export function buildXseaPromptText(item, mode, promptHeaderMap, promptTail) {
  const modeKey = mode === 'train' ? 'train' : 'chat';
  const header = String(promptHeaderMap?.[modeKey] || promptHeaderMap?.chat || '请评估这条虾海策略，并给出可执行建议。');
  return [
    header,
    '策略标题：' + (item?.title || '-'),
    '作者：' + (item?.author || '-'),
    '摘要：' + (item?.summary || '-'),
    '详细策略：',
    String(item?.plan || '-'),
    '',
    String(promptTail || '请给出：1) 适配市场条件 2) 参数建议 3) 主要风险 4) 可落地执行步骤'),
  ].join('\n');
}
