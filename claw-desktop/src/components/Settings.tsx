import { useState, useCallback } from "react";
import "./Settings.css";

interface Props {
  onClose: () => void;
}

/* ── 数据类型 ── */
interface ProviderModel {
  name: string;
  badge: string;
  badgeClass: string;
  ctx: string;
  on: boolean;
}

interface Provider {
  id: string;
  name: string;
  connected: boolean;
  activeMethod: "oauth" | "apikey";
  lastPing: string;
  supportsOAuth: boolean;
  oauthLabel: string;
  oauthConnected: boolean;
  oauthEmail: string;
  oauthVerify: string;
  key: string;
  placeholder: string;
  hint: string;
  logo: string;
  logoBg: string;
  logoFilter: string;
  models: ProviderModel[];
}

type NavPanel = "general" | "model" | "trading" | "notify";

const INIT_PROVIDERS: Provider[] = [
  {
    id: "anthropic", name: "Anthropic",
    connected: true, activeMethod: "oauth", lastPing: "12s",
    supportsOAuth: true, oauthLabel: "Anthropic 账号",
    oauthConnected: true, oauthEmail: "aragorn@example.com", oauthVerify: "12s",
    key: "sk-ant-api03-xxxx", placeholder: "sk-ant-api03-…", hint: "console.anthropic.com",
    logo: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/anthropic.svg",
    logoBg: "#cc785c", logoFilter: "brightness(10)",
    models: [
      { name: "Claude 4 Sonnet", badge: "推荐", badgeClass: "badge-green", ctx: "200K", on: true },
      { name: "Claude 3.5 Sonnet", badge: "", badgeClass: "", ctx: "200K", on: true },
      { name: "Claude 3.5 Haiku", badge: "快速", badgeClass: "badge-blue", ctx: "200K", on: false },
      { name: "Claude 3 Opus", badge: "", badgeClass: "", ctx: "200K", on: false },
    ],
  },
  {
    id: "openai", name: "OpenAI",
    connected: true, activeMethod: "oauth", lastPing: "8s",
    supportsOAuth: true, oauthLabel: "OpenAI 账号",
    oauthConnected: true, oauthEmail: "aragorn@example.com", oauthVerify: "8s",
    key: "sk-proj-xxxx", placeholder: "sk-proj-…", hint: "platform.openai.com",
    logo: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/openai.svg",
    logoBg: "#fff", logoFilter: "",
    models: [
      { name: "GPT-4o", badge: "", badgeClass: "", ctx: "128K", on: true },
      { name: "GPT-4o mini", badge: "快速", badgeClass: "badge-blue", ctx: "128K", on: false },
      { name: "o1", badge: "推理", badgeClass: "badge-gold", ctx: "128K", on: false },
      { name: "o3-mini", badge: "推理", badgeClass: "badge-gold", ctx: "128K", on: false },
    ],
  },
  {
    id: "deepseek", name: "DeepSeek",
    connected: false, activeMethod: "apikey", lastPing: "",
    supportsOAuth: false, oauthLabel: "",
    oauthConnected: false, oauthEmail: "", oauthVerify: "",
    key: "", placeholder: "sk-…", hint: "platform.deepseek.com",
    logo: "https://upload.wikimedia.org/wikipedia/commons/e/ec/DeepSeek_logo.svg",
    logoBg: "#fff", logoFilter: "",
    models: [
      { name: "DeepSeek-V3", badge: "低成本", badgeClass: "badge-blue", ctx: "64K", on: false },
      { name: "DeepSeek-R1", badge: "推理", badgeClass: "badge-gold", ctx: "64K", on: false },
    ],
  },
  {
    id: "google", name: "Google Gemini",
    connected: false, activeMethod: "oauth", lastPing: "",
    supportsOAuth: true, oauthLabel: "Google 账号",
    oauthConnected: false, oauthEmail: "", oauthVerify: "",
    key: "", placeholder: "AIza…", hint: "aistudio.google.com",
    logo: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/gemini.svg",
    logoBg: "#fff", logoFilter: "",
    models: [
      { name: "Gemini 2.0 Pro", badge: "", badgeClass: "", ctx: "1M", on: false },
      { name: "Gemini 2.0 Flash", badge: "快速", badgeClass: "badge-blue", ctx: "1M", on: false },
    ],
  },
  {
    id: "xai", name: "xAI Grok",
    connected: false, activeMethod: "apikey", lastPing: "",
    supportsOAuth: false, oauthLabel: "",
    oauthConnected: false, oauthEmail: "", oauthVerify: "",
    key: "", placeholder: "xai-…", hint: "console.x.ai",
    logo: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/grok.svg",
    logoBg: "#fff", logoFilter: "",
    models: [
      { name: "Grok-2", badge: "", badgeClass: "", ctx: "128K", on: false },
    ],
  },
];

