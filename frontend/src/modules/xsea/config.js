export const XSEA_POSTS_KEY = 'thunderclaw.xsea.posts.v1';
export const XSEA_SELECTED_KEY = 'thunderclaw.xsea.selected.v1';

export const XSEA_PROMPT_HEADER = {
  train: '请将这条虾海策略作为本轮机器人训练参考，输出可执行建议。',
  chat: '请评估这条虾海策略，并给出可执行建议。',
};

export const XSEA_PROMPT_TAIL = '请给出：1) 适配市场条件 2) 参数建议 3) 主要风险 4) 可落地执行步骤';

export const XSEA_SEED = [
  {
    id: 'seed-v5-retest',
    title: 'BTC 回踩确认 + 成交量过滤',
    author: '虾策实验室',
    summary: '顺趋势优先，回踩结构确认后再入场，降低假突破。',
    plan: '入场：15m EMA20 上方回踩 + RSI 回升 + 量能放大\\n风控：1.8 ATR 止损 + 新闻门控\\n退出：3.0 ATR 止盈或趋势破坏',
    createdAtOffsetHours: -6,
  },
  {
    id: 'seed-v5-reentry',
    title: '趋势再入 + 分批加仓',
    author: 'Aragorn',
    summary: '主趋势确认后等待二次发力，再入场并限制最大持仓时间。',
    plan: '入场：1h 趋势方向一致 + 5m 动量二次放量\\n风控：固定 notional + 2.0 ATR 止损\\n退出：时间止盈 + 结构反转强制离场',
    createdAtOffsetHours: -26,
  },
];
