import "./TitleBar.css";

export default function TitleBar() {
  return (
    <div className="titlebar" data-tauri-drag-region>
      {/* 左侧留白：原生红黄绿按钮由 macOS 在 overlay 模式下自动渲染 */}
      <div className="titlebar-traffic-spacer" />
      <span className="titlebar-appname" data-tauri-drag-region>ThunderClaw</span>
      <div className="titlebar-right">
        <span className="tb-icon">⚙</span>
      </div>
    </div>
  );
}