/* ═══════════════ Settings Component ═══════════════ */
export default function Settings({ onClose }: Props) {
  const [panel, setPanel] = useState<NavPanel>("general");
  const [providers, setProviders] = useState<Provider[]>(INIT_PROVIDERS);
  const [selectedProvider, setSelectedProvider] = useState("anthropic");

  const switchAuthMethod = useCallback((pid: string, method: "oauth" | "apikey") => {
    setProviders(prev => prev.map(p => p.id === pid ? { ...p, activeMethod: method } : p));
  }, []);

  const toggleModel = useCallback((pid: string, modelName: string) => {
    setProviders(prev => prev.map(p =>
      p.id === pid
        ? { ...p, models: p.models.map(m => m.name === modelName ? { ...m, on: !m.on } : m) }
        : p
    ));
  }, []);

  const dp = providers.find(p => p.id === selectedProvider) ?? providers[0];

  return (
    <div className="stg-overlay">
      {/* Left Nav */}
      <div className="stg-nav">
        <div className="stg-nav-header">
          <span>设置</span>
        </div>

        <div className="stg-nav-group">应用</div>
        <NavItem icon="gear" label="通用" active={panel === "general"} onClick={() => setPanel("general")} />
        <NavItem icon="model" label="模型" active={panel === "model"} onClick={() => setPanel("model")} />

        <div className="stg-nav-divider" />
        <div className="stg-nav-group">交易</div>
        <NavItem icon="chart" label="交易" active={panel === "trading"} onClick={() => setPanel("trading")} />

        <div className="stg-nav-divider" />
        <div className="stg-nav-group">通知</div>
        <NavItem icon="bell" label="通信" active={panel === "notify"} onClick={() => setPanel("notify")} />
      </div>

      {/* Right Content */}
      <div className="stg-content">
        {panel === "general" && <GeneralPanel />}
        {panel === "model" && (
          <ModelPanel
            providers={providers}
            selected={selectedProvider}
            onSelect={setSelectedProvider}
            dp={dp}
            onSwitchAuth={switchAuthMethod}
            onToggleModel={toggleModel}
          />
        )}
        {panel === "trading" && <TradingPanel />}
        {panel === "notify" && <NotifyPanel />}
      </div>
    </div>
  );
}

/* ── Nav Item ── */
function NavItem({ icon, label, active, onClick }: { icon: string; label: string; active: boolean; onClick: () => void }) {
  return (
    <div className={`stg-nav-item ${active ? "active" : ""}`} onClick={onClick}>
      <NavIcon type={icon} />
      {label}
    </div>
  );
}

