import { useState } from "react";
import "./Settings.css";
import {
  saveApiKey as llmSaveApiKey,
  deleteApiKey as llmDeleteApiKey,
  testConnection as llmTestConnection,
  getProviderModels,
  startOAuth as llmStartOAuth,
  refreshOAuthStatus as llmRefreshOAuthStatus,
  oauthDisconnect as llmOAuthDisconnect,
  type TestResult,
} from "../lib/llm";
import {
  useModelStore,
  PROVIDER_IDS,
  PROVIDER_META,
  openAiModelMeta,
  type AuthInfo,
} from "../store/modelStore";

interface Props {
  onClose: () => void;
}

type NavPanel = "general" | "model" | "trading" | "notify";

/* ═══════════════ Settings Component ═══════════════ */
export default function Settings({ onClose: _onClose }: Props) {
  const [panel, setPanel] = useState<NavPanel>("general");

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
        {panel === "model" && <ModelPanel />}
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

/* ══════ Model Panel (reads from Zustand store) ══════ */
function ModelPanel() {
  const auth = useModelStore((s) => s.auth);
  const allModels = useModelStore((s) => s.allModels);
  const enabledModels = useModelStore((s) => s.enabledModels);
  const selectedProvider = useModelStore((s) => s.selectedProvider);
  const setSelectedProvider = useModelStore((s) => s.setSelectedProvider);
  const toggleModel = useModelStore((s) => s.toggleModel);
  const [authTab, setAuthTab] = useState<"oauth" | "apikey">("oauth");

  const pid = selectedProvider;
  const meta = PROVIDER_META[pid];
  const provAuth = auth[pid] ?? { connected: false, method: "none", email: "", maskedKey: "" };
  const models = allModels[pid] ?? [];
  const enabled = enabledModels[pid] ?? [];

  const oauthActive = provAuth.connected && provAuth.method === "oauth";
  const apikeyActive = provAuth.connected && provAuth.method === "api_key";

  return (
    <div>
      <div className="stg-title">模型</div>
      <div className="stg-desc">连接厂商账号或 API Key，开启所需模型后即可在对话框中切换使用。</div>

      <div className="md-wrap">
        {/* Provider List */}
        <div className="md-list">
          {PROVIDER_IDS.map(id => {
            const m = PROVIDER_META[id];
            const a = auth[id];
            return (
              <div
                key={id}
                className={`md-list-item ${id === pid ? "active" : ""}`}
                onClick={() => setSelectedProvider(id)}
              >
                <div className="md-list-logo" style={{ background: m.logoBg, borderColor: a?.connected ? "#1e3028" : "#1e2d40" }}>
                  <img src={m.logo} width="16" height="16" style={{ objectFit: "contain", filter: m.logoFilter || undefined }} alt="" />
                </div>
                <span className="md-list-name">{m.name}</span>
                <span className={`md-status-dot ${a?.connected ? "ok" : "off"}`} />
              </div>
            );
          })}
        </div>

        {/* Provider Detail */}
        <div className="md-detail">
          <div className="md-detail-title">{meta.name}</div>
          <div className="md-detail-status">
            <span className={`md-status-dot ${provAuth.connected ? "ok" : "off"}`} />
            {provAuth.connected
              ? <span className="stg-green">已连接</span>
              : <span className="md-off-text">未连接</span>
            }
          </div>

          {/* Auth Block */}
          <div className="md-section-label">连接方式</div>
          <div className="md-auth-block">
            {meta.supportsOAuth ? (
              <>
                <div className="md-auth-tabs">
                  <div
                    className={`md-auth-tab ${authTab === "oauth" ? "active" : ""}`}
                    onClick={() => setAuthTab("oauth")}
                  >
                    <span className="md-auth-tab-wrap">
                      OAuth 登录
                      {oauthActive && <span className="md-auth-tab-dot" />}
                    </span>
                  </div>
                  <div
                    className={`md-auth-tab ${authTab === "apikey" ? "active" : ""}`}
                    onClick={() => setAuthTab("apikey")}
                  >
                    <span className="md-auth-tab-wrap">
                      API Key
                      {apikeyActive && <span className="md-auth-tab-dot" />}
                    </span>
                  </div>
                </div>
                <div className="md-auth-body">
                  {authTab === "oauth"
                    ? <OAuthContent providerId={pid} auth={provAuth} otherActive={apikeyActive} />
                    : <ApiKeyContent providerId={pid} auth={provAuth} otherActive={oauthActive} />
                  }
                </div>
              </>
            ) : (
              <>
                <div className="md-auth-only-label">仅支持 API Key 连接方式</div>
                <div className="md-auth-body">
                  <ApiKeyContent providerId={pid} auth={provAuth} otherActive={false} />
                </div>
              </>
            )}
          </div>

          {/* Models */}
          <div className="md-section-label" style={{ marginTop: 18 }}>可用模型</div>
          {models.map(m => {
            const isOn = enabled.includes(m.id);
            return (
              <div className="md-model-row" key={m.id}>
                <div className="md-model-name">
                  {m.id}
                  {m.badge && <span className={`stg-badge ${m.badgeClass}`}>{m.badge}</span>}
                  <span className="md-model-ctx">{m.ctx} ctx</span>
                </div>
                <button
                  className={`stg-toggle ${isOn ? "on" : ""}`}
                  disabled={!provAuth.connected}
                  style={!provAuth.connected ? { opacity: 0.4 } : undefined}
                  onClick={() => toggleModel(pid, m.id)}
                />
              </div>
            );
          })}
          {!provAuth.connected && <div className="md-hint">连接成功后方可启用模型</div>}
        </div>
      </div>
    </div>
  );
}

/* ── OAuth Content (Feature 1: user card + Feature 4: mutual exclusion) ── */
function OAuthContent({ providerId, auth, otherActive }: { providerId: string; auth: AuthInfo; otherActive: boolean }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const store = useModelStore.getState;
  const meta = PROVIDER_META[providerId];

  const handleLogin = async () => {
    setLoading(true);
    setError("");
    try {
      if (otherActive) {
        await llmDeleteApiKey(providerId);
      }
      const state = await llmStartOAuth(providerId);
      store().applyAuthState(state);
      if (state.connected) {
        try {
          const names = await getProviderModels(providerId);
          if (names.length > 0) {
            const models = names.map((n) => ({ id: n, ...openAiModelMeta(n) }));
            store().setAllModels(providerId, models);
          }
        } catch { /* keep defaults */ }
      }
    } catch (e: any) {
      setError(typeof e === "string" ? e : e?.message ?? "OAuth 登录失败");
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    setLoading(true);
    try {
      await llmOAuthDisconnect(providerId);
      store().disconnect(providerId);
    } catch { /* ignore */ }
    setLoading(false);
  };

  const handleRefresh = async () => {
    setLoading(true);
    try {
      const state = await llmRefreshOAuthStatus(providerId);
      store().applyAuthState(state);
    } catch { /* ignore */ }
    setLoading(false);
  };

  if (auth.connected && auth.method === "oauth") {
    const initial = (auth.email || "U")[0].toUpperCase();
    return (
      <div className="md-oauth-connected">
        <div className="md-oauth-user">
          <div className="md-oauth-avatar">{initial}</div>
          <div className="md-oauth-info">
            <div className="md-oauth-name">{auth.email || "OpenAI User"}</div>
            <div className="md-oauth-email">Codex 接口</div>
          </div>
          <div className="md-oauth-badge"><span className="md-oauth-badge-dot" />已连接</div>
        </div>
        <div className="md-oauth-actions">
          <button className="md-oauth-action-btn" onClick={handleRefresh} disabled={loading}>
            {loading ? "刷新中…" : "刷新状态"}
          </button>
          <button className="md-oauth-action-btn danger" onClick={handleDisconnect} disabled={loading}>断开连接</button>
        </div>
      </div>
    );
  }

  return (
    <>
      {otherActive && (
        <div className="md-conflict-warn">
          <span className="md-conflict-warn-icon">⚠</span>
          <span>当前已通过 API Key 连接。使用 OAuth 登录后将<strong>自动断开 API Key</strong>，并切换至 Codex 接口。</span>
        </div>
      )}
      <button className="md-oauth-big" onClick={handleLogin} disabled={loading}>
        <img src={meta.logo} style={{ objectFit: "contain", filter: meta.logoFilter || undefined }} alt="" />
        {loading ? "正在登录…" : meta.oauthLabel}
        {!loading && <span className="md-oauth-arr">↗</span>}
      </button>
      {error && <div className="md-note md-error">{error}</div>}
      {!error && <div className="md-note">如果你已登录过 Codex，会自动同步登录态。否则将打开浏览器完成 OpenAI 登录。</div>}
    </>
  );
}

/* ── API Key Content (Feature 4: mutual exclusion) ── */
function ApiKeyContent({ providerId, auth, otherActive }: { providerId: string; auth: AuthInfo; otherActive: boolean }) {
  const [keyInput, setKeyInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [editing, setEditing] = useState(false);
  const store = useModelStore.getState;
  const meta = PROVIDER_META[providerId];

  const handleSave = async () => {
    if (!keyInput.trim()) return;
    setLoading(true);
    setTestResult(null);
    try {
      if (otherActive) {
        await llmOAuthDisconnect(providerId);
      }
      const state = await llmSaveApiKey(providerId, keyInput.trim());
      store().applyAuthState(state);
      setKeyInput("");
      setEditing(false);
      const result = await llmTestConnection(providerId);
      setTestResult(result);
    } catch (e: any) {
      setTestResult({ success: false, message: typeof e === "string" ? e : "保存失败", model: null });
    } finally {
      setLoading(false);
    }
  };

  const handleTest = async () => {
    setLoading(true);
    setTestResult(null);
    try {
      const result = await llmTestConnection(providerId);
      setTestResult(result);
    } catch (e: any) {
      setTestResult({ success: false, message: typeof e === "string" ? e : "测试失败", model: null });
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    setLoading(true);
    setTestResult(null);
    try {
      await llmDeleteApiKey(providerId);
      store().disconnect(providerId);
      setEditing(false);
    } catch { /* ignore */ }
    setLoading(false);
  };

  const apikeyConnected = auth.connected && auth.method === "api_key";

  if (apikeyConnected && !editing) {
    return (
      <>
        <div className="md-conn-info">
          <span className="md-status-dot ok" />
          <span className="md-ci-key">{auth.maskedKey}</span>
          <span className="md-ci-badge">有效</span>
        </div>
        <div className="md-conn-actions">
          <button className="stg-btn sm" onClick={() => setEditing(true)}>修改 Key</button>
          <button className="stg-btn sm" onClick={handleTest} disabled={loading}>
            {loading ? "测试中…" : "测试连接"}
          </button>
          <button className="stg-btn sm danger" onClick={handleDelete} disabled={loading}>断开</button>
        </div>
        {testResult && (
          <div className={`md-note ${testResult.success ? "" : "md-error"}`}>
            {testResult.message}
            {testResult.model && ` (${testResult.model})`}
          </div>
        )}
      </>
    );
  }
  return (
    <>
      {otherActive && (
        <div className="md-conflict-warn">
          <span className="md-conflict-warn-icon">⚠</span>
          <span>当前已通过 OAuth 登录。连接 API Key 后将<strong>自动退出 OAuth 登录</strong>，并切换至标准接口。</span>
        </div>
      )}
      <div className="md-key-row">
        <input
          className="stg-input"
          type="password"
          placeholder={meta.placeholder}
          value={keyInput}
          onChange={e => setKeyInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") handleSave(); }}
        />
        <button className="stg-btn sm green" onClick={handleSave} disabled={loading || !keyInput.trim()}>
          {loading ? "连接中…" : "连接"}
        </button>
      </div>
      {testResult && (
        <div className={`md-note ${testResult.success ? "" : "md-error"}`}>
          {testResult.message}
          {testResult.model && ` (${testResult.model})`}
        </div>
      )}
      {!testResult && (
        <div className="md-key-hint">
          在 <a href="#" onClick={e => e.preventDefault()}>{meta.hint}</a> 获取 API Key
        </div>
      )}
      {editing && (
        <button className="stg-btn sm" style={{ marginTop: 6 }} onClick={() => setEditing(false)}>取消修改</button>
      )}
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
          icon={
            <svg width="22" height="22" viewBox="0 0 24 24" fill="#26A5E4">
              <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
            </svg>
          } />
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
          icon={
            <svg width="22" height="22" viewBox="0 0 24 24" fill="#4A154B">
              <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/>
            </svg>
          }>
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

