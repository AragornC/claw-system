import { chatStreamWithTools } from "./workflow-llm";
import { StringFieldStreamer } from "./stream-json";
import { execTool, toolBrief } from "./tools";
import {
  MEM_TOOLS_FULL,
  isMemoryTool,
  execMemoryTool,
  memoryToolBrief,
} from "./memory-tools";
// NOTE: multi-agent Coordinator branch intentionally disconnected.
// Keeping ./coordinator and the Coord/Plan/AgentTask UI components on disk
// so we can re-enable the flow once the agent design is reconsidered.
// import { runCoordinator } from "./coordinator";
import { generateTitle } from "./llm";
import { useChatStore } from "../store/chatStore";
import { useExchangeStore } from "../store/exchangeStore";
import { useMemoryStore } from "../store/memoryStore";
import type {
  WorkflowMessage,
  ToolDef,
  ChatItem,
  ThinkingItem,
  ToolGroupItem,
  TextItem,
  RouteDecision,
} from "../types/workflow";

// ── System prompts & tool definitions ───────────────────────

const THINKING_SYSTEM = `你是 ThunderClaw 的路由分类器。

**严格规则**：
1. 你的唯一任务是把用户请求分类到 direct_reply / simple_tool 两条路径之一，并调用 route 函数。
2. **绝对禁止回答用户问题**。不要输出 markdown 报告、表格、价格数据、分析结论、任何面向用户的内容。
3. **正文内容必须为空**。把你的推理放进 route 函数的 \`thinking\` 参数里（1-2 句），正文一个字都不要写。
4. 用户看不到正文，只看到 thinking 参数。

**分类标准**：
- direct_reply: 闲聊、自我介绍、不需要实时数据或外部信息的问题
- simple_tool: 任何需要外部数据的问题——价格、K 线、指标、持仓、余额、新闻搜索、多维度分析。不管单一还是多工具，都走这里（允许多轮工具调用）。

**示例**：
用户"你好" → route({thinking:"闲聊", path:"direct_reply"})
用户"BTC 多少钱" → route({thinking:"单一价格查询", path:"simple_tool", tools:["get_price"]})
用户"最近 ETH 怎么样" → route({thinking:"需查价格+K线走势", path:"simple_tool", tools:["get_price","get_klines"]})
用户"帮我分析要不要加仓 BTC" → route({thinking:"需要价格+指标+持仓+新闻综合判断", path:"simple_tool", tools:["get_price","calculate_indicator","get_positions","web_search"]})
用户"最近 BTC 有什么新闻" → route({thinking:"查外部新闻", path:"simple_tool", tools:["web_search"]})

现在只做一件事：调用 route 函数。`;

const ROUTE_TOOL: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "route",
      description:
        "对用户请求分类。thinking 参数必须包含你的推理，不要在正文输出任何内容。",
      parameters: {
        type: "object",
        properties: {
          thinking: {
            type: "string",
            description:
              "你的内部推理（1-2 句）：这是什么类型的请求、为什么选择对应路径",
          },
          path: {
            type: "string",
            enum: ["direct_reply", "simple_tool"],
            description:
              "direct_reply=不需要工具直接回答；simple_tool=需要外部数据（价格/指标/新闻/持仓等），可多轮工具调用",
          },
          tools: {
            type: "array",
            items: { type: "string" },
            description: 'simple_tool 时建议的工具列表，如 ["get_price","web_search"]',
          },
        },
        required: ["thinking", "path"],
      },
    },
  },
];

