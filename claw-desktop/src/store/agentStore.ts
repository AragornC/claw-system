import { create } from "zustand";
import type {
  Agent,
  Skill,
  ToolFunction,
  AgentConfig,
  ActiveView,
  PermLevel,
} from "../types/agent";
import { loadAgentConfig, saveAgentConfig } from "../lib/agent";

/* ═══ Default seed data ═══ */
const DEFAULT_AGENTS: Agent[] = [
  { id:"analyst", name:"Analyst", role:"市场分析师", active:true,
    desc:"负责技术面分析、消息面解读、市场情绪判断。是最常被 Planner 调用的角色。",
    systemPrompt:`你是一个专业的金融市场分析师。你的核心职责是基于技术面和消息面的综合分析，给出市场趋势判断。

## 认知偏向
- 你倾向于寻找交易机会，但不会忽视风险信号
- 当技术面和消息面矛盾时，你会同时呈现两方面证据，不强行统一
- 你对「确定性」保持谨慎，所有判断必须附带置信度

## 沟通风格
- 结论先行，再展开分析过程
- 使用数据支撑观点，避免模糊用语（"可能会涨"→"基于RSI超卖+资金流入，偏多，置信度65%"）
- 不给出具体买卖价格，这不是你的职责范围

## 局限性声明
你不负责仓位计算和风险评估，这些由 Risk 角色完成。你的分析仅供参考，不构成投资建议。`,
    memory:"保留最近 7 天的分析记录，用于趋势连续性判断",
    skills:["market_analysis","earnings_analysis","news_sentiment"],
    fns:["web_search","get_klines","calculate_indicator","get_price","get_financial_data"] },
  { id:"quant", name:"Quant", role:"量化研究员", active:true,
    desc:"负责因子研究、策略开发、回测验证、量化信号生成。执行计算工作流最密集的角色。",
    systemPrompt:`你是一个严谨的量化研究员。你的工作是设计、实现和验证交易因子与策略。

## 认知偏向
- 你对统计显著性有极高要求，拒绝没有数据支撑的直觉判断
- 你天然警惕过拟合，参数越少越好，样本外表现是唯一标准
- 你对「前视偏差」零容忍

## 沟通风格
- 用数据说话：IC、IR、Sharpe、MaxDD 等指标必须给出
- 代码和回测结果是你的主要产出物，文字描述辅助
- 对自己的产出保持批判态度，主动报告不足之处

## 局限性声明
你不做市场方向判断（那是 Analyst 的事），你只关心因子/策略在统计上是否有效。`,
    memory:"保留已验证因子库和策略库的元数据，避免重复研究",
    skills:["factor_design","strategy_backtest","quant_signal"],
    fns:["web_search","get_klines","calculate_indicator","code_exec","backtest"] },
  { id:"risk", name:"Risk", role:"风控官", active:true,
    desc:"评估风险敞口、计算合理仓位、压力测试。有权对任何交易建议附加风险警告。",
    systemPrompt:`你是一个保守的风控官。你的核心原则是：保住本金比赚钱更重要。

## 认知偏向
- 你天然 skeptical，对所有"看好"的判断保持怀疑
- 你会主动寻找分析中的漏洞和被忽视的风险
- 同等条件下，你倾向于建议更小的仓位
- 你始终假设最坏情况会发生

## 沟通风格
- 先说风险，再说机会
- 对高风险操作必须用醒目方式标注
- 量化风险：不说"风险较大"，说"最大预期亏损 $X，占总资金 Y%"

## 局限性声明
你不负责判断行情方向，只评估给定方向下的风险暴露。你的建议可以被用户忽略，但必须被看到。`,
    memory:"保留持仓快照历史，用于风险趋势分析",
    skills:["risk_assessment","position_sizing","stress_test"],
    fns:["check_balance","get_positions","get_klines","get_price","code_exec"] },
  { id:"sentinel", name:"Sentinel", role:"市场哨兵", active:false,
    desc:"7×24 后台守护进程。不参与对话，只在异常时主动通知。",
    systemPrompt:`你是一个沉默的守望者。你不参与日常对话，只在检测到异常时发声。

## 认知偏向
- 你关注异常而非常态，正常的市场波动不值得报告
- 你对「速度」比「全面」更敏感——紧急情况下先通知、后补充
- 你会区分噪声和真实信号

## 沟通风格
- 通知必须简洁，一句话说清楚发生了什么
- 严重程度分级：info / warn / alert
- 24h 内同一条件不重复报警超过 3 次

## 局限性声明
你只负责发现和通知，不做分析和建议。触发紧急分析时，由 Planner 调度其他角色完成。`,
    memory:"保留监控规则和最近 30 天的报警历史",
    skills:["signal_monitor","decay_detector"],
    fns:["get_price","calculate_indicator","notify","get_positions"] },
  { id:"coordinator", name:"Coordinator", role:"综合协调者", active:true,
    desc:"读取所有角色报告，综合后产出统一建议。是提交给用户的最后一道门。",
    systemPrompt:`你是最终面向用户的综合协调者。你不做原始研究，只负责把其他角色的产出整合为一份清晰、可操作的建议。

## 认知偏向
- 你不偏向任何一个角色的观点，保持中立
- 当角色之间存在分歧时，你必须同时呈现双方立场，不替用户做决定
- 你的综合置信度必须低于最高单一角色（综合必然增加不确定性）

## 沟通风格
- 结构化输出：方向 → 置信度 → 理由 → 风险提示 → 操作建议
- 不使用专业术语堆砌，用用户能理解的语言
- 所有交易建议附带"仅供参考，不构成投资建议"声明

## 局限性声明
你不接触原始数据和研究工具。你的输入是其他角色的报告，输出是面向用户的最终建议。`,
    memory:"保留最近交付给用户的建议摘要，保持上下文连贯",
    skills:["report_synthesis"],
    fns:["notify"] },
];

