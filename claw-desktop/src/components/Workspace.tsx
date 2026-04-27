import { useFeatureStore } from "../store/featureStore";
import FeatureDetail from "./FeatureDetail";
import "./Workspace.css";

export default function Workspace() {
  // Active feature tab → render its detail. Otherwise show an empty state
  // pointing the user at the sidebar (Phase 2 will replace this with a
  // real strategies / dashboard view).
  const activeTabSlug = useFeatureStore((s) => s.activeTabSlug);

  if (activeTabSlug) {
    return (
      <main className="workspace">
        <FeatureDetail slug={activeTabSlug} />
      </main>
    );
  }

  return (
    <main className="workspace">
      <div className="ws-empty">
        <div className="ws-empty-mark">ThunderClaw</div>
      </div>
    </main>
  );
}
