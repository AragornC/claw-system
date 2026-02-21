export function buildXseaSelectedHtml(selectedXseaStrategy, escapeHtml) {
  if (selectedXseaStrategy) {
    return '当前训练参考：<strong>' + escapeHtml(selectedXseaStrategy.title) + '</strong> · ' + escapeHtml(selectedXseaStrategy.author || '-') + '。';
  }
  return '当前未选择训练参考策略。';
}

export function buildXseaFeedHtml(xseaPosts, escapeHtml, fmtTsShort) {
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
}

export function applyXseaFeedAction(action, id, xseaPosts, selectedXseaStrategy) {
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
}