const DEFAULT_SKILLS: Skill[] = [
  { id:"market_analysis", agent:"analyst", desc:"综合技术分析：趋势判断、支撑阻力、指标解读",
    fns:["web_search","get_klines","calculate_indicator","get_price"],
    guide:"用 `get_klines` 拉取目标品种 K 线（建议 1h + 1d 两个周期），用 `calculate_indicator` 计算技术指标（至少趋势类 + 超买超卖类各一个），用 `web_search` 搜索近 24h 消息面。这三步无依赖关系，用户已提供的数据可跳过对应步骤。\n\n最后综合技术面和消息面，输出趋势方向和置信度。",
    constraints:["必须同时分析技术面和消息面","趋势判断必须附带置信度","不得给出具体买卖价格（由 Risk 负责）"],
    eval:["技术指标引用与数据一致","消息面是最新的（24h内）","没有遗漏重大事件"] },
  { id:"earnings_analysis", agent:"analyst", desc:"财报解读：提取关键指标、同比分析、与市场预期对比",
    fns:["web_search","get_financial_data"],
    guide:"用 `get_financial_data` 获取最新季度财报，用 `web_search` 搜索分析师预期共识。提取关键指标（营收/利润/增速），与上季度、去年同期和市场预期分别对比，输出超预期或不及预期的判断及价格影响方向。",
    constraints:["数据必须标注来源","必须对比市场预期共识","不做盈利预测"],
    eval:["数据来源权威","对比预期准确","结论有数据支持"] },
  { id:"news_sentiment", agent:"analyst", desc:"新闻和社交媒体情绪分析：热度、情绪极性、关键事件提取",
    fns:["web_search"],
    guide:"用 `web_search` 搜索目标品种相关新闻，至少覆盖 3 个不同信息源。从结果中提取关键事件，判断每个事件的情绪极性和来源可信度，区分事实报道和观点评论。综合输出情绪评分（-1 到 1）和价格影响方向。",
    constraints:["至少 3 个信息源交叉验证","标注来源可信度","区分事实和观点"],
    eval:["多源交叉验证","情绪判断有依据","区分事实和猜测"] },
  { id:"factor_design", agent:"quant", desc:"交易因子研究、设计、实现、回测全流程",
    fns:["web_search","get_klines","code_exec","backtest","calculate_indicator"],
    guide:"先明确因子方向（动量/均值回归/波动率等），如需参考可用 `web_search` 搜索文献。用 `get_klines` 获取历史数据，设计因子逻辑后用 `code_exec` 实现 Python 代码。用 `backtest` 单品种回测计算 IC/IR/换手率，达标后至少再用一个品种交叉验证。最后综合评估输出完整报告。",
    constraints:["严禁前视偏差 shift(1)","扣手续费 0.1% + 滑点 0.05%","至少 2 个品种交叉验证"],
    eval:["IC > 0.03","IR > 0.5","换手率 < 30%","代码无前视偏差"] },
  { id:"strategy_backtest", agent:"quant", desc:"交易策略构建、回测、参数优化、性能分析",
    fns:["get_klines","code_exec","backtest","calculate_indicator"],
    guide:"用 `get_klines` 获取历史数据，用 `code_exec` 实现策略代码，然后用 `backtest` 做样本内回测计算 Sharpe/MaxDD/胜率。接着用 `code_exec` 做参数敏感性分析（网格搜索），最后用 `backtest` 在样本外数据上验证。",
    constraints:["必须含手续费和滑点","样本外留 20%","≤5 个参数防过拟合","必须报告最大回撤"],
    eval:["Sharpe > 1.0","MaxDD < 20%","样本外 ≥ 样本内 60%","参数稳定"] },
  { id:"quant_signal", agent:"quant", desc:"基于已有因子/策略生成实时量化信号",
    fns:["get_klines","calculate_indicator","code_exec"],
    guide:"用 `get_klines` 获取最新行情，用 `code_exec` 运行已验证的因子代码计算当前值。可用 `calculate_indicator` 辅助参考。综合输出信号方向、强度和置信度。只使用已验证的因子，不得临时设计新因子。",
    constraints:["只用已验证的因子","信号有效期不超 24h"],
    eval:["因子仍有效（IC 检查）","计算过程正确","置信度合理"] },
  { id:"risk_assessment", agent:"risk", desc:"评估当前持仓和拟建仓位的综合风险",
    fns:["check_balance","get_positions","get_klines","get_price"],
    guide:"用 `check_balance` 和 `get_positions` 获取账户状态，用 `get_klines` 拉取各品种历史数据计算波动率和相关性。综合计算总敞口、品种集中度和 VaR。如有拟建仓位则评估增量风险。输出风险等级和详细数据。",
    constraints:["必须考虑品种间相关性","VaR 至少 95% 置信度"],
    eval:["持仓数据最新","相关性计算合理","风险等级与数据一致"] },
  { id:"position_sizing", agent:"risk", desc:"基于风险预算计算最优仓位大小",
    fns:["check_balance","get_price","get_klines","code_exec"],
    guide:"用 `check_balance` 获取可用资金，用 `get_klines` 计算标的波动率，用 `get_price` 获取当前价格。然后用 `code_exec` 运行仓位计算公式，输出建议仓位、止损价位和最大预期损失。",
    constraints:["单笔 ≤ 总资金 20%（用户可调）","必须附带止损建议","展示最坏情况损失"],
    eval:["是否超仓位限制","止损是否合理","最大损失计算正确"] },
  { id:"stress_test", agent:"risk", desc:"极端场景模拟：触发X事件后持仓损益分析",
    fns:["get_positions","get_klines","code_exec"],
    guide:"用 `get_positions` 获取持仓，用 `get_klines` 获取历史数据。然后用 `code_exec` 定义并模拟至少 3 种压力场景（轻度/中度/极端），计算各场景 PnL 并检查强平线。输出压力测试报告和对冲建议。",
    constraints:["至少模拟 3 种场景（轻/中/极端）","必须检查强平线"],
    eval:["场景设定合理","含手续费滑点","考虑流动性风险"] },
  { id:"signal_monitor", agent:"sentinel", desc:"持续监控价格/成交量/指标，触发预设条件时报警",
    fns:["get_price","calculate_indicator","notify"],
    guide:"轮询模式：定期用 `get_price` 获取价格，用 `calculate_indicator` 计算指标，与预设阈值对比。满足条件时用 `notify` 推送通知。",
    constraints:["轮询间隔 ≥ 1min","单条件 24h 内 ≤ 3 次报警","通知必须含原因和数据"],
    eval:["触发条件真实满足","通知及时","无误报"] },
  { id:"decay_detector", agent:"sentinel", desc:"持续监控已部署因子/策略的表现衰减",
    fns:["get_klines","calculate_indicator","notify"],
    guide:"每日执行：用 `get_klines` 获取行情，用 `calculate_indicator` 计算各因子滚动 IC，与历史均值对比。衰减显著时用 `notify` 推送报警并附带 IC 曲线。",
    constraints:["检测窗口 ≥ 14 天","区分短期波动和长期衰减"],
    eval:["衰减判定有统计依据","区分噪声和趋势"] },
  { id:"report_synthesis", agent:"coordinator", desc:"将多角色研究报告综合为结构化最终建议",
    fns:["notify"],
    guide:"读取 Analyst / Quant / Risk 的研究报告，识别共识和分歧。对分歧同时呈现双方立场。综合计算加权置信度，生成结构化建议（方向→置信度→理由→风险提示→操作建议），用 `notify` 推送给用户。不调用任何数据获取类工具，输入是其他角色的报告。",
    constraints:["不可省略 Risk 风险提示","分歧必须呈现两方","置信度低于最高单一角色","附带\"仅供参考\"声明"],
    eval:["完整反映所有角色观点","分歧正确呈现","风险提示突出","置信度合理"] },
];