function NavIcon({ type }: { type: string }) {
  switch (type) {
    case "gear":
      return (
        <svg viewBox="0 0 20 20" fill="none" width="14" height="14">
          <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          <path d="M16.2 10c0-.34-.03-.67-.08-1l1.57-1.23a.4.4 0 0 0 .09-.5l-1.49-2.57a.4.4 0 0 0-.48-.17l-1.85.74a7.4 7.4 0 0 0-1.73-1L12 2.42A.4.4 0 0 0 11.6 2H8.4a.4.4 0 0 0-.4.42l-.23 1.85a7.4 7.4 0 0 0-1.73 1l-1.85-.74a.4.4 0 0 0-.48.17L2.22 7.27a.39.39 0 0 0 .09.5L3.88 9c-.05.33-.08.66-.08 1s.03.67.08 1l-1.57 1.23a.4.4 0 0 0-.09.5l1.49 2.57c.1.18.31.25.48.17l1.85-.74c.53.39 1.11.72 1.73 1l.23 1.85c.04.23.24.42.4.42h3.2c.18 0 .36-.19.4-.42l.23-1.85a7.4 7.4 0 0 0 1.73-1l1.85.74c.18.08.38 0 .48-.17l1.49-2.57a.39.39 0 0 0-.09-.5L16.12 11c.05-.33.08-.66.08-1Z" stroke="currentColor" strokeWidth="1.3"/>
        </svg>
      );
    case "model":
      return (
        <svg viewBox="0 0 16 16" fill="none" width="14" height="14">
          <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
          <path d="M5.5 7h5M5.5 9.5h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
        </svg>
      );
    case "chart":
      return (
        <svg viewBox="0 0 16 16" fill="none" width="14" height="14">
          <polyline points="2,12 5,7 8,9 11,4 14,6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          <line x1="2" y1="14" x2="14" y2="14" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
        </svg>
      );
    case "bell":
      return (
        <svg viewBox="0 0 16 16" fill="none" width="14" height="14">
          <path d="M8 2a5 5 0 0 0-5 5v2.5l-1 1.5h12l-1-1.5V7a5 5 0 0 0-5-5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
          <path d="M6.5 12.5a1.5 1.5 0 0 0 3 0" stroke="currentColor" strokeWidth="1.2"/>
        </svg>
      );
    default:
      return null;
  }
}

/* ══════ General Panel ══════ */
function GeneralPanel() {
  return (
    <div>
      <div className="stg-title">通用</div>
      <div className="stg-group-label">界面</div>
      <div className="stg-card">
        <SettingsRow title="启动时显示左侧栏" desc="默认打开策略/特征侧边栏" toggle defaultOn />
        <SettingsRow title="启动时显示交易栏" desc="默认打开底部实盘交易工作台" toggle />
        <SettingsRow title="界面语言">
          <select className="stg-select"><option>简体中文</option><option>English</option></select>
        </SettingsRow>
      </div>

      <div className="stg-group-label">通知</div>
      <div className="stg-card">
        <SettingsRow title="交易信号系统通知" desc="Agent 产生买卖信号时弹出系统通知" toggle defaultOn />
        <SettingsRow title="任务完成通知" desc="特征/策略生成任务完成后提醒" toggle defaultOn />
      </div>

      <div className="stg-group-label">账户</div>
      <div className="stg-card">
        <SettingsRow title="账户管理" desc="查看订阅状态与使用量">
          <button className="stg-btn">打开</button>
        </SettingsRow>
      </div>
    </div>
  );
}

/* ══════ Model Panel ══════ */
interface ModelPanelProps {
  providers: Provider[];
  selected: string;
  onSelect: (id: string) => void;
  dp: Provider;
  onSwitchAuth: (pid: string, method: "oauth" | "apikey") => void;
  onToggleModel: (pid: string, modelName: string) => void;
}