const SIMPLE_TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "get_price",
      description: "获取加密货币实时价格和成交量",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "交易对如 BTC/USDT" },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_klines",
      description: "获取K线历史数据",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          interval: { type: "string", description: "1m/5m/1h/4h/1d" },
          limit: { type: "number" },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculate_indicator",
      description: "计算技术指标 (RSI/MACD/BOLL)",
      parameters: {
        type: "object",
        properties: {
          indicator: { type: "string", enum: ["RSI", "MACD", "BOLL"] },
          period: { type: "number" },
        },
        required: ["indicator"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_balance",
      description: "查询账户余额",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_positions",
      description: "查询当前持仓",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "通用网络搜索（Tavily）。适合抓最新新闻、市场情绪、政策、链上动态、ETF 流入等需要外部信息的问题。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词，中英文都可" },
          max_results: { type: "number", description: "结果数，默认 5，最多 20" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_financial_data",
      description:
        "Binance 永续衍生数据。适合判断市场情绪：funding 高 → 多头拥挤；OI 飙升 → 杠杆增加；L/S 比 → 散户 vs 大户分歧；taker B/S → 主动盘强弱；basis → 升贴水。",
      parameters: {
        type: "object",
        properties: {
          metric: {
            type: "string",
            enum: [
              "funding_rate",
              "open_interest",
              "long_short_ratio",
              "taker_buy_sell_ratio",
              "basis",
            ],
          },
          symbol: { type: "string", description: "如 BTCUSDT" },
          limit: { type: "number", description: "历史点数，默认 24" },
          period: {
            type: "string",
            description: "1h/4h/1d 等，funding 不适用",
          },
        },
        required: ["metric", "symbol"],
      },
    },
  },
  // ── 特征库（Pyodide 沙箱执行的 Python 因子）──────────────────────
  // 在用户说「帮我写一个监控 X 的特征」「列出我有哪些特征」「跑一下 Y
  // 这个特征看看输出」时调用。create_feature 写完会自动落盘 + 出现在
  // 侧栏，run_feature 真打 Binance 数据 + 跑 Python。
  {
    type: "function",
    function: {
      name: "list_features",
      description:
        "列出当前所有用户特征（Python 因子）及其状态、最近运行结果。用户问「我有哪些特征」「特征库里有什么」时调用。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "create_feature",
      description: [
        "创建新特征（保存为 Python 文件并加入特征库）。",
        "code 必须定义 async def compute(...)；可以 import statistics / math / json / datetime。",
        "禁止 import requests / urllib / aiohttp / os / subprocess（沙箱拒绝）。",
        "compute() 返回值必须是 JSON 可序列化的 dict，建议带 signal 字段。",
        "── thunderclaw 包返回结构（务必按这个 shape 取数）──",
        "1) market.price(symbol) → { symbol, price, change_24h, high_24h, low_24h, volume_24h }",
        "2) market.klines(symbol, interval='1h', limit=100) → { symbol, interval, count, latest:{open,high,low,close}, closes:[float] }",
        "3) market.funding_rate(symbol, limit=24) → { symbol, current:{rate, rate_pct, mark_price, ...}, history:[{time, rate, rate_pct}] }",
        "4) market.open_interest(symbol, period='1h', limit=24) → { symbol, period, current:{oi_contracts, oi_value_usd}, history:[{time, oi, oi_value_usd}] }",
        "5) market.long_short_ratio(symbol, period='1h', limit=24) → { symbol, period, global_account:{ratio, long_pct, short_pct}, top_account:{...}, top_position:{...}, history:{global_account:[...]} }",
        "6) account.balance() → { exchange, total_usd, spot:{...}, futures:{...} }",
        "7) account.positions(symbol?) → { exchange, positions:[{symbol, side, qty, entry_price, mark_price, unrealized_pnl}], count, total_unrealized_pnl }",
        "8) news.search(query, max_results=5) → { query, answer, results:[{title, url, snippet, score}] }",
        "重要：以上对象**都是 dict**，不是 list。要遍历历史，用 data['history']（注意 funding_rate 的 history 是 list；long_short_ratio 的 history 是 dict 里再套 list）。",
        "示例（OI 24h 变化率 — 正确写法）：",
        "  data = await market.open_interest('ETHUSDT', period='1h', limit=24)",
        "  hist = data.get('history') or []",
        "  if len(hist) < 2: return {'signal':'insufficient_data', 'n': len(hist)}",
        "  old_oi, new_oi = hist[0]['oi_value_usd'], hist[-1]['oi_value_usd']",
        "  pct = (new_oi - old_oi) / old_oi if old_oi else 0",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            description:
              "唯一 ID：小写字母开头，只含 [a-z0-9_]，<=64 字符。例如 funding_zscore",
          },
          display_name: {
            type: "string",
            description: "中文展示名，用户在侧栏看到的",
          },
          category: {
            type: "string",
            description: "分类标签：情绪/动量/波动/风控/趋势 等任意短词",
          },
          description: {
            type: "string",
            description: "一两句解释这个特征做什么 + 怎么读输出",
          },
          code: {
            type: "string",
            description: "完整的 Python 源码（要包含 async def compute 定义）",
          },
        },
        required: ["slug", "display_name", "code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_feature",
      description:
        "运行一个已存在的特征，返回 compute() 的输出。用户问「跑一下 X 看看」「现在 funding zscore 多少」时用。",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "特征 slug" },
          args: {
            type: "object",
            description: "传给 compute 的关键字参数（可选；不传用默认值）",
          },
        },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_feature",
      description: "删除一个特征。用户明确说要删时才用，谨慎。",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string" },
        },
        required: ["slug"],
      },
    },
  },
];