const DEFAULT_FUNCTIONS: ToolFunction[] = [
  { id:"web_search", cat:"搜索", perm:"auto", desc:"通用网络搜索（Tavily API）",
    params:[{name:"query",type:"string",req:true,desc:"搜索关键词"},{name:"max_results",type:"number",req:false,desc:"最大结果数，默认5"}],
    agents:["analyst","quant","sentinel"] },
  { id:"get_klines", cat:"行情", perm:"auto", desc:"获取K线/OHLCV历史数据",
    params:[{name:"symbol",type:"string",req:true,desc:"交易品种"},{name:"interval",type:"string",req:true,desc:"时间粒度，e.g. 1h/4h/1d"},{name:"limit",type:"number",req:false,desc:"获取条数，默认500"}],
    agents:["analyst","quant","risk","sentinel"] },
  { id:"get_price", cat:"行情", perm:"auto", desc:"获取实时最新报价",
    params:[{name:"symbol",type:"string",req:true,desc:"交易品种"}],
    agents:["analyst","risk","sentinel"] },
  { id:"calculate_indicator", cat:"计算", perm:"auto", desc:"计算技术指标（RSI/MACD/BB等）",
    params:[{name:"symbol",type:"string",req:true,desc:"品种"},{name:"indicator",type:"string",req:true,desc:"指标名称"},{name:"params",type:"object",req:false,desc:"指标参数，如 {period:14}"}],
    agents:["analyst","quant","sentinel"] },
  { id:"get_financial_data", cat:"基本面", perm:"auto", desc:"获取上市公司财务数据（财报/分析师预期）",
    params:[{name:"symbol",type:"string",req:true,desc:"股票代码"},{name:"period",type:"string",req:false,desc:"财报周期，默认最新季度"}],
    agents:["analyst"] },
  { id:"code_exec", cat:"计算", perm:"ask", desc:"执行 Python 代码（沙箱环境，用于量化计算）",
    params:[{name:"code",type:"string",req:true,desc:"Python 代码字符串"},{name:"timeout",type:"number",req:false,desc:"超时秒数，默认30"}],
    agents:["quant","risk"] },
  { id:"backtest", cat:"回测", perm:"ask", desc:"运行策略回测（接入历史行情）",
    params:[{name:"strategy_code",type:"string",req:true,desc:"策略代码"},{name:"start",type:"string",req:true,desc:"回测开始日期"},{name:"end",type:"string",req:false,desc:"回测结束日期，默认今天"}],
    agents:["quant"] },
  { id:"check_balance", cat:"账户", perm:"auto", desc:"查询当前账户余额和可用资金",
    params:[], agents:["risk"] },
  { id:"get_positions", cat:"账户", perm:"auto", desc:"获取当前持仓列表",
    params:[], agents:["risk","sentinel"] },
  { id:"notify", cat:"通知", perm:"auto", desc:"向用户推送通知消息",
    params:[{name:"message",type:"string",req:true,desc:"通知内容"},{name:"level",type:"string",req:false,desc:"级别：info / warn / alert"}],
    agents:["sentinel","coordinator"] },
  { id:"place_order", cat:"交易", perm:"deny", desc:"提交交易订单（仅用户确认后由系统执行，任何 Agent 不可直接调用）",
    params:[{name:"symbol",type:"string",req:true,desc:"品种"},{name:"side",type:"string",req:true,desc:"buy/sell"},{name:"amount",type:"number",req:true,desc:"数量"}],
    agents:[] },
  { id:"cancel_order", cat:"交易", perm:"deny", desc:"撤销订单（仅用户确认后由系统执行）",
    params:[{name:"order_id",type:"string",req:true,desc:"订单ID"}],
    agents:[] },
];

