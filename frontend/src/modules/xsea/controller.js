export function shouldSeedXseaPosts(postsLike) {
  return !Array.isArray(postsLike) || postsLike.length === 0;
}

export function createXseaPostDraft(fieldsLike, nowMs = Date.now()) {
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
}

export function resolveXseaAiTarget(id, postsLike, fallbackLike) {
  const posts = Array.isArray(postsLike) ? postsLike : [];
  const target = posts.find((x) => String(x?.id || '') === String(id || '')) || null;
  if (target) return target;
  return fallbackLike && typeof fallbackLike === 'object' ? fallbackLike : null;
}

export function prependXseaPost(postLike, postsLike) {
  const post = postLike && typeof postLike === 'object' ? postLike : null;
  if (!post) return Array.isArray(postsLike) ? postsLike.slice() : [];
  const posts = Array.isArray(postsLike) ? postsLike : [];
  return [post, ...posts];
}

export function buildXseaActionPersistencePlan(actionLike, actionResultLike) {
  const action = String(actionLike || '');
  const out = actionResultLike && typeof actionResultLike === 'object' ? actionResultLike : {};
  return {
    shouldPersistPosts: action === 'remove',
    shouldPersistSelected: action === 'pick' || action === 'remove',
    shouldAskAi: Boolean(out.aiMode),
  };
}

export function parseXseaFeedClickEvent(targetLike) {
  const target = targetLike && typeof targetLike === 'object' ? targetLike : null;
  const btn = target?.closest && target.closest('button[data-xsea-action][data-xsea-id]');
  if (!btn) return null;
  const action = String(btn.getAttribute('data-xsea-action') || '');
  const id = String(btn.getAttribute('data-xsea-id') || '');
  if (!action || !id) return null;
  return { action, id };
}

export function readXseaFormFields(inputsLike) {
  const inputs = inputsLike && typeof inputsLike === 'object' ? inputsLike : {};
  return {
    title: String(inputs.titleInput?.value || ''),
    author: String(inputs.authorInput?.value || ''),
    summary: String(inputs.summaryInput?.value || ''),
    plan: String(inputs.planInput?.value || ''),
  };
}