// ── Build system context ────────────────────────────────────

function buildContext(): string {
  let exchangeName = "未连接";
  let balanceStr = "$10,000 (模拟)";

  try {
    const ex = useExchangeStore.getState();
    const activeEntry = Object.entries(ex.auth || {}).find(
      ([, a]) => a?.connected
    );
    if (activeEntry) {
      exchangeName = activeEntry[0];
      const bal = ex.balances?.[activeEntry[0]];
      if (bal?.spot?.total_usd != null) {
        balanceStr = `$${bal.spot.total_usd.toLocaleString()}`;
      }
    }
  } catch {
    // exchange store not ready
  }

  // Inject MEMORY.md index so models know what memory exists
  const { index: memoryIndex, files: memoryFiles } = useMemoryStore.getState();
  const fileCount = Object.keys(memoryFiles).length;
  const memorySection = memoryIndex
    ? `## MEMORY.md 索引\n${memoryIndex}`
    : fileCount > 0
      ? `## MEMORY.md 索引\n(索引待 Coordinator 更新，已有 ${fileCount} 个记忆文件)`
      : `## MEMORY.md 索引\n(空 — 尚无记忆，值得记住的事可以写入 shared/ analyst/ risk/ coordinator/)`;

  return `## 系统状态
- 当前时间: ${new Date().toLocaleString("zh-CN")}
- 连接交易所: ${exchangeName}
- 账户余额: ${balanceStr}

## 可用工具
get_price, get_klines, calculate_indicator, check_balance, get_positions, web_search

${memorySection}`;
}

// ── Conversation history extraction ─────────────────────────
//
// Maps the session's ChatItem[] back to OpenAI-style messages so the LLM
// sees prior exchanges. We skip internal artifacts (thinking blocks,
// tool groups) — they're UI-only.
//
// The final user item (the one we just pushed) is excluded; the caller
// appends the current userText separately so it's always the last message.

function buildConversationHistory(sessionId: string): WorkflowMessage[] {
  const session = useChatStore
    .getState()
    .sessions.find((s) => s.id === sessionId);
  if (!session) return [];

  // Drop the last item (the just-pushed user message) — caller adds it back.
  const items = session.items.slice(0, -1);

  const msgs: WorkflowMessage[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      msgs.push({ role: "user", content: item.text });
    } else if (item.kind === "text" && item.text.trim()) {
      // Merge consecutive assistant text items (ReAct loop artifacts)
      const last = msgs[msgs.length - 1];
      if (last?.role === "assistant" && typeof last.content === "string") {
        last.content = last.content + "\n" + item.text;
      } else {
        msgs.push({ role: "assistant", content: item.text });
      }
    }
    // thinking / tool_group → skip (internal UI blocks)
  }

  // Cap history to last 20 turns to avoid runaway token usage
  return msgs.slice(-40);
}

// ── Main workflow entry point ───────────────────────────────

