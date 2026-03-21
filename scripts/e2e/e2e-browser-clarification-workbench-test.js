#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const PORT = Number(process.env.THUNDERCLAW_E2E_BROWSER_PORT || (15000 + Math.floor(Math.random() * 2000)));
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || "sk-4f09f8d07cf24711b398274ee11a13f9";
const ARTIFACT_DIR = path.join(ROOT_DIR, "memory", "e2e-artifacts");
const TEST_PROMPT = "帮我做一个判断市场波动率高低的工具";

function log(tag, msg) {
  console.log(`[${tag}] ${msg}`);
}

async function waitForServer(maxMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const resp = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(3000) });
      if (resp.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function postJson(urlPath, body = {}, timeoutMs = 30000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(`${BASE}${urlPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

function pickStableOption(questionLike) {
  const options = Array.isArray(questionLike?.options) ? questionLike.options : [];
  if (!options.length) return null;
  const preferred = options.find((option) => {
    const value = String(option?.value || "").trim().toLowerCase();
    return value && !["custom", "custom_percentile"].includes(value);
  });
  return preferred || options[0] || null;
}

async function postStream(urlPath, body = {}, timeoutMs = 300000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(`${BASE}${urlPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    const events = [];
    let finalPayload = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("event: ")) {
          currentEvent = trimmed.slice(7);
        } else if (trimmed.startsWith("data: ")) {
          const payload = JSON.parse(trimmed.slice(6));
          events.push({ event: currentEvent || "message", data: payload });
          if ((currentEvent || "message") === "thinking") {
            const task = payload?.task && typeof payload.task === "object" ? payload.task : null;
            const traces = task && Array.isArray(task.traces) ? task.traces : [];
            const latestTrace = traces.length ? traces[traces.length - 1] : null;
            const taskId = String(payload?.taskId || task?.taskId || "").trim();
            const moduleId = String(payload?.moduleId || latestTrace?.moduleId || "").trim();
            const seq = Number(payload?.seq || latestTrace?.seq || 0);
            if (taskId && moduleId && Number.isFinite(seq) && seq > 0) {
              await postJson("/api/strategy/task-ack", { taskId, moduleId, seq }, 30000);
            }
          }
          if (currentEvent === "result" || currentEvent === "done") {
            finalPayload = payload;
          }
          currentEvent = "";
        }
      }
    }
    return { events, finalPayload };
  } finally {
    clearTimeout(timer);
  }
}

async function openApp(page) {
  const candidates = [
    `${BASE}/`,
    `${BASE}/memory/report/index.html`,
  ];
  for (const url of candidates) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    const hasInput = await page.locator("#ai-chat-input").count();
    if (hasInput) return url;
  }
  throw new Error("未找到聊天主页面");
}

async function clickFirstOptionPerQuestion(card) {
  const groups = card.locator(".ai-clarify-chips");
  const count = await groups.count();
  for (let i = 0; i < count; i += 1) {
    const selected = groups.nth(i).locator(".ai-clarify-chip.selected");
    if (await selected.count()) continue;
    const chip = groups.nth(i).locator(".ai-clarify-chip:not([disabled])").first();
    if (await chip.count()) {
      await chip.click({ timeout: 15000 });
    }
  }
}

async function collectStepTexts(page) {
  return await page.locator(".ai-thinking-step .step-text").evaluateAll((nodes) =>
    nodes.map((node) => String(node.textContent || "").trim()).filter(Boolean),
  );
}

async function collectPanelStepTexts(tracePanel) {
  return await tracePanel.locator(".ai-workbench-step .step-text").evaluateAll((nodes) =>
    nodes.map((node) => String(node.textContent || "").trim()).filter(Boolean),
  );
}

