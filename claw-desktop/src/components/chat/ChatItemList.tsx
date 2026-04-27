import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ThinkingBlock from "./ThinkingBlock";
import ToolGroupBlock from "./ToolGroupBlock";
import NarrationBlock from "./NarrationBlock";
import CoordThinkingBlock from "./CoordThinkingBlock";
import PlanBlock from "./PlanBlock";
import AgentTaskBlock from "./AgentTaskBlock";
import type { ChatItem } from "../../types/workflow";

interface Props {
  items: ChatItem[];
  streaming: boolean;
}

export default function ChatItemList({ items, streaming }: Props) {
  return (
    <>
      {items.map((item, i) => {
        const isLast = i === items.length - 1;

        switch (item.kind) {
          case "user":
            return (
              <div key={i} className="msg-user-wrap">
                <div className="msg-user-bubble">{item.text}</div>
              </div>
            );

          case "thinking":
            return (
              <ThinkingBlock
                key={i}
                item={item}
                isActive={!item.collapsed && streaming}
              />
            );

          case "narration":
            return <NarrationBlock key={i} item={item} />;

          case "coord_thinking":
            return (
              <CoordThinkingBlock
                key={i}
                item={item}
                isActive={!item.collapsed && streaming}
              />
            );

          case "plan":
            return (
              <PlanBlock
                key={i}
                item={item}
                isActive={!item.collapsed && streaming && item.phase !== "done"}
              />
            );

          case "agent_task":
            return <AgentTaskBlock key={i} item={item} />;

          case "tool_group":
            return <ToolGroupBlock key={i} item={item} />;

          case "text": {
            // Don't render empty text items (created by ReAct loop but never filled)
            if (!item.text && !(streaming && isLast)) return null;
            return (
              <div key={i} className="msg-agent-wrap">
                <div className="msg-agent-md">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
                  {streaming && isLast && (
                    <span className="msg-cursor" />
                  )}
                </div>
              </div>
            );
          }

          default:
            return null;
        }
      })}
    </>
  );
}