export async function runWorkflow(
  userText: string,
  sessionId: string,
  providerId: string,
  model: string
): Promise<void> {
  const store = useChatStore.getState();

  // 1. Push user message
  store.pushItem(sessionId, { kind: "user", text: userText });

  // Auto-generate title on first message
  const session = store.sessions.find((s) => s.id === sessionId);
  if (session && session.items.length <= 1 && !session.isNameCustomized) {
    generateTitle(providerId, model, userText)
      .then((title) =>
        useChatStore.getState().renameSession(sessionId, title, false)
      )
      .catch(() => {});
  }

  const ctx = buildContext();

  // 2. Thinking: Router classification
  const thinkingStart = Date.now();
  const thinkingIdx = pushAndGetIndex(sessionId, {
    kind: "thinking",
    text: "",
    durationMs: 0,
    collapsed: false,
  });

  let route: RouteDecision = { path: "direct_reply" };

  try {
    // For reasoning models (DeepSeek R1 / o1), real CoT lives in thinking_delta
    // and we surface it progressively. For non-reasoning models, we DON'T
    // show content_delta in the thinking UI — the model tends to use that
    // channel to answer the user directly, which pollutes the router block
    // with markdown reports. Those models put their reasoning in the
    // route() tool's `thinking` argument instead; we overwrite the UI with
    // that authoritative value once the tool call completes.
    const appendThinkingDelta = (delta: string) => {
      useChatStore.getState().updateItem(sessionId, thinkingIdx, (item) => {
        const t = item as ThinkingItem;
        return { ...t, text: t.text + delta, durationMs: Date.now() - thinkingStart };
      });
    };

    // Non-reasoning models hide their reasoning inside the route tool's
    // `thinking` argument string — which streams token-by-token but
    // arrives wrapped in JSON. StringFieldStreamer unwraps it on the fly
    // so the user sees the thinking prose appear live instead of popping
    // in all at once when the tool call closes.
    const thinkingStreamer = new StringFieldStreamer("thinking", (c) => {
      appendThinkingDelta(c);
    });

    const history = buildConversationHistory(sessionId);
    const thinkResult = await chatStreamWithTools(
      providerId,
      model,
      [
        { role: "system", content: THINKING_SYSTEM },
        { role: "system", content: ctx },
        ...history,
        { role: "user", content: userText },
      ],
      ROUTE_TOOL,
      {
        onThinkingDelta: appendThinkingDelta, // R1 reasoning_content
        // onContentDelta intentionally omitted — standard models use
        // tool-call arguments for reasoning (see THINKING_SYSTEM).
        onToolArgsDelta: ({ toolIndex, argsSoFar, fragment }) => {
          if (toolIndex !== 0) return;
          thinkingStreamer.feed(argsSoFar, fragment);
        },
      },
      // Force a tool call. ROUTE_TOOL is single-entry so "required"
      // unambiguously pins the route function. Avoid the nested
      // {type:"function", function:{name}} shape because gpt-5* and
      // Gemini's openai-compat reject it ("Unknown parameter:
      // tool_choice.function").
      "required"
    );

    // Extract route from tool call. thinking text has already been
    // progressively written by StringFieldStreamer — we only patch if
    // that stream missed something (e.g. R1 reasoning was used instead).
    let fallbackThinking = "";
    if (thinkResult.toolCalls.length > 0) {
      try {
        const args = JSON.parse(thinkResult.toolCalls[0].arguments);
        route = {
          path: args.path || "direct_reply",
          tools: args.tools,
          agents: args.agents,
        };
        if (typeof args.thinking === "string" && args.thinking.trim()) {
          fallbackThinking = args.thinking.trim();
        }
      } catch {
        /* fallback to direct_reply */
      }
    }

    // Finalize thinking UI. If the streamer already wrote the prose live,
    // leave it alone; only substitute if the UI is empty (streamer failed
    // to match the field, or the model delivered reasoning differently).
    const durationMs = Date.now() - thinkingStart;
    useChatStore.getState().updateItem(sessionId, thinkingIdx, (item) => {
      const t = item as ThinkingItem;
      const finalText = t.text.trim() ? t.text : fallbackThinking;
      return { ...t, text: finalText, durationMs, collapsed: true };
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    useChatStore.getState().updateItem(sessionId, thinkingIdx, (item) => ({
      ...(item as ThinkingItem),
      text: `思考出错: ${errMsg}`,
      durationMs: Date.now() - thinkingStart,
      collapsed: false,
    }));
    return;
  }

  // 3. Dispatch based on route
  //
  // Multi-agent Coordinator path is temporarily disabled — the agent
  // orchestration needs redesign. Legacy `coordinator_task` / `agent_task`
  // values (from older sessions or an overly-enthusiastic router) fall
  // through to simple_tool, which now handles everything tool-backed.
  if (route.path === "direct_reply") {
    await handleDirectReply(sessionId, providerId, model, userText, ctx);
  } else {
    await handleSimpleTool(sessionId, providerId, model, userText, ctx);
  }
}

// ── direct_reply: LLM streaming + optional memory writes ────
//
// Even simple replies may need to remember things (user tells us their name,
// a preference, etc). We attach memory tools so the LLM can write/update
// memory after answering.

async function handleDirectReply(
  sessionId: string,
  providerId: string,
  model: string,
  userText: string,
  ctx: string
): Promise<void> {
  const systemPrompt = `你是 ThunderClaw，加密货币量化交易 AI 助手。简洁友好地回答用户。

## 记忆系统
你有记忆管理工具可用。如果用户告诉了你值得记住的信息（姓名、偏好、身份等），先正常回答，然后调用工具把它写入记忆。

记忆按 namespace 分区：
- shared/ — 用户信息、偏好、跨 Agent 共享的知识
- analyst/ — 分析师发现
- risk/ — 风控评估
- coordinator/ — 协调器元知识

写入原则：
1. write_memory 把信息存入合适的 namespace 下的 .md 文件
2. update_index 在 MEMORY.md 里加一行 - [文件名](路径) — 一句话摘要（摘要要具体）
3. 不是所有对话都值得记忆，只记关键信息

${ctx}`;

  // Expose both data tools and memory tools. Router may have misclassified
  // a market query as direct_reply; rather than reject the LLM's tool calls
  // with "unsupported tool" (which poisons the turn), just serve them.
  const allTools = [...SIMPLE_TOOL_DEFS, ...MEM_TOOLS_FULL];

  const history = buildConversationHistory(sessionId);
  const msgs: WorkflowMessage[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userText },
  ];

  let dataGroupIdx: number | null = null;
  let memGroupIdx: number | null = null;

  for (let round = 0; round < 5; round++) {
    const textIdx = pushAndGetIndex(sessionId, { kind: "text", text: "" });

    const result = await chatStreamWithTools(
      providerId,
      model,
      msgs,
      allTools,
      {
        onContentDelta: (delta) => {
          useChatStore.getState().updateItem(sessionId, textIdx, (item) => {
            const t = item as TextItem;
            return { ...t, text: t.text + delta };
          });
        },
      }
    );

    // No tool calls → final answer, done
    if (result.toolCalls.length === 0) break;

    // Build assistant message for history
    msgs.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    // Dispatch: memory tools → local memory store, others → real execTool.
    for (const tc of result.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.arguments || "{}");
      } catch {
        /* empty */
      }

      const isMem = isMemoryTool(tc.name);

      if (isMem) {
        if (memGroupIdx === null) {
          memGroupIdx = pushAndGetIndex(sessionId, {
            kind: "tool_group",
            title: "Updating memory",
            tools: [],
            collapsed: false,
          });
        }
        const out = execMemoryTool(tc.name, args, null);
        const brief = memoryToolBrief(tc.name, args, out);
        useChatStore
          .getState()
          .updateItem(sessionId, memGroupIdx, (item) => {
            const g = item as ToolGroupItem;
            return {
              ...g,
              tools: [
                ...g.tools,
                { id: tc.id, name: tc.name, args, result: out, brief },
              ],
            };
          });
        msgs.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(out),
        });
      } else {
        if (dataGroupIdx === null) {
          dataGroupIdx = pushAndGetIndex(sessionId, {
            kind: "tool_group",
            title: "Fetching data",
            tools: [],
            collapsed: false,
          });
        }
        try {
          const out = await execTool(tc.name, args);
          const brief = toolBrief(tc.name, out);
          useChatStore
            .getState()
            .updateItem(sessionId, dataGroupIdx, (item) => {
              const g = item as ToolGroupItem;
              return {
                ...g,
                tools: [
                  ...g.tools,
                  { id: tc.id, name: tc.name, args, result: out, brief },
                ],
              };
            });
          msgs.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(out),
          });
        } catch (e) {
          const err = { error: String(e) };
          useChatStore
            .getState()
            .updateItem(sessionId, dataGroupIdx, (item) => {
              const g = item as ToolGroupItem;
              return {
                ...g,
                tools: [
                  ...g.tools,
                  { id: tc.id, name: tc.name, args, result: err, brief: String(e) },
                ],
              };
            });
          msgs.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(err),
          });
        }
      }
    }
  }

  // Collapse groups
  if (dataGroupIdx !== null) {
    useChatStore.getState().updateItem(sessionId, dataGroupIdx, (item) => ({
      ...(item as ToolGroupItem),
      collapsed: true,
    }));
  }
  if (memGroupIdx !== null) {
    useChatStore.getState().updateItem(sessionId, memGroupIdx, (item) => ({
      ...(item as ToolGroupItem),
      title: "Memory updated",
      collapsed: true,
    }));
  }
}