async function ensureStepToggleContent(page, tracePanel, keyword, expectedPattern) {
  const steps = tracePanel.locator(".ai-workbench-step").filter({ hasText: keyword });
  const count = await steps.count();
  for (let i = 0; i < count; i += 1) {
    const step = steps.nth(i);
    const toggle = step.locator(".ai-workbench-step-toggle");
    const panel = step.locator(".ai-workbench-step-panel");
    const initialExpanded = await toggle.getAttribute("aria-expanded");
    if (initialExpanded !== "false") {
      await toggle.evaluate((node) => node.click());
      await page.waitForTimeout(150);
    }
    await toggle.evaluate((node) => node.click());
    await page.waitForTimeout(200);
    const expanded = await toggle.getAttribute("aria-expanded");
    const openDisplay = await panel.evaluate((node) => window.getComputedStyle(node).display);
    const text = String(await panel.textContent() || "").trim();
    const matched = expanded === "true" && openDisplay !== "none" && expectedPattern.test(text);
    if (initialExpanded === "false") {
      await toggle.evaluate((node) => node.click());
      await page.waitForTimeout(150);
      const closedDisplay = await panel.evaluate((node) => window.getComputedStyle(node).display);
      if (matched && closedDisplay === "none") {
        return true;
      }
      continue;
    }
    if (matched) {
      return true;
    }
  }
  return false;
}

