import "./TitleBar.css";

interface Props {
  showSidebar: boolean;
  showTrading: boolean;
  onToggleSidebar: () => void;
  onToggleTrading: () => void;
}

export default function TitleBar({ showSidebar, showTrading, onToggleSidebar, onToggleTrading }: Props) {
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
        <span className="tb-icon tb-icon-gear">⚙</span>
      </div>
    </div>
  );
}