const DEFAULT_CONFIG: AgentConfig = {
  agents: DEFAULT_AGENTS,
  skills: DEFAULT_SKILLS,
  functions: DEFAULT_FUNCTIONS,
};

/* ═══ Store ═══ */
interface AgentStoreState {
  agents: Agent[];
  skills: Skill[];
  functions: ToolFunction[];
  activeView: ActiveView;
  loaded: boolean;

  setActiveView: (view: ActiveView) => void;
  clearActiveView: () => void;

  addAgent: (agent: Agent) => void;
  updateAgent: (id: string, patch: Partial<Agent>) => void;
  removeAgent: (id: string) => void;
  toggleAgentActive: (id: string) => void;

  addSkill: (skill: Skill) => void;
  updateSkill: (id: string, patch: Partial<Skill>) => void;
  removeSkill: (id: string) => void;

  addFunction: (fn: ToolFunction) => void;
  updateFunction: (id: string, patch: Partial<ToolFunction>) => void;
  removeFunction: (id: string) => void;
  changeFunctionPerm: (id: string, perm: PermLevel) => void;

  initFromBackend: () => Promise<void>;
}

function persistConfig(state: { agents: Agent[]; skills: Skill[]; functions: ToolFunction[] }) {
  saveAgentConfig({
    agents: state.agents,
    skills: state.skills,
    functions: state.functions,
  }).catch(console.error);
}