function ModelPanel({ providers, selected, onSelect, dp, onSwitchAuth, onToggleModel }: ModelPanelProps) {
  const oauthActive = dp.activeMethod === "oauth";

  return (
    <div>
      <div className="stg-title">模型</div>
      <div className="stg-desc">连接厂商账号或 API Key，开启所需模型后即可在对话框中切换使用。</div>

      <div className="md-wrap">
        {/* Provider List */}
        <div className="md-list">
          {providers.map(p => (
            <div
              key={p.id}
              className={`md-list-item ${p.id === selected ? "active" : ""}`}
              onClick={() => onSelect(p.id)}
            >
              <div className="md-list-logo" style={{ background: p.logoBg, borderColor: p.connected ? "#1e3028" : "#1e2d40" }}>
                <img src={p.logo} width="16" height="16" style={{ objectFit: "contain", filter: p.logoFilter || undefined }} alt="" />
              </div>
              <span className="md-list-name">{p.name}</span>
              <span className={`md-status-dot ${p.connected ? "ok" : "off"}`} />
            </div>
          ))}
        </div>

        {/* Provider Detail */}
        <div className="md-detail">
          <div className="md-detail-title">{dp.name}</div>
          <div className="md-detail-status">
            <span className={`md-status-dot ${dp.connected ? "ok" : "off"}`} />
            {dp.connected
              ? <><span className="stg-green">已连接</span><span className="md-ping">· 延迟 {dp.lastPing}</span></>
              : <span className="md-off-text">未连接</span>
            }
          </div>

          {/* Auth Block – 方案 B Tab */}
          <div className="md-section-label">连接方式</div>
          <div className="md-auth-block">
            {dp.supportsOAuth ? (
              <>
                <div className="md-auth-tabs">
                  <div
                    className={`md-auth-tab ${oauthActive ? "active" : ""}`}
                    onClick={() => onSwitchAuth(dp.id, "oauth")}
                  >
                    OAuth 登录
                    {oauthActive
                      ? <span className="md-tab-badge">当前</span>
                      : <span className="md-tab-badge recommend">推荐</span>
                    }
                  </div>
                  <div
                    className={`md-auth-tab ${!oauthActive ? "active" : ""}`}
                    onClick={() => onSwitchAuth(dp.id, "apikey")}
                  >
                    API Key
                    {!oauthActive && dp.connected && <span className="md-tab-badge">当前</span>}
                  </div>
                </div>
                <div className="md-auth-body">
                  {oauthActive ? <OAuthContent dp={dp} /> : <ApiKeyContent dp={dp} isActive={!oauthActive} />}
                </div>
              </>
            ) : (
              <>
                <div className="md-auth-only-label">仅支持 API Key 连接方式</div>
                <div className="md-auth-body">
                  <ApiKeyContent dp={dp} isActive />
                </div>
              </>
            )}
          </div>

          {/* Models */}
          <div className="md-section-label" style={{ marginTop: 18 }}>可用模型</div>
          {dp.models.map(m => (
            <div className="md-model-row" key={m.name}>
              <div className="md-model-name">
                {m.name}
                {m.badge && <span className={`stg-badge ${m.badgeClass}`}>{m.badge}</span>}
                <span className="md-model-ctx">{m.ctx} ctx</span>
              </div>
              <button
                className={`stg-toggle ${m.on ? "on" : ""}`}
                disabled={!dp.connected}
                style={!dp.connected ? { opacity: 0.4 } : undefined}
                onClick={() => onToggleModel(dp.id, m.name)}
              />
            </div>
          ))}
          {!dp.connected && <div className="md-hint">连接成功后方可启用模型</div>}
        </div>
      </div>

      <div className="stg-group-label" style={{ marginTop: 20 }}>默认模型</div>
      <div className="stg-card">
        <SettingsRow title="新建对话默认使用" desc="每次开启新 Agent 对话时默认选中的模型">
          <select className="stg-select">
            <option>Claude 4 Sonnet</option>
            <option>GPT-4o</option>
          </select>
        </SettingsRow>
      </div>
    </div>
  );
}

/* ── OAuth Content ── */
function OAuthContent({ dp }: { dp: Provider }) {
  if (dp.oauthConnected) {
    return (
      <>
        <div className="md-conn-info">
          <span className="md-status-dot ok" />
          <span className="md-ci-email">{dp.oauthEmail}</span>
          <span className="md-ci-badge">已授权</span>
          <span className="md-ci-time">上次验证 {dp.oauthVerify} 前</span>
        </div>
        <div className="md-conn-actions">
          <button className="stg-btn sm">重新授权</button>
          <button className="stg-btn sm">刷新状态</button>
          <button className="stg-btn sm danger">断开授权</button>
        </div>
        <div className="md-note">当前通过 OAuth 主账号连接，令牌自动续期。若需切换到 API Key，可在右侧 Tab 中选择。</div>
      </>
    );
  }
  return (
    <>
      <button className="md-oauth-big">
        <img src={dp.logo} style={{ objectFit: "contain", filter: dp.logoFilter || undefined }} alt="" />
        {dp.oauthLabel} 登录授权
        <span className="md-oauth-arr">↗</span>
      </button>
      <div className="md-note">点击后将在浏览器中打开授权页，授权完成后自动返回。令牌自动续期，可随时撤销。</div>
    </>
  );
}

