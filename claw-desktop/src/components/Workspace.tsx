import "./Workspace.css";

const STEPS = [
  { label: "理解需求", status: "done",    detail: "检测到用户意图：基于移动平均线死叉信号识别下跌风险" },
  { label: "生成计划", status: "done",    detail: "目标：构建 MA死叉风控特征；输入：close price；验证：历史回测胜率 > 60%" },
  { label: "规格锁定", status: "done",    detail: "特征名：dead_cross_risk_avoidance · 输出类型：0/1 · 回看窗口：20/60" },
  { label: "代码生成", status: "done",    detail: "已生成 Python 特征代码（47 行）" },
  { label: "特征验证", status: "running", detail: "第 2 轮 · 运行中… 数据行 334 · 均值 0.0076" },
  { label: "最终结果", status: "pending", detail: "" },
];

export default function Workspace() {
  return (
    <main className="workspace">
      {/* 工作台内容 */}
      <div className="ws-content">
        {/* 任务标题 */}
        <div className="ws-task-head">
          <div className="ws-task-title">
            <span className="ws-task-badge">特征生成</span>
            均线死叉风控特征
          </div>
          <div className="ws-task-meta">dead_cross_risk_avoidance · 风控类</div>
        </div>

        {/* 流程步骤 */}
        <div className="ws-steps">
          {STEPS.map((step, i) => (
            <div key={i} className={`ws-step ws-step-${step.status}`}>
              <div className="ws-step-line">
                <span className="ws-step-dot" />
                {i < STEPS.length - 1 && <span className="ws-step-connector" />}
              </div>
              <div className="ws-step-body">
                <div className="ws-step-head">
                  <span className="ws-step-label">{step.label}</span>
                  <span className={`ws-step-badge ws-badge-${step.status}`}>
                    {step.status === "done" ? "已完成" : step.status === "running" ? "进行中" : "待执行"}
                  </span>
                </div>
                {step.detail && <div className="ws-step-detail">{step.detail}</div>}
                {step.status === "running" && (
                  <div className="ws-progress-bar">
                    <div className="ws-progress-fill" style={{ width: "62%" }} />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
