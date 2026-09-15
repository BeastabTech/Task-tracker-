import { state, ACTIVE_WORK_STATUSES, STATUS_ORDER } from "./state.js";
import { fmtDate, todayStr, yesterdayStr, isClosed, isOverdue, clipText, uniqueVals } from "./utils.js";
import { dailyEntries, statusAtEndOfDay, previousStatusForDay } from "./activity.js";
import { backlogTasks, renderUpdateModeSwitch } from "./views.js";

function updateDetailLine(t){
  const bits = [];
  if (t.priority) bits.push(`Priority: ${t.priority}`);
  if ((t.project || []).length) bits.push(`Project: ${(t.project || []).join(", ")}`);
  if ((t.tags || []).length) bits.push(`Tags: ${(t.tags || []).join(", ")}`);
  if (t.start_date) bits.push(`Start: ${fmtDate(t.start_date)}`);
  if (t.due_date) bits.push(`Due: ${fmtDate(t.due_date)}${isOverdue(t) ? " (overdue)" : ""}`);
  if (t.status === "Cancelled" && t.cancel_reason) bits.push(`Reason: ${t.cancel_reason}`);
  if (t.notes) bits.push(`Note: ${clipText(t.notes)}`);
  return bits.length ? `  ${bits.join(" | ")}` : "";
}

function updateStatusLabel(status, from, suffix = ""){
  const transition = from && from !== status ? `${from} -> ${status}` : status;
  return suffix ? `${transition} ${suffix}` : transition;
}

function formatUpdateTask(item, options = {}){
  const t = item.task || item;
  const status = item.status || t.status;
  const label = options.label || updateStatusLabel(status, item.from, options.suffix || "");
  const detail = updateDetailLine(t);
  return `* [${label}] ${t.title}${detail ? `\n${detail}` : ""}`;
}

function formatUpdateSection(title, rows){
  return [
    title,
    rows.length ? rows.join("\n") : "* None",
  ].join("\n");
}

function shortTaskTitle(t, max = 110){
  return clipText(t.title, max);
}