export const useAgentStore = create<AgentStoreState>((set, get) => ({
  agents: [],
  skills: [],
  functions: [],
  activeView: null,
  loaded: false,

  setActiveView: (view) => set({ activeView: view }),
  clearActiveView: () => set({ activeView: null }),

  addAgent: (agent) => {
    set((s) => ({ agents: [...s.agents, agent] }));
    persistConfig(get());
  },
  updateAgent: (id, patch) => {
    set((s) => ({
      agents: s.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    }));
    persistConfig(get());
  },
  removeAgent: (id) => {
    set((s) => ({ agents: s.agents.filter((a) => a.id !== id) }));
    persistConfig(get());
  },
  toggleAgentActive: (id) => {
    set((s) => ({
      agents: s.agents.map((a) =>
        a.id === id ? { ...a, active: !a.active } : a
      ),
    }));
    persistConfig(get());
  },

  addSkill: (skill) => {
    set((s) => ({ skills: [...s.skills, skill] }));
    persistConfig(get());
  },
  updateSkill: (id, patch) => {
    set((s) => ({
      skills: s.skills.map((sk) => (sk.id === id ? { ...sk, ...patch } : sk)),
    }));
    persistConfig(get());
  },
  removeSkill: (id) => {
    set((s) => ({ skills: s.skills.filter((sk) => sk.id !== id) }));
    persistConfig(get());
  },

  addFunction: (fn) => {
    set((s) => ({ functions: [...s.functions, fn] }));
    persistConfig(get());
  },
  updateFunction: (id, patch) => {
    set((s) => ({
      functions: s.functions.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    }));
    persistConfig(get());
  },
  removeFunction: (id) => {
    set((s) => ({ functions: s.functions.filter((f) => f.id !== id) }));
    persistConfig(get());
  },
  changeFunctionPerm: (id, perm) => {
    set((s) => ({
      functions: s.functions.map((f) => (f.id === id ? { ...f, perm } : f)),
    }));
    persistConfig(get());
  },

  initFromBackend: async () => {
    try {
      const cfg = await loadAgentConfig();
      if (cfg && cfg.agents.length > 0) {
        set({ agents: cfg.agents, skills: cfg.skills, functions: cfg.functions, loaded: true });
      } else {
        set({ ...DEFAULT_CONFIG, loaded: true });
        persistConfig(DEFAULT_CONFIG);
      }
    } catch {
      set({ ...DEFAULT_CONFIG, loaded: true });
    }
  },
}));
