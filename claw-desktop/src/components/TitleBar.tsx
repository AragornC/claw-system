import "./TitleBar.css";

interface Props {
  showSidebar: boolean;
  showTrading: boolean;
  onToggleSidebar: () => void;
  onToggleTrading: () => void;
  onOpenSettings: () => void;
}

export default function TitleBar({ showSidebar, showTrading, onToggleSidebar, onToggleTrading, onOpenSettings }: Props) {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-traffic-spacer" />
      <span className="titlebar-appname">ThunderClaw</span>
      <div className="titlebar-right">
        {/* 左侧栏开关 */}
        <button
          className={`tb-panel-btn ${showSidebar ? "tb-panel-btn-active" : ""}`}
          title="切换左侧栏"
          onClick={onToggleSidebar}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
            <line x1="5.5" y1="2.5" x2="5.5" y2="13.5" stroke="currentColor" strokeWidth="1.2"/>
            {showSidebar && <rect x="2" y="3" width="3.5" height="10" rx="1" fill="currentColor" fillOpacity="0.55"/>}
          </svg>
        </button>
        {/* 底部栏开关 */}
        <button
          className={`tb-panel-btn ${showTrading ? "tb-panel-btn-active" : ""}`}
          title="切换交易栏"
          onClick={onToggleTrading}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
            <line x1="1.5" y1="10.5" x2="14.5" y2="10.5" stroke="currentColor" strokeWidth="1.2"/>
            {showTrading && <rect x="2" y="10.8" width="12" height="2.7" rx="1" fill="currentColor" fillOpacity="0.55"/>}
          </svg>
        </button>
        <span className="tb-divider" />
        <button className="tb-panel-btn" title="设置" onClick={onOpenSettings}>
          <svg width="17" height="17" viewBox="0 0 20 20" fill="none">
            <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            <path d="M16.2 10c0-.34-.03-.67-.08-1l1.57-1.23a.4.4 0 0 0 .09-.5l-1.49-2.57a.4.4 0 0 0-.48-.17l-1.85.74a7.4 7.4 0 0 0-1.73-1L12 2.42A.4.4 0 0 0 11.6 2H8.4a.4.4 0 0 0-.4.42l-.23 1.85a7.4 7.4 0 0 0-1.73 1l-1.85-.74a.4.4 0 0 0-.48.17L2.22 7.27a.39.39 0 0 0 .09.5L3.88 9c-.05.33-.08.66-.08 1s.03.67.08 1l-1.57 1.23a.4.4 0 0 0-.09.5l1.49 2.57c.1.18.31.25.48.17l1.85-.74c.53.39 1.11.72 1.73 1l.23 1.85c.04.23.24.42.4.42h3.2c.18 0 .36-.19.4-.42l.23-1.85a7.4 7.4 0 0 0 1.73-1l1.85.74c.18.08.38 0 .48-.17l1.49-2.57a.39.39 0 0 0-.09-.5L16.12 11c.05-.33.08-.66.08-1Z" stroke="currentColor" strokeWidth="1.4"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