function shortTaskLine(t, prefix = "-"){
  const bits = [];
  if ((t.project || []).length) bits.push((t.project || [])[0]);
  if (t.due_date && !isClosed(t)) bits.push(`due ${fmtDate(t.due_date)}`);
  return `${prefix} ${shortTaskTitle(t)}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}

export function buildUpdateContext(){
  const today = todayStr();
  const yesterday = yesterdayStr();
  const yesterdayEntries = dailyEntries(yesterday);
  const todayEntries = dailyEntries(today);
  const todayById = new Map(todayEntries.map(entry => [entry.task.id, entry]));

  const rawYesterdayCarry = state.tasks
    .filter(t => !t.archived_at && ACTIVE_WORK_STATUSES.has(statusAtEndOfDay(t, yesterday)))
    .sort((a,b) => (STATUS_ORDER[statusAtEndOfDay(a, yesterday)] ?? 9) - (STATUS_ORDER[statusAtEndOfDay(b, yesterday)] ?? 9));
  const yesterdayCarry = rawYesterdayCarry
    .map(t => {
      const yesterdayStatus = statusAtEndOfDay(t, yesterday);
      const todayEntry = todayById.get(t.id);
      const suffix = todayEntry && todayEntry.status !== yesterdayStatus ? "today" : "";
      return formatUpdateTask({ task: t, status: todayEntry?.status || yesterdayStatus, from: yesterdayStatus }, { suffix });
    });

  const completedYesterday = yesterdayEntries
    .filter(entry => entry.status === "Done")
    .map(entry => formatUpdateTask(entry));
  const changedYesterday = yesterdayEntries
    .filter(entry => entry.status !== "Done" && !ACTIVE_WORK_STATUSES.has(entry.status))
    .map(entry => formatUpdateTask(entry));

  const completedToday = todayEntries
    .filter(entry => entry.status === "Done")
    .map(entry => formatUpdateTask(entry));
  const cancelledToday = todayEntries
    .filter(entry => entry.status === "Cancelled")
    .map(entry => formatUpdateTask(entry));
  const currentActive = state.tasks
    .filter(t => !t.archived_at && ACTIVE_WORK_STATUSES.has(t.status))
    .sort((a,b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9))
    .map(t => formatUpdateTask(todayById.get(t.id) || { task: t, status: t.status, from: previousStatusForDay(t, today) }));
  const otherToday = todayEntries
    .filter(entry => !["Done", "Cancelled"].includes(entry.status) && !ACTIVE_WORK_STATUSES.has(entry.status))
    .map(entry => formatUpdateTask(entry));
  const backlogRows = backlogTasks().map(t => formatUpdateTask(t));

  const rawCurrentActive = state.tasks
    .filter(t => !t.archived_at && ACTIVE_WORK_STATUSES.has(t.status))
    .sort((a,b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));

  // Tasks created today (created_at starts with today's date)
  const rawNewToday = state.tasks
    .filter(t => !t.archived_at && (t.created_at || "").startsWith(today))
    .sort((a,b) => (a.created_at || "").localeCompare(b.created_at || ""));

  // Tasks created yesterday (for morning: new since last evening)
  const rawNewSinceYesterday = state.tasks
    .filter(t => !t.archived_at && (t.created_at || "").startsWith(yesterday))
    .sort((a,b) => (a.created_at || "").localeCompare(b.created_at || ""));

  // Tasks linked to Plane (plane_issue_id null = not yet sent)
  const rawUnsentToPlane = rawCurrentActive.filter(t => !t.plane_issue_id);

  return {
    today,
    yesterday,
    yesterdayEntries,
    todayEntries,
    yesterdayCarry,
    completedYesterday,
    changedYesterday,
    completedToday,
    cancelledToday,
    currentActive,
    otherToday,
    backlogRows,
    rawCurrentActive,
    rawBacklog: backlogTasks(),
    rawCancelledToday: todayEntries.filter(entry => entry.status === "Cancelled").map(entry => entry.task),
    rawCompletedToday: todayEntries.filter(entry => entry.status === "Done").map(entry => entry.task),
    rawCompletedYesterday: yesterdayEntries.filter(entry => entry.status === "Done").map(entry => entry.task),
    rawYesterdayCarry,
    rawNewToday,
    rawNewSinceYesterday,
    rawUnsentToPlane,
  };
}

// ── helpers for rich morning / evening formats ──────────────────────────────

function taskMeta(t){
  const parts = [];
  if ((t.project || []).length) parts.push((t.project).join(", "));
  if (t.priority && t.priority !== "P3") parts.push(t.priority);
  if (t.due_date && !isClosed(t)) parts.push(`due ${fmtDate(t.due_date)}`);
  return parts.length ? `  [${parts.join(" · ")}]` : "";
}

function taskNote(t, indent = "    "){
  const note = (t.notes || "").trim();
  if (!note) return "";
  return `\n${indent}→ ${clipText(note, 120)}`;
}

function sectionBlock(emoji, heading, lines, fallback = "  (none)"){
  return [`${emoji} ${heading}`, ...(lines.length ? lines : [fallback])].join("\n");
}

// ── Morning Update ───────────────────────────────────────────────────────────

function buildMorningUpdateText(context){
  const { today, rawCurrentActive, rawNewSinceYesterday, rawNewToday, rawBacklog } = context;
  const lines = [`☀️  Morning Update — ${fmtDate(today)}`, ""];

  // Active work — all statuses (In Progress / In Review / Pending)
  const activeLines = rawCurrentActive.map(t => {
    const statusTag = t.status === "Pending" ? "⏸ Pending" : t.status === "In Review" ? "👀 In Review" : "▶ In Progress";
    return `  • [${statusTag}] ${t.title}${taskMeta(t)}${taskNote(t)}`;
  });
  lines.push(sectionBlock("🔄", `Active Work (${rawCurrentActive.length})`, activeLines));
  lines.push("");

  // New tasks added since yesterday (carry-in for today's morning)
  const newYestLines = rawNewSinceYesterday.map(t =>
    `  • [${t.id}] ${t.title}${taskMeta(t)}${taskNote(t)}`
  );
  if (newYestLines.length) {
    lines.push(sectionBlock("🆕", `New Tasks Added Yesterday (${newYestLines.length})`, newYestLines));
    lines.push("");
  }

  // New tasks added today so far (if running after some work)
  const newTodayLines = rawNewToday.map(t =>
    `  • [${t.id}] ${t.title}${taskMeta(t)}${taskNote(t)}`
  );
  if (newTodayLines.length) {
    lines.push(sectionBlock("🆕", `New Tasks Added Today (${newTodayLines.length})`, newTodayLines));
    lines.push("");
  }

  // Overdue tasks
  const overdueList = state.tasks.filter(t => !t.archived_at && isOverdue(t));
  if (overdueList.length) {
    const overdueLines = overdueList.map(t =>
      `  • ${t.title}${taskMeta(t)} — was due ${fmtDate(t.due_date)}`
    );
    lines.push(sectionBlock("⚠️", `Overdue (${overdueList.length})`, overdueLines));
    lines.push("");
  }

  // Backlog focus
  const backlogLines = rawBacklog.slice(0, state.backlogLimit).map(t => `  • ${t.title}${taskMeta(t)}`);
  lines.push(sectionBlock("📋", `Backlog Focus (top ${Math.min(state.backlogLimit, rawBacklog.length)})`, backlogLines, "  (backlog clear)"));

  return lines.join("\n");
}

// ── Evening Update ───────────────────────────────────────────────────────────

function buildEveningUpdateText(context){
  const { today, rawCompletedToday, rawCurrentActive, rawNewToday, rawCancelledToday, rawUnsentToPlane } = context;
  const lines = [`🌙  Evening Wrap-up — ${fmtDate(today)}`, ""];

  // Completed today
  const completedLines = rawCompletedToday.map(t =>
    `  • ${t.title}${taskMeta(t)}${taskNote(t)}`
  );
  lines.push(sectionBlock("✅", `Completed Today (${rawCompletedToday.length})`, completedLines, "  (nothing closed today)"));
  lines.push("");

  // Still in progress — what carries to tomorrow
  const inProgressLines = rawCurrentActive.map(t => {
    const statusTag = t.status === "Pending" ? "⏸" : t.status === "In Review" ? "👀" : "▶";
    return `  • ${statusTag} ${t.title}${taskMeta(t)}${taskNote(t)}`;
  });
  lines.push(sectionBlock("🔄", `Still In Progress — carries to tomorrow (${rawCurrentActive.length})`, inProgressLines));
  lines.push("");

  // New tasks added today
  const newLines = rawNewToday.map(t =>
    `  • [${t.id}] ${t.title}${taskMeta(t)}${taskNote(t)}`
  );
  if (newLines.length) {
    lines.push(sectionBlock("🆕", `New Tasks Added Today (${newLines.length})`, newLines));
    lines.push("");
  }

  // Cancelled today
  if (rawCancelledToday.length) {
    const cancelLines = rawCancelledToday.map(t =>
      `  • ${t.title}${t.cancel_reason ? ` — ${clipText(t.cancel_reason, 80)}` : ""}`
    );
    lines.push(sectionBlock("❌", `Cancelled Today (${rawCancelledToday.length})`, cancelLines));
    lines.push("");
  }

  // Tasks not yet sent to Plane
  if (rawUnsentToPlane.length) {
    const unsentLines = rawUnsentToPlane.map(t => `  • [${t.id}] ${t.title}${taskMeta(t)}`);
    lines.push(sectionBlock("📤", `Not Yet in Plane (${rawUnsentToPlane.length})`, unsentLines));
    lines.push("");
  }

  // Summary line
  lines.push(`📊  Day total: ${rawCompletedToday.length} done · ${rawCurrentActive.length} in progress · ${rawNewToday.length} new`);

  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────────────

function buildDetailedUpdateText(context){
  const {
    today,
    yesterday,
    yesterdayCarry,
    completedYesterday,
    changedYesterday,
    completedToday,
    cancelledToday,
    currentActive,
    otherToday,
    backlogRows,
  } = context;

  const sections = [
    `Daily Update - ${fmtDate(today)}`,
    "",
    `Yesterday (${fmtDate(yesterday)})`,
    formatUpdateSection("Active / carried work", yesterdayCarry),
    "",
    formatUpdateSection("Completed yesterday", completedYesterday),
    changedYesterday.length ? `\n${formatUpdateSection("Other changes yesterday", changedYesterday)}` : "",
    "",
    `Today (${fmtDate(today)})`,
    formatUpdateSection("Completed today", completedToday),
    "",
    formatUpdateSection("Current active / review", currentActive),
    "",
    formatUpdateSection("Cancelled today", cancelledToday),
    otherToday.length ? `\n${formatUpdateSection("Other changes today", otherToday)}` : "",
    "",
    `Backlog focus (top ${state.backlogLimit})`,
    backlogRows.length ? backlogRows.join("\n") : "* None",
  ];
  return sections.join("\n").replace(/\n{3,}/g, "\n\n");
}

function buildShortUpdateText(context){
  const completed = uniqueVals([
    ...context.rawCompletedToday.map(shortTaskTitle),
    ...context.rawCompletedYesterday.map(t => `${shortTaskTitle(t)} yesterday`),
  ]);
  const active = context.rawCurrentActive.slice(0, 4).map(t => {
    const status = t.status === "In Review" ? "review" : t.status === "Pending" ? "pending" : "progress";
    return shortTaskLine(t, `- ${status}:`);
  });
  const cancelled = context.rawCancelledToday.slice(0, 3).map(t =>
    `- cancelled: ${shortTaskTitle(t)}${t.cancel_reason ? ` (${clipText(t.cancel_reason, 80)})` : ""}`
  );
  const next = context.rawBacklog.slice(0, 3).map(t => shortTaskLine(t));

  const lines = [`Update - ${fmtDate(context.today)}`];
  lines.push("");
  lines.push("Done:");
  lines.push(...(completed.length ? completed.map(t => `- ${t}`) : ["- None"]));
  lines.push("");
  lines.push("Now:");
  lines.push(...(active.length ? active : ["- None"]));
  if (cancelled.length) {
    lines.push("");
    lines.push("Cancelled:");
    lines.push(...cancelled);
  }
  lines.push("");
  lines.push("Next:");
  lines.push(...(next.length ? next : ["- None"]));
  return lines.join("\n");
}

// Talking points for actually saying out loud in standup — not a written report. Terse, capped
// short so it's a glance-and-speak list, and splits out "Blockers" (Pending-status work, plus
// anything overdue) as its own callout instead of burying it inside "current work", since that's
// specifically what a standup wants flagged.
function buildStandupSpeakText(context){
  const yesterdaySeen = new Set();
  const yesterdayLines = [];
  context.rawCompletedYesterday.forEach(t => {
    if (yesterdaySeen.has(t.id)) return;
    yesterdaySeen.add(t.id);
    yesterdayLines.push(`- Finished: ${shortTaskTitle(t, 90)}`);
  });
  context.rawYesterdayCarry.forEach(t => {
    if (yesterdaySeen.has(t.id)) return;
    yesterdaySeen.add(t.id);
    yesterdayLines.push(`- Worked on: ${shortTaskTitle(t, 90)}`);
  });

  const todayLines = context.rawCurrentActive
    .filter(t => t.status !== "Pending")
    .map(t => `- ${shortTaskTitle(t, 90)}`);

  const blockerSeen = new Set();
  const blockerLines = [];
  context.rawCurrentActive.filter(t => t.status === "Pending").forEach(t => {
    blockerSeen.add(t.id);
    blockerLines.push(`- ${shortTaskTitle(t, 90)}${t.due_date ? ` (due ${fmtDate(t.due_date)})` : ""}`);
  });
  state.tasks.filter(t => !t.archived_at && !isClosed(t) && isOverdue(t) && !blockerSeen.has(t.id)).forEach(t => {
    blockerSeen.add(t.id);
    blockerLines.push(`- Overdue: ${shortTaskTitle(t, 90)} (was due ${fmtDate(t.due_date)})`);
  });

  const backlogLines = context.rawBacklog.slice(0, 4).map(t => `- ${shortTaskTitle(t, 90)}`);

  const lines = [`Standup talking points - ${fmtDate(context.today)}`, ""];
  lines.push("Yesterday:");
  lines.push(...(yesterdayLines.length ? yesterdayLines.slice(0, 6) : ["- Nothing logged"]));
  lines.push("");
  lines.push("Today:");
  lines.push(...(todayLines.length ? todayLines.slice(0, 6) : ["- Nothing active"]));
  lines.push("");
  lines.push("Blockers:");
  lines.push(...(blockerLines.length ? blockerLines : ["- None"]));
  lines.push("");
  lines.push("Backlog to look at:");
  lines.push(...(backlogLines.length ? backlogLines : ["- None"]));
  return lines.join("\n");
}

export function buildDailyUpdateText(mode = state.updateMode){
  const context = buildUpdateContext();
  if (mode === "morning") return buildMorningUpdateText(context);
  if (mode === "evening") return buildEveningUpdateText(context);
  if (mode === "detailed") return buildDetailedUpdateText(context);
  if (mode === "speak") return buildStandupSpeakText(context);
  return buildShortUpdateText(context);
}

export function refreshUpdatePreview(open = false){
  const preview = document.getElementById("updatePreview");
  const wrap = document.getElementById("updatePreviewWrap");
  preview.textContent = buildDailyUpdateText();
  wrap.classList.toggle("open", open || wrap.classList.contains("open"));
  renderUpdateModeSwitch();
}
