var XSEA_POSTS_KEY = "thunderclaw.xsea.posts.v1";
var XSEA_SELECTED_KEY = "thunderclaw.xsea.selected.v1";
var XSEA_PROMPT_HEADER = { "train": "请将这条虾海策略作为本轮机器人训练参考，输出可执行建议。", "chat": "请评估这条虾海策略，并给出可执行建议。" };
var XSEA_PROMPT_TAIL = "请给出：1) 适配市场条件 2) 参数建议 3) 主要风险 4) 可落地执行步骤";
var normalizeXseaPostsList = function normalizeXseaPostsList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && typeof item === 'object' && item.id && item.title && item.plan)
    .slice()
    .sort((a, b) => (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0));
};
var normalizeXseaSelected = function normalizeXseaSelected(one) {
  if (!one || typeof one !== 'object') return null;
  if (!one.id || !one.title || !one.plan) return null;
  return one;
};
var buildXseaPromptText = function buildXseaPromptText(item, mode, promptHeaderMap, promptTail) {
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
};
var buildXseaSelectedHtml = function buildXseaSelectedHtml(selectedXseaStrategy, escapeHtml) {
  if (selectedXseaStrategy) {
    return '当前训练参考：<strong>' + escapeHtml(selectedXseaStrategy.title) + '</strong> · ' + escapeHtml(selectedXseaStrategy.author || '-') + '。';
  }
  return '当前未选择训练参考策略。';
};
var buildXseaFeedHtml = function buildXseaFeedHtml(xseaPosts, escapeHtml, fmtTsShort) {
  if (!Array.isArray(xseaPosts) || !xseaPosts.length) {
    return '<div class="xsea-item"><div class="xsea-item-summary">暂无策略，先发布第一条策略吧。</div></div>';
  }
  return xseaPosts.map((item) => {
    const id = String(item?.id || '');
    return '<div class="xsea-item">' +
      '<div class="xsea-item-head">' +
      '<div class="xsea-item-title">' + escapeHtml(item?.title || '-') + '</div>' +
      '<div class="xsea-item-meta">' + escapeHtml(fmtTsShort(item?.createdAt)) + '</div>' +
      '</div>' +
      '<div class="xsea-item-meta">作者：' + escapeHtml(item?.author || '-') + '</div>' +
      '<div class="xsea-item-summary">' + escapeHtml(item?.summary || '-') + '</div>' +
      '<div class="xsea-item-plan">' + escapeHtml(item?.plan || '-') + '</div>' +
      '<div class="xsea-actions">' +
      '<button class="primary" type="button" data-xsea-action="pick" data-xsea-id="' + escapeHtml(id) + '">选取训练机器人</button>' +
      '<button type="button" data-xsea-action="chat" data-xsea-id="' + escapeHtml(id) + '">与 ThunderClaw 讨论</button>' +
      '<button type="button" data-xsea-action="remove" data-xsea-id="' + escapeHtml(id) + '">移除</button>' +
      '</div>' +
      '</div>';
  }).join('');
};
var applyXseaFeedAction = function applyXseaFeedAction(action, id, xseaPosts, selectedXseaStrategy) {
  const posts = Array.isArray(xseaPosts) ? xseaPosts : [];
  const item = posts.find((x) => String(x?.id || '') === String(id || '')) || null;
  if (!item) return { handled: false, nextPosts: posts, nextSelected: selectedXseaStrategy, aiMode: null };
  if (action === 'pick') {
    return { handled: true, nextPosts: posts, nextSelected: item, aiMode: 'train' };
  }
  if (action === 'chat') {
    return { handled: true, nextPosts: posts, nextSelected: selectedXseaStrategy, aiMode: 'chat' };
  }
  if (action === 'remove') {
    const nextPosts = posts.filter((x) => String(x?.id || '') !== String(id || ''));
    const nextSelected = selectedXseaStrategy && String(selectedXseaStrategy.id || '') === String(id || '')
      ? null
      : selectedXseaStrategy;
    return { handled: true, nextPosts, nextSelected, aiMode: null };
  }
  return { handled: false, nextPosts: posts, nextSelected: selectedXseaStrategy, aiMode: null };
};
var shouldSeedXseaPosts = function shouldSeedXseaPosts(postsLike) {
  return !Array.isArray(postsLike) || postsLike.length === 0;
};
var createXseaPostDraft = function createXseaPostDraft(fieldsLike, nowMs = Date.now()) {
  const fields = fieldsLike && typeof fieldsLike === 'object' ? fieldsLike : {};
  const title = String(fields.title || '').trim();
  const author = String(fields.author || '').trim();
  const summary = String(fields.summary || '').trim();
  const plan = String(fields.plan || '').trim();
  if (!title || !author || !summary || !plan) return null;
  return {
    id: 'xsea-' + Number(nowMs).toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    title,
    author,
    summary,
    plan,
    createdAt: new Date(nowMs).toISOString(),
  };
};
var resolveXseaAiTarget = function resolveXseaAiTarget(id, postsLike, fallbackLike) {
  const posts = Array.isArray(postsLike) ? postsLike : [];
  const target = posts.find((x) => String(x?.id || '') === String(id || '')) || null;
  if (target) return target;
  return fallbackLike && typeof fallbackLike === 'object' ? fallbackLike : null;
};
var prependXseaPost = function prependXseaPost(postLike, postsLike) {
  const post = postLike && typeof postLike === 'object' ? postLike : null;
  if (!post) return Array.isArray(postsLike) ? postsLike.slice() : [];
  const posts = Array.isArray(postsLike) ? postsLike : [];
  return [post, ...posts];
};
var buildXseaActionPersistencePlan = function buildXseaActionPersistencePlan(actionLike, actionResultLike) {
  const action = String(actionLike || '');
  const out = actionResultLike && typeof actionResultLike === 'object' ? actionResultLike : {};
  return {
    shouldPersistPosts: action === 'remove',
    shouldPersistSelected: action === 'pick' || action === 'remove',
    shouldAskAi: Boolean(out.aiMode),
  };
};
var parseXseaFeedClickEvent = function parseXseaFeedClickEvent(targetLike) {
  const target = targetLike && typeof targetLike === 'object' ? targetLike : null;
  const btn = target?.closest && target.closest('button[data-xsea-action][data-xsea-id]');
  if (!btn) return null;
  const action = String(btn.getAttribute('data-xsea-action') || '');
  const id = String(btn.getAttribute('data-xsea-id') || '');
  if (!action || !id) return null;
  return { action, id };
};
var readXseaFormFields = function readXseaFormFields(inputsLike) {
  const inputs = inputsLike && typeof inputsLike === 'object' ? inputsLike : {};
  return {
    title: String(inputs.titleInput?.value || ''),
    author: String(inputs.authorInput?.value || ''),
    summary: String(inputs.summaryInput?.value || ''),
    plan: String(inputs.planInput?.value || ''),
  };
};
