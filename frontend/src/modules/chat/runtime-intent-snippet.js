export const CHAT_RUNTIME_INTENT_SNIPPET = String.raw`
function looksLikeConfigIntentRuntime(queryLike) {
  const text = String(queryLike || '').trim();
  if (!text) return false;
  if (/查看配置|当前配置|配置状态|^配置$|^设置$/.test(text)) return true;
  if (/^\/(config|配置|设置|setup)\b/i.test(text)) return true;
  if (/(杠杆|leverage|单次|仓位|risk|风险比例|dryrun|dry-run|实盘|live|运行模式|聊天通道|channel)/i.test(text)) {
    return /配置|设置|绑定|连接|修改|切换|设为|改成|调整|参数|模式|运行|channel|通道|杠杆|仓位|风险|dryrun|live/i.test(text);
  }
  if (/telegram|tg|deepseek|codex|chatgpt|模型|model|token|apikey|api key/i.test(text)) {
    return /配置|设置|绑定|连接|修改|切换|登录|login|token|apikey|api key|模型|model/i.test(text);
  }
  return false;
}
`;