// ── simple_tool: ReAct loop ─────────────────────────────────

async function handleSimpleTool(
  sessionId: string,
  providerId: string,
  model: string,
  userText: string,
  ctx: string
): Promise<void> {
  // Combine market tools + memory tools so LLM can save results if useful
  const allTools = [...SIMPLE_TOOL_DEFS, ...MEM_TOOLS_FULL];

  const history = buildConversationHistory(sessionId);
  const msgs: WorkflowMessage[] = [
    {
      role: "system",
      content: `你是 ThunderClaw。用一句话说明你要做什么，然后调用工具。如果需要查多个数据就多次调用工具。拿到所有数据后给出简洁回答。

如果查到的结果值得记住（例如用户关注的币种价格、用户的操作偏好等），可以用 write_memory + update_index 保存到 shared/。不必每次都记，只记关键信息。

${ctx}`,
    },
    ...history,
    { role: "user", content: userText },
  ];

  let dataGroupIdx: number | null = null;
  let memGroupIdx: number | null = null;

  for (let round = 0; round < 5; round++) {
    const textIdx = pushAndGetIndex(sessionId, { kind: "text", text: "" });

    // Round 0 forces a tool call — DeepSeek chat will happily hallucinate
    // market data as prose if given the chance (we saw it invent an entire
    // ETH price card). Forcing "required" on the first round guarantees
    // we actually hit Binance. Subsequent rounds use "auto" so the loop
    // can terminate with a plain text answer.
    const choice = round === 0 ? ("required" as const) : ("auto" as const);

    const result = await chatStreamWithTools(
      providerId,
      model,
      msgs,
      allTools,
      {
        onContentDelta: (delta) => {
          useChatStore.getState().updateItem(sessionId, textIdx, (item) => {
            const t = item as TextItem;
            return { ...t, text: t.text + delta };
          });
        },
      },
      choice
    );

    // No tool calls → final answer, done
    if (result.toolCalls.length === 0) break;

    // Build assistant message for history
    msgs.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    // Execute each tool call — dispatch to data vs memory groups
    for (const tc of result.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.arguments || "{}");
      } catch {
        /* empty */
      }

      const isMem = isMemoryTool(tc.name);

      if (isMem) {
        if (memGroupIdx === null) {
          memGroupIdx = pushAndGetIndex(sessionId, {
            kind: "tool_group",
            title: "Updating memory",
            tools: [],
            collapsed: false,
          });
        }
        const out = execMemoryTool(tc.name, args, null);
        const brief = memoryToolBrief(tc.name, args, out);
        useChatStore
          .getState()
          .updateItem(sessionId, memGroupIdx, (item) => {
            const g = item as ToolGroupItem;
            return {
              ...g,
              tools: [
                ...g.tools,
                { id: tc.id, name: tc.name, args, result: out, brief },
              ],
            };
          });
        msgs.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(out),
        });
      } else {
        if (dataGroupIdx === null) {
          dataGroupIdx = pushAndGetIndex(sessionId, {
            kind: "tool_group",
            title: "Fetching data",
            tools: [],
            collapsed: false,
          });
        }
        try {
          const out = await execTool(tc.name, args);
          const brief = toolBrief(tc.name, out);
          useChatStore
            .getState()
            .updateItem(sessionId, dataGroupIdx, (item) => {
              const g = item as ToolGroupItem;
              return {
                ...g,
                tools: [
                  ...g.tools,
                  { id: tc.id, name: tc.name, args, result: out, brief },
                ],
              };
            });
          msgs.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(out),
          });
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          useChatStore
            .getState()
            .updateItem(sessionId, dataGroupIdx, (item) => {
              const g = item as ToolGroupItem;
              return {
                ...g,
                tools: [
                  ...g.tools,
                  {
                    id: tc.id,
                    name: tc.name,
                    args,
                    brief: `error: ${errMsg}`,
                  },
                ],
              };
            });
          msgs.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ error: errMsg }),
          });
        }
      }
    }
  }

  // Collapse groups
  if (dataGroupIdx !== null) {
    useChatStore.getState().updateItem(sessionId, dataGroupIdx, (item) => ({
      ...(item as ToolGroupItem),
      title: "Fetched data",
      collapsed: true,
    }));
  }
  if (memGroupIdx !== null) {
    useChatStore.getState().updateItem(sessionId, memGroupIdx, (item) => ({
      ...(item as ToolGroupItem),
      title: "Memory updated",
      collapsed: true,
    }));
  }
}

// ── Helper: push item and return its index ──────────────────

function pushAndGetIndex(sessionId: string, item: ChatItem): number {
  const store = useChatStore.getState();
  store.pushItem(sessionId, item);
  const session = useChatStore.getState().sessions.find(
    (s) => s.id === sessionId
  );
  return (session?.items.length ?? 1) - 1;
}
