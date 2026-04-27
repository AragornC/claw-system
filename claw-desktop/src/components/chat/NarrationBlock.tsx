import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { NarrationItem } from "../../types/workflow";

interface Props {
  item: NarrationItem;
}

// Prose bridge between action blocks — mirrors Claude Code's narration.
// Inline `code-spans` render as .m style pills (see AgentPanel.css).
export default function NarrationBlock({ item }: Props) {
  return (
    <div className="narration">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
    </div>
  );
}