async function ensureTaskToggleWorks(page, tracePanel) {
  const header = tracePanel.locator(".ai-thinking-header").first();
  const body = tracePanel.locator(".ai-thinking-body").first();
  if (!await header.count() || !await body.count()) return false;
  const openedDisplay = await body.evaluate((node) => window.getComputedStyle(node).display);
  if (openedDisplay === "none") {
    await header.click({ timeout: 15000 });
    await page.waitForTimeout(150);
  }
  await header.click({ timeout: 15000 });
  await page.waitForTimeout(180);
  const closedDisplay = await body.evaluate((node) => window.getComputedStyle(node).display);
  if (closedDisplay !== "none") return false;
  await header.click({ timeout: 15000 });
  await page.waitForTimeout(180);
  const reopenedDisplay = await body.evaluate((node) => window.getComputedStyle(node).display);
  return reopenedDisplay !== "none";
}

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  log("SETUP", "Starting ThunderClaw server for browser E2E...");
  const serverProc = spawn("node", ["scripts/thunderclaw-server.js"], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      THUNDERCLAW_PORT: String(PORT),
      DEEPSEEK_API_KEY: API_KEY,
      THUNDERCLAW_EXTERNAL_SIGNAL_LIVE: "0",
      THUNDERCLAW_EXTERNAL_SIGNAL_STRICT: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let serverStderr = "";
  serverProc.stderr.on("data", (chunk) => { serverStderr += String(chunk); });
  serverProc.stdout.on("data", () => {});

  let browser;
  try {
    const ready = await waitForServer(45000);
    if (!ready) {
      throw new Error(`Server not ready: ${serverStderr.slice(-300)}`);
    }
    await postJson("/api/session/archive", {});
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        log("BROWSER", `${msg.type()}: ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => {
      log("PAGEERROR", String(err && err.message ? err.message : err));
    });
    let visitedUrl = await openApp(page);
    await page.evaluate(() => {
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
    });
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    if (!await page.locator("#ai-chat-input").count()) {
      visitedUrl = await openApp(page);
    }
    await page.evaluate(() => {
      try {
        window.__ackCalls = [];
        const orig = window.fetch.bind(window);
        window.fetch = function(...args) {
          try {
            if (String(args[0] || "").includes("/api/strategy/task-ack")) {
              const init = args[1] && typeof args[1] === "object" ? args[1] : {};
              window.__ackCalls.push(JSON.parse(String(init.body || "{}")));
            }
          } catch {}
          return orig(...args);
        };
      } catch {}
    });
    const archiveBtn = page.locator("#session-archive-btn");
    if (await archiveBtn.count()) {
      await archiveBtn.click({ timeout: 15000 });
      await page.waitForTimeout(1200);
    }
    log("PAGE", `Opened ${visitedUrl}`);

    const input = page.locator("#ai-chat-input");
    const sendBtn = page.locator("#ai-chat-send");
    await input.fill(TEST_PROMPT);
    await sendBtn.click();

    const clarificationCard = page.locator(".ai-clarify-row", {
      has: page.locator(".ai-clarify-submit:not([disabled])"),
    }).last();
    await clarificationCard.waitFor({ state: "visible", timeout: 120000 });
    await clarificationCard.locator(".ai-clarify-submit").waitFor({ state: "visible", timeout: 30000 });
    const cardEventId = String(await clarificationCard.getAttribute("data-card-event-id") || "").trim();
    log("STEP", "Clarification card rendered");

    await clickFirstOptionPerQuestion(clarificationCard);
    await clarificationCard.locator(".ai-clarify-submit").click();
    log("STEP", "Clicked 开始生成特征");

    const taskRow = page.locator('.ai-feature-task-row[data-parent-card-event-id="' + cardEventId + '"]').last();
    await taskRow.waitFor({ state: "visible", timeout: 120000 });
    const tracePanel = taskRow.locator(".ai-workbench").last();
    await tracePanel.waitFor({ state: "visible", timeout: 120000 });
    const tracePanelHandle = await tracePanel.elementHandle();
    await page.waitForFunction((panel) => {
      const text = String(panel && panel.textContent || "");
      return /📝 特征生成任务/.test(text) && !/✅ 输出: 连续值/.test(text);
    }, tracePanelHandle, { timeout: 120000 });
    await page.waitForFunction((panel) => {
      const text = String(panel && panel.textContent || "");
      const optionMatches = text.match(/✅/g) || [];
      return optionMatches.length >= 2;
    }, tracePanelHandle, { timeout: 120000 });
    await page.waitForFunction((panel) => {
      return Boolean(panel) && /AI 思考过程|本次任务计划/.test(String(panel.textContent || ""));
    }, tracePanelHandle, { timeout: 240000 });
    const initialStepTexts = await collectPanelStepTexts(tracePanel);
    const expandedWhileRunningCount = await tracePanel.locator('.ai-workbench-step-toggle[aria-expanded="true"]').count();
    const autoFollowInitial = await page.evaluate(() => {
      const box = document.getElementById("ai-chat-box");
      if (!box) return { nearBottom: false, paused: "1" };
      const distance = Math.max(0, box.scrollHeight - box.clientHeight - box.scrollTop);
      return {
        nearBottom: distance <= 128,
        paused: String(box.dataset.autofollowPaused || "0"),
      };
    });
    const ackCountBeforeManualPause = await page.evaluate(() => Array.isArray(window.__ackCalls) ? window.__ackCalls.length : 0);
    await page.evaluate(() => {
      const box = document.getElementById("ai-chat-box");
      if (!box) return;
      box.scrollTop = 0;
      box.dispatchEvent(new Event("scroll"));
    });
    await page.waitForFunction((baseline) => {
      const calls = Array.isArray(window.__ackCalls) ? window.__ackCalls.length : 0;
      const box = document.getElementById("ai-chat-box");
      return calls >= baseline + 2 && Boolean(box) && String(box.dataset.autofollowPaused || "0") === "1";
    }, ackCountBeforeManualPause, { timeout: 240000 });
    const autoFollowPaused = await page.evaluate(() => {
      const box = document.getElementById("ai-chat-box");
      if (!box) return { nearBottom: true, paused: "0" };
      const distance = Math.max(0, box.scrollHeight - box.clientHeight - box.scrollTop);
      return {
        nearBottom: distance <= 128,
        paused: String(box.dataset.autofollowPaused || "0"),
      };
    });
    await page.evaluate(() => {
      const box = document.getElementById("ai-chat-box");
      if (!box) return;
      box.scrollTop = box.scrollHeight;
      box.dispatchEvent(new Event("scroll"));
    });
    await page.waitForFunction(() => {
      const box = document.getElementById("ai-chat-box");
      if (!box) return false;
      const distance = Math.max(0, box.scrollHeight - box.clientHeight - box.scrollTop);
      return String(box.dataset.autofollowPaused || "0") === "0" && distance <= 128;
    }, { timeout: 240000 });
    await page.waitForFunction(() => {
      const calls = Array.isArray(window.__ackCalls) ? window.__ackCalls : [];
      return calls.some((item) => String(item?.moduleId || "").trim() === "summarize.finalize");
    }, undefined, { timeout: 240000 });
    const processHandle = await tracePanel.locator(".ai-workbench-process").elementHandle();
    await page.waitForFunction((panel) => {
      return Boolean(panel) && !panel.classList.contains("collapsed");
    }, processHandle, { timeout: 120000 });
    await page.waitForFunction((panel) => {
      if (!panel) return false;
      return window.getComputedStyle(panel).display !== "none"
        && /特征已生成|特征生成失败|加入特征库/.test(String(panel.textContent || ""));
    }, await tracePanel.locator(".ai-workbench-result").elementHandle(), { timeout: 120000 });

    const partialStepTexts = initialStepTexts.slice();
    const partialPlanIndex = partialStepTexts.findIndex((text) => text.includes("生成计划") || text.includes("特征加工计划"));
    const partialHasProgress = partialStepTexts.length >= 2;
    const partialNoFutureSteps = partialStepTexts.every((text) => !/生成首版代码|第 1 轮运行|第 1 轮检测|最终结果/.test(text));
    const stepCountBeforeReload = await tracePanel.locator(".ai-workbench-step").count();
    const expandedStepCountBeforeReload = await tracePanel.locator('.ai-workbench-step-toggle[aria-expanded="true"]').count();
    const collapsedAfterFinish = await tracePanel.evaluate((node) => node.classList.contains("collapsed"));
    const processCollapsedAfterFinish = await tracePanel.locator(".ai-workbench-process").evaluate((node) => node.classList.contains("collapsed"));
    const resultVisibleAfterFinish = await tracePanel.locator(".ai-workbench-result").evaluate((node) => window.getComputedStyle(node).display !== "none" && /特征已生成|特征生成失败|加入特征库/.test(String(node.textContent || "")));
    const ackRequests = await page.evaluate(() => Array.isArray(window.__ackCalls) ? window.__ackCalls.slice() : []);

    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    if (!await page.locator("#ai-chat-input").count()) {
      await openApp(page);
    }
    const restoredTaskRow = page.locator('.ai-feature-task-row[data-parent-card-event-id="' + cardEventId + '"]').last();
    await restoredTaskRow.waitFor({ state: "visible", timeout: 120000 });
    const restoredTracePanel = restoredTaskRow.locator(".ai-workbench").last();
    const restoredProcessHandle = await restoredTracePanel.locator(".ai-workbench-process").elementHandle();
    await page.waitForFunction((panel) => {
      return Boolean(panel) && !panel.classList.contains("collapsed");
    }, restoredProcessHandle, { timeout: 120000 });
    await page.waitForFunction((panel) => {
      if (!panel) return false;
      return window.getComputedStyle(panel).display !== "none"
        && /特征已生成|特征生成失败|加入特征库/.test(String(panel.textContent || ""));
    }, await restoredTracePanel.locator(".ai-workbench-result").elementHandle(), { timeout: 120000 });
    const restoredTraceText = String(await restoredTracePanel.textContent() || "");
    const restoredStepTexts = await collectPanelStepTexts(restoredTracePanel);
    const restoredCollapsedAfterFinish = await restoredTracePanel.evaluate((node) => node.classList.contains("collapsed"));
    const restoredProcessCollapsed = await restoredTracePanel.locator(".ai-workbench-process").evaluate((node) => node.classList.contains("collapsed"));
    const restoredResultVisible = await restoredTracePanel.locator(".ai-workbench-result").evaluate((node) => window.getComputedStyle(node).display !== "none" && /特征已生成|特征生成失败|加入特征库/.test(String(node.textContent || "")));
    const restoredHasPlan = /生成计划|特征加工计划/.test(restoredTraceText);
    const restoredHasSpec = /锁定 Spec/.test(restoredTraceText);
    const restoredHasWrite = /生成首版代码/.test(restoredTraceText);
    const cardHasEmbeddedWorkbench = await clarificationCard.locator(".ai-workbench").count();
    const taskRowCount = await page.locator('.ai-feature-task-row[data-parent-card-event-id="' + cardEventId + '"]').count();
    const taskInChatFlow = await page.evaluate((eventId) => {
      const card = document.querySelector('.ai-clarify-row[data-card-event-id="' + eventId + '"]');
      const task = document.querySelector('.ai-feature-task-row[data-parent-card-event-id="' + eventId + '"]');
      if (!card || !task) return false;
      let next = card.nextElementSibling;
      while (next) {
        if (next === task) return true;
        if (next.classList.contains("ai-clarify-row")) return false;
        next = next.nextElementSibling;
      }
      return false;
    }, cardEventId);
    const hasAccordion = await restoredTracePanel.locator(".ai-workbench-step-toggle").count();
    const taskToggleWorks = await ensureTaskToggleWorks(page, restoredTracePanel);
    const planStepToggleWorks = await ensureStepToggleContent(page, restoredTracePanel, "计划", /AI 思考过程|本次任务计划|我将怎么做|我会如何验证/);
    const restoredStepRowCount = await restoredTracePanel.locator(".ai-workbench-step").count();
    const expandedStepCount = await restoredTracePanel.locator('.ai-workbench-step-toggle[aria-expanded="true"]').count();
    const ackModules = ackRequests.map((item) => String(item?.moduleId || "").trim()).filter(Boolean);
    const ackSeqs = ackRequests.map((item) => Number(item?.seq || 0)).filter((value) => Number.isFinite(value) && value > 0);
    const ackSeqStrictlyIncreasing = ackSeqs.every((value, index) => index === 0 || value > ackSeqs[index - 1]);
    const ackSeqContiguous = ackSeqs.every((value, index) => value === index + 1);
    const firstCollectIndex = ackModules.indexOf("understand.collectContext");
    const firstLockIndex = ackModules.indexOf("understand.lockConstraints");
    const reasoningIndices = ackModules.map((value, index) => value === "plan.reasoning" ? index : -1).filter((index) => index >= 0);
    const lastReasoningIndex = reasoningIndices.length ? reasoningIndices[reasoningIndices.length - 1] : -1;
    const buildGoalIndex = ackModules.indexOf("plan.buildGoal");
    const buildApproachIndex = ackModules.indexOf("plan.buildApproach");
    const buildValidationIndex = ackModules.indexOf("plan.buildValidation");
    const buildRepairIndex = ackModules.indexOf("plan.buildRepair");
    const finalizeIndex = ackModules.indexOf("plan.finalize");
    const specLockIndex = ackModules.indexOf("spec_lock.finalize");
    const writeStartIndex = ackModules.indexOf("write.start");
    const writeStreamIndices = ackModules.map((value, index) => value === "write.stream" ? index : -1).filter((index) => index >= 0);
    const writeReadyIndex = ackModules.indexOf("write.ready");
    const runMockStartIndex = ackModules.indexOf("run.mockStart");
    const runRealStartIndex = ackModules.indexOf("run.realStart");
    const runRealDoneIndex = ackModules.indexOf("run.realDone");
    const detectQualityCheckIndex = ackModules.indexOf("detect.qualityCheck");
    const detectDoneIndex = ackModules.indexOf("detect.done");
    const summarizeIndex = ackModules.indexOf("summarize.finalize");

    const streamClarify = await postJson("/api/strategy/intent-clarify", {
      userMessage: TEST_PROMPT,
      assistantReply: "",
    }, 60000);
    const streamChoices = {};
    (streamClarify.clarifyingQuestions || []).forEach((q) => {
      const selected = pickStableOption(q);
      if (selected?.value) streamChoices[q.id] = selected.value;
    });
    const streamResult = await postStream("/api/strategy/intent-confirm/stream", {
      featureConcept: streamClarify.featureConcept,
      userChoices: streamChoices,
      clarifyingQuestions: streamClarify.clarifyingQuestions || [],
      userMessage: TEST_PROMPT,
      assistantReply: "",
    }, 300000);
    const streamPayload = streamResult.finalPayload || {};
    const thinkingEvents = (streamResult.events || []).filter((item) => item.event === "thinking");
    const understandEvents = thinkingEvents.filter((item) => String(item?.data?.phase || "").trim() === "understand");
    const streamPhases = thinkingEvents.map((item) => String(item?.data?.phase || "").trim());
    const planThinkingEvents = thinkingEvents.filter((item) => {
      const details = item?.data?.details && typeof item.data.details === "object" ? item.data.details : {};
      return String(item?.data?.phase || "").trim() === "plan" && String(details.streamMode || "").trim() === "thinking_stream";
    });
    const planBuildEvents = thinkingEvents.filter((item) => {
      const details = item?.data?.details && typeof item.data.details === "object" ? item.data.details : {};
      return String(item?.data?.phase || "").trim() === "plan" && details.planBuild && typeof details.planBuild === "object";
    });
    const firstPlanThinkingIndex = thinkingEvents.findIndex((item) => {
      const details = item?.data?.details && typeof item.data.details === "object" ? item.data.details : {};
      return String(item?.data?.phase || "").trim() === "plan" && String(details.streamMode || "").trim() === "thinking_stream";
    });
    const firstPlanBuildIndex = thinkingEvents.findIndex((item) => {
      const details = item?.data?.details && typeof item.data.details === "object" ? item.data.details : {};
      return String(item?.data?.phase || "").trim() === "plan" && details.planBuild && typeof details.planBuild === "object";
    });
    const planThinkingLengths = planThinkingEvents.map((item) => {
      const details = item?.data?.details && typeof item.data.details === "object" ? item.data.details : {};
      return String(details.thinkingText || "").length;
    }).filter((value) => value > 0);
    const planThinkingStrictlyIncreasing = planThinkingLengths.length >= 3
      && planThinkingLengths.every((value, index) => index === 0 || value > planThinkingLengths[index - 1]);
    const lastPlanThinkingEvent = planThinkingEvents.length ? planThinkingEvents[planThinkingEvents.length - 1] : null;
    const lastPlanThinkingChunkDone = Boolean(lastPlanThinkingEvent?.data?.details?.chunkDone);
    const planBuildKeys = planBuildEvents.map((item) => String(item?.data?.details?.planBuild?.key || "").trim()).filter(Boolean);
    const planBuildKeySequence = Array.from(new Set(planBuildKeys)).slice(0, 4);
    const planStatusSequence = thinkingEvents
      .filter((item) => String(item?.data?.phase || "").trim() === "plan")
      .map((item) => String(item?.data?.details?.planStatus || "").trim())
      .filter(Boolean);
    const firstDraftingStatusIndex = planStatusSequence.indexOf("drafting");
    const lastDraftingStatusIndex = planStatusSequence.lastIndexOf("drafting");
    const firstRefiningStatusIndex = planStatusSequence.indexOf("refining");
    const firstFinalizedStatusIndex = planStatusSequence.indexOf("finalized");
    const understandTaskEvent = understandEvents.find((item) => String(item?.data?.details?.payload?.stage || "").trim() === "task");
    const understandOptionsEvent = understandEvents.find((item) => String(item?.data?.details?.payload?.stage || "").trim() === "options");
    const specIndex = streamPhases.indexOf("spec_lock");
    const writeIndex = streamPhases.findIndex((phase, index) => phase === "write" && String(thinkingEvents[index]?.data?.status || "") === "done");
    const writeCount = streamPhases.filter((phase, index) => phase === "write" && String(thinkingEvents[index]?.data?.status || "") === "done").length;
    const runEventCount = streamPhases.filter((phase) => phase === "run").length;
    const detectEventCount = streamPhases.filter((phase) => phase === "detect").length;
    const hasSpec = Boolean(streamPayload.specArtifact) || specIndex >= 0;
    const hasRunArtifacts = Boolean(streamPayload.runArtifacts || streamPayload.generatedCode?.runArtifacts);
    const streamOk = Boolean(streamPayload.ok);
    const stepTexts = await collectStepTexts(page);
    const traceTextAfterFinish = String(await tracePanel.textContent() || "");

    const archiveBtnAfterFlow = page.locator("#session-archive-btn");
    if (await archiveBtnAfterFlow.count()) {
      await archiveBtnAfterFlow.click({ timeout: 15000 });
      await page.waitForTimeout(1200);
    }
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    if (!await page.locator("#ai-chat-input").count()) {
      await openApp(page);
    }
    const chatTextAfterArchiveReload = String(await page.locator("#ai-chat-box").textContent() || "");
    const oldPromptVisibleAfterArchiveReload = chatTextAfterArchiveReload.includes(TEST_PROMPT);
    const oldCardCountAfterArchiveReload = await page.locator('.ai-clarify-row[data-card-event-id="' + cardEventId + '"]').count();
    const oldTaskCountAfterArchiveReload = await page.locator('.ai-feature-task-row[data-parent-card-event-id="' + cardEventId + '"]').count();

    const screenshotPath = path.join(ARTIFACT_DIR, "browser-clarification-workbench-success.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const passed = taskRowCount > 0
      && taskInChatFlow
      && cardHasEmbeddedWorkbench === 0
      && hasAccordion > 0
      && hasSpec
      && hasRunArtifacts
      && taskToggleWorks
      && planStepToggleWorks
      && partialNoFutureSteps
      && stepCountBeforeReload > 0
      && firstCollectIndex >= 0
      && firstLockIndex > firstCollectIndex
      && lastReasoningIndex > firstLockIndex
      && buildGoalIndex > lastReasoningIndex
      && buildApproachIndex > buildGoalIndex
      && buildValidationIndex > buildApproachIndex
      && buildRepairIndex > buildValidationIndex
      && finalizeIndex > buildRepairIndex
      && specLockIndex > finalizeIndex
      && writeStartIndex > specLockIndex
      && writeStreamIndices.length >= 2
      && writeReadyIndex > writeStartIndex
      && runMockStartIndex > writeReadyIndex
      && runRealStartIndex > runMockStartIndex
      && runRealDoneIndex > runRealStartIndex
      && detectQualityCheckIndex > runRealDoneIndex
      && detectDoneIndex > detectQualityCheckIndex
      && summarizeIndex > detectDoneIndex
      && restoredHasPlan
      && restoredStepTexts.length > 0
      && streamOk
      && Boolean(understandTaskEvent)
      && Boolean(understandOptionsEvent)
      && String(understandTaskEvent?.data?.details?.payload?.schema || "") === "understand_cards_v1"
      && String(understandOptionsEvent?.data?.details?.payload?.schema || "") === "understand_cards_v1"
      && String(understandTaskEvent?.data?.details?.payload?.taskToken || "") === "📝 特征生成任务"
      && Array.isArray(understandOptionsEvent?.data?.details?.payload?.optionTokens)
      && understandOptionsEvent.data.details.payload.optionTokens.length >= 2
      && planThinkingEvents.length >= 2
      && planBuildEvents.length >= 4
      && firstPlanThinkingIndex >= 0
      && firstPlanBuildIndex > firstPlanThinkingIndex
      && lastPlanThinkingChunkDone
      && ["goal", "approach", "validation", "repair"].every((key) => planBuildKeys.includes(key))
      && planBuildKeySequence.join(",") === "goal,approach,validation,repair"
      && firstDraftingStatusIndex >= 0
      && firstRefiningStatusIndex > firstDraftingStatusIndex
      && lastDraftingStatusIndex < firstRefiningStatusIndex
      && firstFinalizedStatusIndex > firstRefiningStatusIndex
      && specIndex >= 0
      && writeIndex > specIndex
      && writeCount === 1
      && runEventCount >= 2
      && detectEventCount >= 2
      && expandedWhileRunningCount > 0
      && autoFollowInitial.paused === "0"
      && autoFollowPaused.paused === "1"
      && !autoFollowPaused.nearBottom
      && expandedStepCountBeforeReload === stepCountBeforeReload
      && !collapsedAfterFinish
      && !processCollapsedAfterFinish
      && resultVisibleAfterFinish
      && !restoredCollapsedAfterFinish
      && !restoredProcessCollapsed
      && restoredResultVisible
      && restoredStepRowCount > 0
      && expandedStepCount === restoredStepRowCount
      && /📝 特征生成任务/.test(traceTextAfterFinish)
      && (traceTextAfterFinish.match(/✅/g) || []).length >= 2
      && !/已加载用户描述、历史上下文与澄清选择|已整理用户意图、上下文与特征约束/.test(traceTextAfterFinish)
      && /📝 特征生成任务/.test(restoredTraceText)
      && (restoredTraceText.match(/✅/g) || []).length >= 2
      && !/已加载用户描述、历史上下文与澄清选择|已整理用户意图、上下文与特征约束/.test(restoredTraceText)
      && planThinkingStrictlyIncreasing
      && ackSeqStrictlyIncreasing
      && ackSeqContiguous
      && !oldPromptVisibleAfterArchiveReload
      && oldCardCountAfterArchiveReload === 0
      && oldTaskCountAfterArchiveReload === 0;

    log("RESULT", JSON.stringify({
      passed,
      visitedUrl,
      stepCount: stepTexts.length,
      taskRowCount,
      taskInChatFlow,
      cardHasEmbeddedWorkbench: cardHasEmbeddedWorkbench > 0,
      hasAccordion: hasAccordion > 0,
      hasSpec,
      hasRunArtifacts,
      taskToggleWorks,
      planStepToggleWorks,
      ackRequestCount: ackRequests.length,
      ackModules,
      specLockIndex,
      writeStartIndex,
      writeStreamCount: writeStreamIndices.length,
      writeReadyIndex,
      runMockStartIndex,
      runRealStartIndex,
      runRealDoneIndex,
      detectQualityCheckIndex,
      detectDoneIndex,
      summarizeIndex,
      partialHasProgress,
      partialPlanIndex,
      partialNoFutureSteps,
      stepCountBeforeReload,
      expandedWhileRunningCount,
      restoredHasPlan,
      restoredHasSpec,
      restoredHasWrite,
      restoredStepCount: restoredStepTexts.length,
      understandEventCount: understandEvents.length,
      streamOk,
      planThinkingEventCount: planThinkingEvents.length,
      planBuildEventCount: planBuildEvents.length,
      firstPlanThinkingIndex,
      firstPlanBuildIndex,
      lastPlanThinkingChunkDone,
      planBuildKeys,
      planBuildKeySequence,
      planStatusSequence,
      writeCount,
      specIndex,
      writeIndex,
      runEventCount,
      detectEventCount,
      autoFollowInitial,
      autoFollowPaused,
      collapsedAfterFinish,
      processCollapsedAfterFinish,
      resultVisibleAfterFinish,
      restoredCollapsedAfterFinish,
      restoredProcessCollapsed,
      restoredResultVisible,
      planThinkingLengths,
      planThinkingStrictlyIncreasing,
      restoredStepRowCount,
      ackSeqs,
      ackSeqStrictlyIncreasing,
      ackSeqContiguous,
      expandedStepCount,
      oldPromptVisibleAfterArchiveReload,
      oldCardCountAfterArchiveReload,
      oldTaskCountAfterArchiveReload,
      screenshotPath,
    }, null, 2));

    if (!passed) {
      throw new Error("浏览器 E2E 未满足工作台展示断言");
    }
  } catch (error) {
    if (browser) {
      const pages = browser.contexts().flatMap((context) => context.pages());
      if (pages[0]) {
        const failShot = path.join(ARTIFACT_DIR, "browser-clarification-workbench-fail.png");
        await pages[0].screenshot({ path: failShot, fullPage: true }).catch(() => {});
        log("ARTIFACT", `Failure screenshot: ${failShot}`);
      }
    }
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { serverProc.kill("SIGTERM"); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try { serverProc.kill("SIGKILL"); } catch {}
  }
}

main().catch((error) => {
  console.error("BROWSER E2E FAILED:", error);
  process.exit(1);
});