/* ── API Key Content ── */
function ApiKeyContent({ dp, isActive }: { dp: Provider; isActive: boolean }) {
  if (dp.connected && isActive) {
    return (
      <>
        <div className="md-conn-info">
          <span className="md-status-dot ok" />
          <span className="md-ci-key">sk-ant-api03-••••••••xxxx</span>
          <span className="md-ci-badge">有效</span>
          <span className="md-ci-time">上次测试 {dp.lastPing} 前</span>
        </div>
        <div className="md-conn-actions">
          <button className="stg-btn sm">修改 Key</button>
          <button className="stg-btn sm">测试连接</button>
          <button className="stg-btn sm danger">断开</button>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="md-key-row">
        <input className="stg-input" type="password" placeholder={dp.placeholder} />
        <button className="stg-btn sm green">连接</button>
        <button className="stg-btn sm">测试</button>
      </div>
      <div className="md-key-hint">
        在 <a href="#" onClick={e => e.preventDefault()}>{dp.hint}</a> 获取 API Key
      </div>
    </>
  );
}

/* ══════ Trading Panel ══════ */
function TradingPanel() {
  return (
    <div>
      <div className="stg-title">交易</div>

      <div className="stg-group-label">交易所连接</div>
      <div className="stg-card">
        <SettingsRow title="Binance" desc="未连接 — 点击配置 API Key">
          <button className="stg-btn">配置</button>
        </SettingsRow>
        <SettingsRow title="Bitget" desc="已连接 · 只读模式" descGreen>
          <button className="stg-btn green">已连接</button>
        </SettingsRow>
        <SettingsRow title="OKX" desc="未连接 — 点击配置 API Key">
          <button className="stg-btn">配置</button>
        </SettingsRow>
      </div>

      <div className="stg-group-label">风控</div>
      <div className="stg-card">
        <SettingsRow title="单笔最大仓位" desc="每笔交易最多使用总资金比例">
          <select className="stg-select"><option>5%</option><option>10%</option><option>20%</option></select>
        </SettingsRow>
        <SettingsRow title="最大回撤止损" desc="达到阈值自动暂停所有策略">
          <select className="stg-select"><option>10%</option><option>15%</option><option>20%</option></select>
        </SettingsRow>
        <SettingsRow title="实盘下单二次确认" desc="每笔实盘下单前需手动确认" toggle defaultOn />
      </div>

      <div className="stg-group-label">回测默认参数</div>
      <div className="stg-card">
        <SettingsRow title="默认回测周期">
          <select className="stg-select"><option>近 3 个月</option><option>近 6 个月</option><option>近 1 年</option></select>
        </SettingsRow>
        <SettingsRow title="手续费率" desc="回测时使用的默认手续费">
          <select className="stg-select"><option>0.05%</option><option>0.1%</option><option>0.2%</option></select>
        </SettingsRow>
      </div>
    </div>
  );
}

/* ══════ Notify Panel ══════ */
function NotifyPanel() {
  return (
    <div>
      <div className="stg-title">通信</div>
      <div className="stg-desc">连接消息机器人，实时接收交易信号、Agent 任务状态和风控预警推送。</div>

      <div className="stg-group-label">连接平台</div>
      <div className="stg-channels">
        <ChannelCard name="Telegram Bot" desc="通过 Bot Token 接收推送，支持命令交互" status="connected" colorClass="tg"
          icon={<img src="https://cdn.simpleicons.org/telegram" width="22" height="22" alt="" style={{ objectFit: "contain" }} />} />
        <ChannelCard name="飞书" desc="通过飞书机器人 Webhook 推送消息" colorClass="feishu"
          icon={
            <svg width="22" height="22" viewBox="7 7 26 26" fill="none">
              <path d="M21.069 20.504l.063-.06.125-.122.085-.084.256-.254.348-.344.299-.296.281-.278.293-.289.269-.266.374-.37.218-.206.419-.359.404-.306.598-.386.617-.33.606-.265.348-.127.177-.058a14.78 14.78 0 0 0-2.793-5.603c-.252-.318-.639-.502-1.047-.502H12.221c-.196 0-.277.249-.119.364a31.49 31.49 0 0 1 8.943 10.162c.008-.007.016-.015.025-.023z" fill="#00d6b9"/>
              <path d="M16.791 30c5.57 0 10.423-3.074 12.955-7.618.089-.159.175-.321.258-.484a6.12 6.12 0 0 1-.425.699c-.055.078-.111.155-.17.23a6.29 6.29 0 0 1-.225.274c-.062.07-.123.138-.188.206a5.61 5.61 0 0 1-.407.384 5.53 5.53 0 0 1-.24.195 7.12 7.12 0 0 1-.292.21c-.063.043-.126.084-.191.122s-.134.081-.204.119c-.14.078-.282.149-.428.215a5.53 5.53 0 0 1-.385.157 5.81 5.81 0 0 1-.43.138 5.91 5.91 0 0 1-.661.143c-.162.025-.325.044-.491.055-.173.012-.348.016-.525.014-.193-.003-.388-.015-.585-.037-.144-.015-.289-.037-.433-.062-.126-.022-.252-.049-.38-.079l-.2-.051-.555-.155-.275-.081-.41-.125-.334-.107-.317-.104-.215-.073-.26-.091-.186-.066-.367-.134-.212-.081-.284-.11-.299-.119-.193-.079-.24-.1-.185-.078-.192-.084-.166-.073-.152-.067-.153-.07-.159-.073-.2-.093-.208-.099-.222-.108-.189-.093c-3.335-1.668-6.295-3.89-8.822-6.583-.126-.134-.349-.045-.349.138l.005 9.52v.773c0 .448.222.87.595 1.118C10.946 29.092 13.762 30 16.791 30z" fill="#3370ff"/>
              <path d="M33.151 16.582c-1.129-.556-2.399-.869-3.744-.869a8.45 8.45 0 0 0-2.303.317l-.252.075-.177.058-.348.127-.606.265-.617.33-.598.386-.404.306-.419.359-.218.206-.374.37-.269.266-.293.289-.281.278-.299.296-.348.344-.256.254-.085.084-.125.122-.063.06-.095.09-.105.099c-.924.848-1.956 1.581-3.072 2.175l.2.093.159.073.153.07.152.067.166.073.192.084.185.078.24.1.193.079.299.119.284.11.212.081.367.134.186.066.26.09.215.073.317.104.334.107.41.125.275.081.555.155.2.051.379.079.433.062.585.037.525-.014.491-.055a5.61 5.61 0 0 0 .66-.143l.43-.138.385-.158.427-.215.204-.119.191-.122.292-.21.24-.195.407-.384.188-.206.225-.274.17-.23a6.13 6.13 0 0 0 .421-.693l.144-.288 1.305-2.599-.003.006a8.07 8.07 0 0 1 1.697-2.439z" fill="#133c9a"/>
            </svg>
          }>
          <button className="stg-btn">配置</button>
        </ChannelCard>
        <ChannelCard name="Slack" desc="推送至指定 Slack 频道或私信" colorClass="slack"
          icon={<img src="https://cdn.simpleicons.org/slack" width="22" height="22" alt="" style={{ objectFit: "contain" }} />}>
          <button className="stg-btn">配置</button>
        </ChannelCard>
        <ChannelCard name="钉钉" desc="通过钉钉机器人 Webhook 推送" colorClass="dingtalk"
          icon={
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0z" fill="#3296FA"/>
              <path d="M17.94 12.768s-1.26-.36-2.16-.6c-.36-.12-.78-.24-1.14-.36.66-.36 2.22-1.38 2.46-2.22.3-1.08-.54-1.38-.54-1.38S14.5 10.5 12.98 11.35c-.72.42-1.32.66-1.74.78.06-.3.06-.6 0-.9-.18-1.02-.96-1.86-1.86-1.98-.66-.06-1.26.18-1.68.66-.36.42-.48.96-.42 1.5.06.36.18.72.42 1.02-.36.06-.66.12-.78.18-.84.36-.48 1.08-.48 1.08s1.44-.18 3.12.12c.3.06.54.12.78.18-.12.12-.3.3-.54.54-1.38 1.38-3.9 2.1-3.9 2.1s2.7 1.2 4.86.12c.12-.06.24-.12.36-.24l-.06.18c-.3.96-.96 1.56-.96 1.56s1.44-.12 2.34-1.08c.42-.42.66-.84.84-1.26.48.06 1.08.06 1.86-.06 1.68-.3 2.54-.78 2.54-.78z" fill="#fff"/>
            </svg>
          }>
          <button className="stg-btn">配置</button>
        </ChannelCard>
      </div>

      <div className="stg-group-label">Telegram 配置</div>
      <div className="stg-card">
        <SettingsRow title="Bot Token" desc="在 @BotFather 处创建 Bot 获取">
          <input className="stg-input" type="password" defaultValue="7823401234:AAHxxx…" placeholder="粘贴 Bot Token" />
        </SettingsRow>
        <SettingsRow title="Chat ID" desc="接收消息的用户或群组 ID">
          <input className="stg-input" defaultValue="@my_trading_group" placeholder="Chat ID 或 @username" />
        </SettingsRow>
        <SettingsRow title="连接状态" desc="已连接 · 最近推送 2 分钟前" descGreen>
          <div className="stg-btn-group">
            <button className="stg-btn">发送测试</button>
            <button className="stg-btn danger">断开</button>
          </div>
        </SettingsRow>
      </div>

      <div className="stg-group-label">推送触发条件</div>
      <div className="stg-card">
        <TriggerRow icon="↑" color="var(--accent)" name="买入信号" desc="Agent 发出 BUY 信号时推送" defaultOn />
        <TriggerRow icon="↓" color="var(--red)" name="卖出信号" desc="Agent 发出 SELL 信号时推送" defaultOn />
        <TriggerRow icon="!" color="var(--red)" name="风控预警" desc="回撤超阈值或强制平仓时立即推送" defaultOn />
        <TriggerRow icon="✓" color="var(--accent-gold)" name="任务完成" desc="特征/策略生成任务完成时推送" />
        <TriggerRow icon="i" color="#5b8def" name="每日收益报告" desc="每天 20:00 推送当日盈亏汇总" defaultOn />
      </div>
    </div>
  );
}

/* ── Shared: SettingsRow ── */
interface SettingsRowProps {
  title: string;
  desc?: string;
  descGreen?: boolean;
  toggle?: boolean;
  defaultOn?: boolean;
  children?: React.ReactNode;
}

function SettingsRow({ title, desc, descGreen, toggle, defaultOn, children }: SettingsRowProps) {
  const [on, setOn] = useState(!!defaultOn);
  return (
    <div className="stg-row">
      <div className="stg-row-info">
        <div className="stg-row-title">{title}</div>
        {desc && <div className={`stg-row-desc ${descGreen ? "green" : ""}`}>{desc}</div>}
      </div>
      {toggle
        ? <button className={`stg-toggle ${on ? "on" : ""}`} onClick={() => setOn(v => !v)} />
        : children
      }
    </div>
  );
}

/* ── Shared: ChannelCard ── */
function ChannelCard({ name, desc, status, colorClass, icon, children }: {
  name: string; desc: string; status?: string; colorClass: string; icon: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <div className="stg-channel-card">
      <div className={`stg-channel-icon ${colorClass}`}>{icon}</div>
      <div className="stg-channel-info">
        <div className="stg-channel-name">{name}</div>
        <div className="stg-channel-desc">{desc}</div>
      </div>
      {status === "connected"
        ? <span className="stg-channel-status connected">已连接</span>
        : children
      }
    </div>
  );
}

/* ── Shared: TriggerRow ── */
function TriggerRow({ icon, color, name, desc, defaultOn }: {
  icon: string; color: string; name: string; desc: string; defaultOn?: boolean;
}) {
  const [on, setOn] = useState(!!defaultOn);
  return (
    <div className="stg-row">
      <div className="stg-trigger-icon" style={{ background: `${color}18`, color }}>{icon}</div>
      <div className="stg-row-info">
        <div className="stg-row-title">{name}</div>
        <div className="stg-row-desc">{desc}</div>
      </div>
      <button className={`stg-toggle ${on ? "on" : ""}`} onClick={() => setOn(v => !v)} />
    </div>
  );
}

