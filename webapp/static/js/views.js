import {
  state, API, MONTH_ORDER, STATUS_ORDER, PRIORITY_ORDER,
  FILTER_LABELS, CHIP_LABELS,
} from "./state.js";
import {
  slug, statusToneClass, todayStr, fmtDate, fmtRange, weekKeyAndLabel,
  ageDays, isClosed, isOverdue, isStale, escapeHtml, clipText, taskMetaLine, isBugModuleTask,
} from "./utils.js";
import {
  activityStatus, activityTime, activityLabel, recentActivities, dailyEntries,
} from "./activity.js";
import { patch, noticePlaneSyncResult } from "./api.js";
import {
  moveTaskStatus, wireStatusAndDelete, wireChipField, wireAddAttachment,
  wireAddComment, wireHistoryToggle,
} from "./tasks.js";
import { wireAiAssist } from "./ai.js";
import { wireTaskAsk } from "./agent.js";
import { wirePlaneButton } from "./plane.js";
import { refreshUpdatePreview } from "./updates.js";

let hoverTooltipEl = null;

// Jumping to a task (from a summary row, activity feed, etc.) must actually reveal it — if its
// month/week section is currently folded, the card isn't even in the DOM to scroll to.
export function ensureTaskSectionExpanded(t){
  if (!t.month) return;
  state.collapsedMonths.delete(t.month);
  const { key } = weekKeyAndLabel(t.discussed_from);
  state.collapsedWeeks.delete(`${t.month}::${key}`);
}

export function visibleTaskFilter(t, todayActivityIds){
  if (state.activeFilter !== "archived" && t.archived_at) return false;
  if (state.activeFilter === "archived" && !t.archived_at) return false;
  if (state.statuses.includes(state.activeFilter) && t.status !== state.activeFilter) return false;
  if (state.activeFilter === "today" && !todayActivityIds.has(t.id)) return false;
  if (state.activeFilter === "overdue" && !isOverdue(t)) return false;
  if (state.activeFilter === "high" && !["P1", "P2"].includes(t.priority || "P3")) return false;
  if (state.activeFilter === "stale" && !isStale(t)) return false;
  if (state.activeFilter === "review" && (t.type || "Task") !== "Review") return false;
  if (state.activeFilter === "bugmodule" && !isBugModuleTask(t)) return false;
  if (state.activeProject && !(t.project || []).includes(state.activeProject)) return false;
  if (state.activeTag && !(t.tags || []).includes(state.activeTag)) return false;
  if (state.activeCycle && t.plane_cycle_name !== state.activeCycle) return false;
  if (state.dateFrom && (t.updated_at || "") < state.dateFrom) return false;
  if (state.dateTo && (t.updated_at || "") > state.dateTo) return false;
  if (state.searchTerm) {
    const hay = [t.id, t.plane_number, t.title, t.notes, ...(t.discussed_with||[]), ...(t.project||[]), ...(t.tags||[])].join(" ").toLowerCase();
    if (!hay.includes(state.searchTerm.toLowerCase())) return false;
  }
  return true;
}

export function populateDatalists(){
  const map = { project: "dl-project", tags: "dl-tags", discussed_with: "dl-who" };
  Object.entries(map).forEach(([field, dlId]) => {
    const set = new Set();
    state.tasks.forEach(t => (t[field] || []).forEach(v => set.add(v)));
    document.getElementById(dlId).innerHTML =
      [...set].sort().map(v => `<option value="${escapeHtml(v)}">`).join("");
  });
}

export function populateProjectFilter(){
  const sel = document.getElementById("projectFilter");
  const projects = new Set();
  state.tasks.forEach(t => (t.project || []).forEach(p => projects.add(p)));
  const current = sel.value;
  sel.innerHTML = '<option value="">All projects</option>' +
    [...projects].sort().map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
  sel.value = current;
}

export function populateTagFilter(){
  const sel = document.getElementById("tagFilter");
  const tags = new Set();
  state.tasks.forEach(t => (t.tags || []).forEach(g => tags.add(g)));
  const current = sel.value;
  sel.innerHTML = '<option value="">All tags</option>' +
    [...tags].sort().map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join("");
  sel.value = current;
}

export function populateCycleFilter(){
  const sel = document.getElementById("cycleFilter");
  const cycles = new Set();
  state.tasks.forEach(t => { if (t.plane_cycle_name) cycles.add(t.plane_cycle_name); });
  const current = sel.value;
  sel.innerHTML = '<option value="">All cycles</option>' +
    [...cycles].sort().map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  sel.value = current;
}

export function populateStatusSelect(){
  document.getElementById("newStatus").innerHTML =
    state.statuses.map(s => `<option value="${s}">${s}</option>`).join("");
}

export function populatePrioritySelects(){
  const html = state.priorities.map(p => `<option value="${p}" ${p==="P3"?"selected":""}>${p}</option>`).join("");
  document.getElementById("newPriority").innerHTML = html;
}

export function populateTypeSelect(){
  document.getElementById("newType").innerHTML =
    state.taskTypes.map(ty => `<option value="${ty}">${ty}</option>`).join("");
}

export function statusOptionsHtml(current){
  return state.statuses.map(s => `<option value="${s}" ${s===current?"selected":""}>${s}</option>`).join("");
}

export function priorityOptionsHtml(current){
  return state.priorities.map(p => `<option value="${p}" ${p===current?"selected":""}>${p}</option>`).join("");
}

export function typeOptionsHtml(current){
  return state.taskTypes.map(ty => `<option value="${ty}" ${ty===current?"selected":""}>${ty}</option>`).join("");
}

export function sortedTasksDesc(list){
  return [...list].sort((a,b) => {
    // Open work always ranks above Done/Cancelled, no matter how recently either was touched —
    // otherwise a task marked Done just now (updated_ts = right now) would outrank active work.
    const aClosed = a.status === "Done" || a.status === "Cancelled";
    const bClosed = b.status === "Done" || b.status === "Cancelled";
    if (aClosed !== bClosed) return aClosed ? 1 : -1;
    if (!aClosed) {
      const pa = PRIORITY_ORDER[a.priority || "P3"] ?? 2;
      const pb = PRIORITY_ORDER[b.priority || "P3"] ?? 2;
      if (pa !== pb) return pa - pb;
    }
    const ma = MONTH_ORDER.indexOf(a.month), mb = MONTH_ORDER.indexOf(b.month);
    if (ma !== mb) return mb - ma;
    const ta = a.updated_ts || a.created_at || a.updated_at || "";
    const tb = b.updated_ts || b.created_at || b.updated_at || "";
    return tb.localeCompare(ta);
  });
}

export function backlogTasks(){
  return state.tasks
    .filter(t => !t.archived_at && t.status === "To Do")
    .sort((a,b) => {
      const pa = PRIORITY_ORDER[a.priority || "P3"] ?? 2;
      const pb = PRIORITY_ORDER[b.priority || "P3"] ?? 2;
      if (pa !== pb) return pa - pb;
      const dueA = a.due_date || "9999-12-31";
      const dueB = b.due_date || "9999-12-31";
      if (dueA !== dueB) return dueA.localeCompare(dueB);
      return ageDays(b) - ageDays(a);
    })
    .slice(0, Math.max(0, state.backlogLimit));
}

export function ensureHoverTooltip(){
  if (hoverTooltipEl) return hoverTooltipEl;
  hoverTooltipEl = document.createElement("div");
  hoverTooltipEl.className = "hover-tooltip";
  document.body.appendChild(hoverTooltipEl);
  return hoverTooltipEl;
}
export function taskTooltipHtml(t, extraLineHtml){
  const bits = [];
  bits.push(`<div class="tt-title">${t.type === "Review" ? "👀 " : ""}${isBugModuleTask(t) ? "🐛 " : ""}${escapeHtml(t.title)}</div>`);
  bits.push(`<div class="tt-meta"><span class="row-status status-${slug(t.status)}">${escapeHtml(t.status)}</span><span class="tag priority priority-${t.priority||"P3"}">${escapeHtml(t.priority||"P3")}</span></div>`);
  if (extraLineHtml) bits.push(`<div class="tt-line tt-extra">${extraLineHtml}</div>`);
  if ((t.project||[]).length) bits.push(`<div class="tt-line"><strong>Project:</strong> ${escapeHtml(t.project.join(", "))}</div>`);
  if ((t.tags||[]).length) bits.push(`<div class="tt-line"><strong>Tags:</strong> ${escapeHtml(t.tags.join(", "))}</div>`);
  if ((t.discussed_with||[]).length) bits.push(`<div class="tt-line"><strong>With:</strong> ${escapeHtml(t.discussed_with.join(", "))}</div>`);
  if (t.due_date) bits.push(`<div class="tt-line"><strong>Due:</strong> ${escapeHtml(fmtDate(t.due_date))}</div>`);
  if (t.status === "Cancelled" && t.cancel_reason) bits.push(`<div class="tt-line"><strong>Reason:</strong> ${escapeHtml(t.cancel_reason)}</div>`);
  if (t.notes) bits.push(`<div class="tt-notes">${escapeHtml(clipText(t.notes, 260))}</div>`);
  return bits.join("");
}
export function positionHoverTooltip(anchor){
  const el = hoverTooltipEl;
  const rect = anchor.getBoundingClientRect();
  const ttRect = el.getBoundingClientRect();
  let top = rect.bottom + 8;
  if (top + ttRect.height > window.innerHeight - 8) top = rect.top - ttRect.height - 8;
  let left = rect.left;
  if (left + ttRect.width > window.innerWidth - 8) left = window.innerWidth - ttRect.width - 8;
  if (left < 8) left = 8;
  el.style.top = `${Math.max(8, top)}px`;
  el.style.left = `${left}px`;
}
export function hideHoverTooltip(){
  if (hoverTooltipEl) hoverTooltipEl.classList.remove("show");
}
export function attachHoverPreview(row, htmlFn){
  row.addEventListener("mouseenter", () => {
    const el = ensureHoverTooltip();
    el.innerHTML = htmlFn();
    el.classList.add("show");
    positionHoverTooltip(row);
  });
  row.addEventListener("mouseleave", hideHoverTooltip);
}

export function compactTaskRow(t, label){
  const row = document.createElement("button");
  row.type = "button";
  row.className = `task-row status-card ${statusToneClass(label || t.status)}`;
  row.dataset.id = t.id;
  row.innerHTML = `
    <span class="row-status status-${slug(label || t.status)}">${escapeHtml(label || t.status)}</span>
    <span class="row-main">
      <span class="row-title"><span class="task-id-badge" title="${t.plane_number ? `Plane: ${escapeHtml(t.plane_number)}` : "Not yet sent to Plane"}">${escapeHtml(t.id)}</span> ${t.type === "Review" ? "👀 " : ""}${isBugModuleTask(t) ? "🐛 " : ""}${escapeHtml(t.title)}</span>
      <span class="row-meta">${escapeHtml(taskMetaLine(t) || (t.updated_at ? `Updated ${fmtDate(t.updated_at)}` : ""))}</span>
    </span>
    <span class="row-priority priority-${t.priority || "P3"}">${escapeHtml(t.priority || "P3")}</span>
    ${t.plane_url ? `<span class="row-plane-link" title="View in Plane">↗</span>` : ""}
  `;
  row.addEventListener("click", () => {
    resetFilters();
    ensureTaskSectionExpanded(t);
    state.highlightedTaskId = t.id;
    render();
    const target = document.querySelector(`#board [data-id="${t.id}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => {
      if (state.highlightedTaskId === t.id) {
        state.highlightedTaskId = "";
        render();
      }
    }, 2200);
  });
  const planeLink = row.querySelector(".row-plane-link");
  if (planeLink) {
    planeLink.addEventListener("click", e => {
      e.stopPropagation();
      window.open(t.plane_url, "_blank", "noopener");
    });
  }
  attachHoverPreview(row, () => taskTooltipHtml(t, label && label !== t.status ? `<strong>Then:</strong> ${escapeHtml(label)}` : ""));
  return row;
}

export function compactActivityRow(item){
  const row = document.createElement("button");
  row.type = "button";
  row.className = `activity-row status-card ${statusToneClass(activityStatus(item.activity, item.task) || item.task.status)}`;
  row.dataset.id = item.task.id;
  row.innerHTML = `
    <span class="timeline-dot status-${slug(activityStatus(item.activity, item.task) || item.task.status)}"></span>
    <span class="row-main">
      <span class="row-title">${escapeHtml(activityLabel(item.activity))}</span>
      <span class="row-meta">${isBugModuleTask(item.task) ? "🐛 " : ""}${escapeHtml(item.task.title)} · ${escapeHtml(activityTime(item.activity))}${item.activity.inferred ? " · inferred" : ""}</span>
    </span>
    ${item.task.plane_url ? `<span class="row-plane-link" title="View in Plane">↗</span>` : ""}
  `;
  row.addEventListener("click", () => {
    resetFilters();
    ensureTaskSectionExpanded(item.task);
    state.highlightedTaskId = item.task.id;
    state.viewMode = "list";
    localStorage.setItem("taskViewMode", state.viewMode);
    render();
    document.querySelector(`#board [data-id="${item.task.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  const planeLink = row.querySelector(".row-plane-link");
  if (planeLink) {
    planeLink.addEventListener("click", e => {
      e.stopPropagation();
      window.open(item.task.plane_url, "_blank", "noopener");
    });
  }
  attachHoverPreview(row, () => taskTooltipHtml(item.task, `<strong>Activity:</strong> ${escapeHtml(activityLabel(item.activity))} · ${escapeHtml(activityTime(item.activity))}`));
  return row;
}

export function renderPreview(containerId, rows, emptyText){
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  if (!rows.length) {
    container.innerHTML = `<div class="preview-empty">${escapeHtml(emptyText)}</div>`;
    return;
  }
  rows.forEach(row => container.appendChild(row));
}

export function renderReview(){
  const todayRows = dailyEntries(todayStr())
    .slice(0, 5)
    .map(entry => compactTaskRow(entry.task, entry.status));
  const backlogRows = backlogTasks()
    .slice(0, 5)
    .map(t => compactTaskRow(t));
  const staleRows = state.tasks
    .filter(t => !t.archived_at && isStale(t))
    .sort((a,b) => ageDays(b) - ageDays(a))
    .slice(0, 5)
    .map(t => compactTaskRow(t));
  const activityRows = recentActivities(5).map(compactActivityRow);
  renderPreview("todayPreview", todayRows, "No meaningful status changes today.");
  renderPreview("backlogPreview", backlogRows, "Backlog is clear.");
  renderPreview("stalePreview", staleRows, "No stale open tasks.");
  renderPreview("activityPreview", activityRows, "No activity yet.");
}

export function renderAttention(){
  const open = state.tasks.filter(t => !t.archived_at && !isClosed(t));
  const list = document.getElementById("attentionList");
  const title = document.getElementById("attentionTitle");
  title.textContent = `Needs attention (${open.length})`;

  if (!state.attentionOpen){
    list.style.display = "none";
    document.getElementById("attentionArrow").textContent = "▸";
    return;
  }
  list.style.display = "grid";
  document.getElementById("attentionArrow").textContent = "▾";

  list.innerHTML = "";
  if (!open.length){
    list.innerHTML = '<div class="attention-empty">Nothing open — everything is done. 🎉</div>';
    return;
  }
  const sorted = [...open].sort((a,b) => {
    if (isOverdue(a) !== isOverdue(b)) return isOverdue(a) ? -1 : 1;
    const pa = PRIORITY_ORDER[a.priority || "P3"] ?? 2;
    const pb = PRIORITY_ORDER[b.priority || "P3"] ?? 2;
    if (pa !== pb) return pa - pb;
    return (STATUS_ORDER[a.status]??9) - (STATUS_ORDER[b.status]??9);
  }).slice(0, 8);
  sorted.forEach(t => list.appendChild(compactTaskRow(t)));
}

export function render(){
  hideHoverTooltip();
  const board = document.getElementById("board");
  board.innerHTML = "";
  const todayActivityIds = new Set(dailyEntries(todayStr()).map(entry => entry.task.id));

  let visible = state.tasks.filter(t => visibleTaskFilter(t, todayActivityIds));

  renderStats();
  renderReview();
  renderAttention();
  renderViewSwitch();
  renderUpdateModeSwitch();
  if (document.getElementById("updatePreviewWrap")?.classList.contains("open")) refreshUpdatePreview(true);
  const baseTitle = FILTER_LABELS[state.activeFilter] || state.activeFilter;
  document.getElementById("boardTitle").textContent = state.viewMode === "board" ? `${baseTitle} board` : state.viewMode === "activity" ? "Activity timeline" : baseTitle;
  document.getElementById("resultCount").textContent = `${visible.length} task${visible.length === 1 ? "" : "s"}`;

  if (!visible.length && state.viewMode !== "activity"){
    board.innerHTML = '<div class="empty">No tasks match.</div>';
    return;
  }

  board.className = state.viewMode === "board" ? "kanban" : state.viewMode === "activity" ? "activity-feed" : "";
  if (state.viewMode === "board") return renderKanban(visible);
  if (state.viewMode === "activity") return renderActivityFeed(visible);
  renderList(visible);
}

export function renderViewSwitch(){
  document.querySelectorAll(".view-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.viewMode === state.viewMode);
  });
}

export function renderUpdateModeSwitch(){
  document.querySelectorAll(".mode-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.updateMode === state.updateMode);
  });
  const copyBtn = document.getElementById("copyBtn");
  const copyLabels = {
    morning: "Copy morning update",
    evening: "Copy evening wrap-up",
    detailed: "Copy detailed update",
    speak: "Copy talking points",
    short: "Copy short update",
  };
  if (copyBtn) copyBtn.textContent = copyLabels[state.updateMode] || copyLabels.short;
  const previewBtn = document.getElementById("previewUpdateBtn");
  const previewOpen = document.getElementById("updatePreviewWrap")?.classList.contains("open");
  if (previewBtn) previewBtn.textContent = previewOpen ? "Hide preview" : "Show preview";
  const titleEl = document.getElementById("updatePanelTitle");
  if (titleEl) {
    const titles = {
      morning: "Active work · New tasks · Overdue · Backlog",
      evening: "Completed today · In progress · New tasks · Carry forward",
      detailed: "Yesterday / Today / Blockers / Backlog",
      speak: "Yesterday / Today / Blockers / Backlog",
      short: "Yesterday / Today / Blockers / Backlog",
    };
    titleEl.textContent = titles[state.updateMode] || titles.short;
  }
}

export function renderList(visible){
  const board = document.getElementById("board");
  visible = sortedTasksDesc(visible);

  const months = [...new Set(visible.map(t => t.month || "Other"))]
    .sort((a,b) => {
      const ia = MONTH_ORDER.indexOf(a), ib = MONTH_ORDER.indexOf(b);
      return (ib === -1 ? -1 : ib) - (ia === -1 ? -1 : ia);
    });

  months.forEach(month => {
    const group = visible.filter(t => (t.month || "Other") === month);
    const monthCollapsed = state.collapsedMonths.has(month);
    const head = document.createElement("div");
    head.className = "month-head foldable";
    head.innerHTML = `<span class="fold-caret">${monthCollapsed ? "▸" : "▾"}</span><h2>${escapeHtml(month)}</h2><span class="count">${group.length}</span><div class="line"></div>`;
    head.addEventListener("click", () => {
      if (monthCollapsed) state.collapsedMonths.delete(month); else state.collapsedMonths.add(month);
      render();
    });
    board.appendChild(head);
    if (monthCollapsed) return;

    const weeks = new Map();
    group.forEach(t => {
      const { key, label } = weekKeyAndLabel(t.discussed_from);
      if (!weeks.has(key)) weeks.set(key, { label, tasks: [] });
      weeks.get(key).tasks.push(t);
    });
    [...weeks.keys()].sort((a,b) => b.localeCompare(a)).forEach(weekKey => {
      const { label, tasks: weekTasks } = weeks.get(weekKey);
      const compositeKey = `${month}::${weekKey}`;
      const weekCollapsed = state.collapsedWeeks.has(compositeKey);
      const weekHead = document.createElement("div");
      weekHead.className = "week-head foldable";
      weekHead.innerHTML = `<span class="fold-caret">${weekCollapsed ? "▸" : "▾"}</span><h3>${escapeHtml(label)}</h3><span class="count">${weekTasks.length}</span>`;
      weekHead.addEventListener("click", () => {
        if (weekCollapsed) state.collapsedWeeks.delete(compositeKey); else state.collapsedWeeks.add(compositeKey);
        render();
      });
      board.appendChild(weekHead);
      if (weekCollapsed) return;
      weekTasks.forEach(t => board.appendChild(renderCard(t)));
    });
  });
}

export function renderKanban(visible){
  const board = document.getElementById("board");
  const active = visible.filter(t => !t.archived_at);
  state.statuses.forEach(status => {
    const col = document.createElement("section");
    col.className = `kanban-col status-col-${slug(status)}`;
    const group = sortedTasksDesc(active.filter(t => t.status === status));
    col.innerHTML = `
      <div class="kanban-head">
        <span>${escapeHtml(status)}</span>
        <strong>${group.length}</strong>
      </div>
      <div class="kanban-list" data-status="${escapeHtml(status)}"></div>
    `;
    const list = col.querySelector(".kanban-list");
    wireKanbanDropZone(col, list);
    if (!group.length) {
      list.innerHTML = '<div class="kanban-empty">Empty</div>';
    } else {
      group.forEach(t => list.appendChild(renderKanbanCard(t)));
    }
    board.appendChild(col);
  });
}

export function wireKanbanDropZone(col, list){
  list.addEventListener("dragover", e => {
    if (!state.draggedTaskId) return;
    e.preventDefault();
    col.classList.add("drag-over");
  });
  list.addEventListener("dragleave", e => {
    if (!col.contains(e.relatedTarget)) col.classList.remove("drag-over");
  });
  list.addEventListener("drop", async e => {
    e.preventDefault();
    col.classList.remove("drag-over");
    const taskId = e.dataTransfer.getData("text/plain") || state.draggedTaskId;
    state.draggedTaskId = "";
    const task = state.tasks.find(t => t.id === taskId);
    const targetStatus = list.dataset.status;
    if (!task || !targetStatus || task.status === targetStatus) return render();
    const updated = await moveTaskStatus(task, targetStatus);
    if (!updated) return render();
    state.highlightedTaskId = task.id;
    render();
  });
}

export function setDragOverList(list){
  document.querySelectorAll(".kanban-col.drag-over").forEach(col => col.classList.remove("drag-over"));
  if (list) list.closest(".kanban-col")?.classList.add("drag-over");
}

export function cleanupPointerDrag(card){
  if (state.pointerDrag?.ghost) state.pointerDrag.ghost.remove();
  card.classList.remove("dragging");
  setDragOverList(null);
}

export function wirePointerDrag(card, t){
  const startDrag = (e, pointerId = "mouse") => {
    state.pointerDrag = {
      taskId: t.id,
      pointerId,
      startX: e.clientX,
      startY: e.clientY,
      overList: null,
      ghost: null,
      moved: false,
    };
  };

  const moveDrag = e => {
    const dx = e.clientX - state.pointerDrag.startX;
    const dy = e.clientY - state.pointerDrag.startY;
    if (!state.pointerDrag.moved && Math.hypot(dx, dy) < 8) return;
    e.preventDefault();
    state.pointerDrag.moved = true;
    if (!state.pointerDrag.ghost) {
      state.pointerDrag.ghost = card.cloneNode(true);
      state.pointerDrag.ghost.className = `${card.className} kanban-drag-ghost`;
      state.pointerDrag.ghost.style.width = `${card.getBoundingClientRect().width}px`;
      document.body.appendChild(state.pointerDrag.ghost);
      card.classList.add("dragging");
    }
    state.pointerDrag.ghost.style.left = `${e.clientX + 12}px`;
    state.pointerDrag.ghost.style.top = `${e.clientY + 12}px`;
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest(".kanban-list");
    state.pointerDrag.overList = over;
    setDragOverList(over);
  };

  const finishDrag = async e => {
    const targetList = state.pointerDrag.overList;
    const moved = state.pointerDrag.moved;
    cleanupPointerDrag(card);
    state.pointerDrag = null;
    if (!moved || !targetList) return;
    const targetStatus = targetList.dataset.status;
    if (!targetStatus || targetStatus === t.status) return render();
    const updated = await moveTaskStatus(t, targetStatus);
    if (updated) state.highlightedTaskId = t.id;
    render();
  };

  card.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    if (e.target.closest("button,a,select,input,textarea")) return;
    startDrag(e, e.pointerId);
    card.setPointerCapture?.(e.pointerId);
  });

  card.addEventListener("pointermove", e => {
    if (!state.pointerDrag || state.pointerDrag.taskId !== t.id || state.pointerDrag.pointerId !== e.pointerId) return;
    moveDrag(e);
  });

  card.addEventListener("pointerup", async e => {
    if (!state.pointerDrag || state.pointerDrag.taskId !== t.id || state.pointerDrag.pointerId !== e.pointerId) return;
    card.releasePointerCapture?.(e.pointerId);
    await finishDrag(e);
  });

  card.addEventListener("pointercancel", e => {
    if (!state.pointerDrag || state.pointerDrag.taskId !== t.id || state.pointerDrag.pointerId !== e.pointerId) return;
    cleanupPointerDrag(card);
    state.pointerDrag = null;
  });

  card.addEventListener("mousedown", e => {
    if (state.pointerDrag || e.button !== 0) return;
    if (e.target.closest("button,a,select,input,textarea")) return;
    startDrag(e);
    const onMove = moveEvent => {
      if (!state.pointerDrag || state.pointerDrag.taskId !== t.id || state.pointerDrag.pointerId !== "mouse") return;
      moveDrag(moveEvent);
    };
    const onUp = async upEvent => {
      window.removeEventListener("mousemove", onMove);
      if (!state.pointerDrag || state.pointerDrag.taskId !== t.id || state.pointerDrag.pointerId !== "mouse") return;
      await finishDrag(upEvent);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, { once: true });
  });
}

export function renderKanbanCard(t){
  const card = document.createElement("article");
  card.className = `kanban-card status-card ${statusToneClass(t.status)} ${state.highlightedTaskId === t.id ? "highlighted" : ""}`;
  card.dataset.id = t.id;
  card.draggable = true;
  const nextStatus = nextWorkflowStatus(t.status);
  card.innerHTML = `
    <div class="kanban-title"><span class="task-id-badge" title="${t.plane_number ? `Plane: ${escapeHtml(t.plane_number)}` : "Not yet sent to Plane"}">${escapeHtml(t.id)}${t.plane_number ? ` · ${escapeHtml(t.plane_number)}` : ""}</span> ${isBugModuleTask(t) ? "🐛 " : ""}${escapeHtml(t.title)}</div>
    <div class="kanban-meta">
      <span class="row-priority priority-${t.priority || "P3"}">${escapeHtml(t.priority || "P3")}</span>
      ${t.due_date ? `<span class="${isOverdue(t) ? "date-overdue" : ""}">Due ${fmtDate(t.due_date)}</span>` : ""}
      ${t.status === "Cancelled" && t.cancel_reason ? `<span>Reason: ${escapeHtml(clipText(t.cancel_reason, 80))}</span>` : ""}
      ${isStale(t) ? `<span>${ageDays(t)}d old</span>` : ""}
    </div>
    <div class="kanban-actions">
      <button type="button" class="mini-btn open-task">Open</button>
      ${nextStatus ? `<button type="button" class="mini-btn advance-task">${escapeHtml(nextStatus)}</button>` : ""}
      ${!isClosed(t) ? `<button type="button" class="mini-btn cancel-task">Cancel</button>` : ""}
      ${t.plane_url ? `<a href="${escapeHtml(t.plane_url)}" target="_blank" rel="noopener" class="mini-btn plane-mini-link" title="View in Plane">↗ Plane</a>` : ""}
    </div>
  `;
  card.addEventListener("dragstart", e => {
    state.draggedTaskId = t.id;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", t.id);
  });
  card.addEventListener("dragend", () => {
    state.draggedTaskId = "";
    card.classList.remove("dragging");
    document.querySelectorAll(".kanban-col.drag-over").forEach(col => col.classList.remove("drag-over"));
  });
  wirePointerDrag(card, t);
  card.querySelector(".open-task").addEventListener("click", () => {
    state.viewMode = "list";
    localStorage.setItem("taskViewMode", state.viewMode);
    resetFilters();
    state.highlightedTaskId = t.id;
    render();
    document.querySelector(`#board [data-id="${t.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  const advance = card.querySelector(".advance-task");
  if (advance) {
    advance.addEventListener("click", async () => {
      await moveTaskStatus(t, nextStatus);
      render();
    });
  }
  const cancel = card.querySelector(".cancel-task");
  if (cancel) {
    cancel.addEventListener("click", async () => {
      await moveTaskStatus(t, "Cancelled");
      render();
    });
  }
  return card;
}

export function nextWorkflowStatus(status){
  const flow = ["To Do", "In Progress", "In Review", "Pending", "Done"];
  const idx = flow.indexOf(status);
  if (idx < 0 || idx >= flow.length - 1) return "";
  return flow[idx + 1];
}

export function renderActivityFeed(visible){
  const board = document.getElementById("board");
  const visibleIds = new Set(visible.map(t => t.id));
  const rows = recentActivities(80).filter(item => visibleIds.has(item.task.id));
  if (!rows.length) {
    board.innerHTML = '<div class="empty">No activity matches.</div>';
    return;
  }
  rows.forEach(item => {
    const row = document.createElement("article");
    row.className = `feed-item status-card ${statusToneClass(activityStatus(item.activity, item.task) || item.task.status)}`;
    row.innerHTML = `
      <span class="timeline-dot status-${slug(activityStatus(item.activity, item.task) || item.task.status)}"></span>
      <div class="feed-body">
        <div class="feed-top">
          <strong>${escapeHtml(activityLabel(item.activity))}</strong>
          <span>${escapeHtml(activityTime(item.activity))}${item.activity.inferred ? " · inferred" : ""}</span>
        </div>
        <button type="button" class="feed-task">${escapeHtml(item.task.title)}</button>
      </div>
    `;
    row.querySelector(".feed-task").addEventListener("click", () => {
      state.viewMode = "list";
      localStorage.setItem("taskViewMode", state.viewMode);
      resetFilters();
      state.highlightedTaskId = item.task.id;
      render();
      document.querySelector(`#board [data-id="${item.task.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    board.appendChild(row);
  });
}

export function renderStats(){
  const stats = document.getElementById("stats");
  const counts = {};
  state.statuses.forEach(s => counts[s] = 0);
  const activeTasks = state.tasks.filter(t => !t.archived_at);
  activeTasks.forEach(t => { counts[t.status] = (counts[t.status]||0) + 1; });
  stats.innerHTML = state.statuses.map(s =>
    `<div class="stat status-card ${statusToneClass(s)}"><div class="n">${counts[s]||0}</div><div class="l">${s}</div></div>`
  ).join("") + `<div class="stat"><div class="n">${activeTasks.length}</div><div class="l">Active</div></div>`;
  renderFilterCounts();
}

export function renderFilterCounts(){
  const todayIds = new Set(dailyEntries(todayStr()).map(entry => entry.task.id));
  const activeTasks = state.tasks.filter(t => !t.archived_at);
  const countMap = {
    all: activeTasks.length,
    today: todayIds.size,
    overdue: activeTasks.filter(isOverdue).length,
    high: activeTasks.filter(t => ["P1", "P2"].includes(t.priority || "P3")).length,
    stale: activeTasks.filter(isStale).length,
    archived: state.tasks.filter(t => t.archived_at).length,
    review: activeTasks.filter(t => (t.type || "Task") === "Review").length,
    bugmodule: activeTasks.filter(isBugModuleTask).length,
  };
  state.statuses.forEach(status => {
    countMap[status] = activeTasks.filter(t => t.status === status).length;
  });
  document.querySelectorAll(".toolbar .chip").forEach(chip => {
    const filter = chip.dataset.filter;
    const label = CHIP_LABELS[filter] || filter;
    chip.innerHTML = `${escapeHtml(label)} <span class="chip-count">${countMap[filter] || 0}</span>`;
  });
}

export function criteriaListHtml(t){
  const items = t.acceptance_criteria || [];
  if (!items.length) return "";
  return `<ul class="criteria-list">${items.map(c => `<li>${escapeHtml(c)}</li>`).join("")}</ul>`;
}

export function chipFieldHtml(field, values, dlId, chipClass){
  const chips = values.map((v,i) => `<span class="chip-val ${chipClass||""}" data-i="${i}">${escapeHtml(v)}<span class="x">✕</span></span>`).join("");
  return `<div class="chip-field" data-field="${field}">${chips}<input type="text" class="chip-input" list="${dlId}" placeholder="+ add"></div>`;
}

/* local (not-yet-saved) chip field, used by the Add Task form */
export function renderLocalChipField(containerId, inputId, arr){
  const container = document.getElementById(containerId);
  const oldInput = document.getElementById(inputId);
  const inputOuter = oldInput.outerHTML;
  const chipsHtml = arr.map((v,i) => `<span class="chip-val" data-i="${i}">${escapeHtml(v)}<span class="x">✕</span></span>`).join("");
  container.innerHTML = chipsHtml + inputOuter;

  container.querySelectorAll(".chip-val .x").forEach(x => {
    x.addEventListener("click", () => {
      const i = parseInt(x.parentElement.dataset.i, 10);
      arr.splice(i, 1);
      renderLocalChipField(containerId, inputId, arr);
    });
  });

  const input = document.getElementById(inputId);
  const addVal = () => {
    const v = input.value.trim().replace(/,$/, "");
    if (!v) return;
    if (!arr.includes(v)) arr.push(v);
    renderLocalChipField(containerId, inputId, arr);
    document.getElementById(inputId).focus();
  };
  input.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === ","){ e.preventDefault(); addVal(); } });
  input.addEventListener("blur", () => { if (input.value.trim()) addVal(); });
}

export function initAddFormChipFields(){
  renderLocalChipField("newProjectField", "newProjectInput", state.newProjectVals);
  renderLocalChipField("newTagsField", "newTagsInput", state.newTagVals);
  renderLocalChipField("newWhoField", "newWhoInput", state.newWhoVals);
  renderLocalChipField("newAttachField", "newAttachInput", state.newAttachVals);
  renderLocalChipField("newCriteriaField", "newCriteriaInput", state.newCriteriaVals);
}

export function afterChipChange(field){
  populateDatalists();
  if (field === "project") populateProjectFilter();
  if (field === "tags") populateTagFilter();
  render();
}

export function activityTimelineHtml(t){
  const history = [...(Array.isArray(t.activity_history) ? t.activity_history : [])]
    .sort((a,b) => (b.at || b.date || "").localeCompare(a.at || a.date || ""));
  const latest = history[0];
  const expanded = state.historyOpenIds.has(t.id);
  const latestHtml = latest
    ? `<span class="activity-latest">${escapeHtml(activityLabel(latest))}</span><span class="activity-time">${escapeHtml(activityTime(latest))}</span>`
    : `<span class="activity-latest">No activity yet</span>`;
  const timeline = expanded ? `
    <div class="timeline">
      ${history.slice(0, 10).map(a => `
        <div class="timeline-item">
          <span class="timeline-dot status-${slug(activityStatus(a, t) || t.status)}"></span>
          <span class="timeline-body">
            <span class="timeline-label">${escapeHtml(activityLabel(a))}</span>
            <span class="timeline-meta">${escapeHtml(activityTime(a))}${a.inferred ? ' · inferred' : ''}</span>
          </span>
        </div>
      `).join("")}
    </div>
  ` : "";
  return `
    <div class="activity-box ${expanded ? "open" : ""}">
      <button type="button" class="history-toggle">${expanded ? "Hide activity" : `Activity (${history.length})`}</button>
      <div class="activity-summary">${latestHtml}</div>
      ${timeline}
    </div>
  `;
}

export function renderCard(t){
  const card = document.createElement("div");
  const isEditing = state.editingIds.has(t.id);
  card.className = "card"
    + ` status-card ${statusToneClass(t.status)}`
    + (t.status === "Done" ? " done" : "")
    + (t.status === "Cancelled" ? " cancelled" : "")
    + (isEditing ? " editing" : "")
    + (isOverdue(t) ? " overdue" : "")
    + (isStale(t) ? " stale" : "")
    + (t.archived_at ? " archived" : "")
    + (state.highlightedTaskId === t.id ? " highlighted" : "");
  card.dataset.id = t.id;

  const statusHtml = `<select class="status-select status-${slug(t.status)}">${statusOptionsHtml(t.status)}</select>`;

  if (!isEditing){
    renderCardReadOnly(card, t, statusHtml);
  } else {
    renderCardEditing(card, t, statusHtml);
  }

  return card;
}

export function renderCardReadOnly(card, t, statusHtml){
  const attachments = t.attachments || [];
  const attachChipsHtml = attachments.map(a => {
    const isUrl = /^https?:\/\//.test(a);
    return isUrl
      ? `<span class="attach-chip static"><a href="${escapeHtml(a)}" target="_blank" rel="noopener">${escapeHtml(a)}</a></span>`
      : `<span class="attach-chip static">${escapeHtml(a)}</span>`;
  }).join("");
  const attachHtml = `<div class="attach-row">
    ${attachChipsHtml}
    <button type="button" class="add-attach">📎 add attachment</button>
    <button type="button" class="add-comment">💬 add comment</button>
  </div>`;

  card.innerHTML = `
    ${statusHtml}
    <div style="flex:1;min-width:0;">
      <div class="title-row">
        <span class="task-id-badge" title="${t.plane_number ? `Plane: ${escapeHtml(t.plane_number)}` : "Not yet sent to Plane"}">${escapeHtml(t.id)}${t.plane_number ? ` · ${escapeHtml(t.plane_number)}` : ""}</span>
        <span class="title-static">${isBugModuleTask(t) ? "🐛 " : ""}${escapeHtml(t.title)}</span>
        <button type="button" class="ai-assist-btn task-ask-btn" title="Ask AI about this task">🤖</button>
        <button type="button" class="edit-btn">✎ Edit</button>
      </div>
      <div class="task-ask-panel" hidden></div>
      <div class="meta">
        <span class="tag priority priority-${t.priority || "P3"}">${escapeHtml(t.priority || "P3")}</span>
        ${t.type === "Review" ? `<span class="tag type-review">👀 Review</span>` : ""}
        ${(t.project||[]).map(p => `<span class="tag">${escapeHtml(p)}</span>`).join("")}
        ${(t.tags||[]).map(g => `<span class="tag tag-accent">${escapeHtml(g)}</span>`).join("")}
        ${t.start_date ? `<span class="period">▶ ${fmtDate(t.start_date)}</span>` : ""}
        ${t.due_date ? `<span class="period ${isOverdue(t) ? "date-overdue" : ""}">Due ${fmtDate(t.due_date)}</span>` : ""}
        ${t.discussed_from ? `<span class="period">💬 ${fmtRange(t.discussed_from, t.discussed_to)}</span>` : ""}
        ${t.done_at ? `<span class="period date-done">✓ ${fmtDate(t.done_at)}</span>` : ""}
        ${(t.closed_at && t.closed_at !== t.done_at) ? `<span class="period date-closed">🔒 ${fmtDate(t.closed_at)}</span>` : ""}
        ${(t.discussed_with&&t.discussed_with.length) ? `<span class="who">↔ ${t.discussed_with.map(escapeHtml).join(", ")}</span>` : ""}
        ${isStale(t) ? `<span class="period date-stale">${ageDays(t)}d old</span>` : ""}
        ${t.archived_at ? `<span class="period">Archived ${fmtDate(t.archived_at)}</span>` : ""}
      </div>
      ${t.notes ? `<div class="notes-static">${escapeHtml(t.notes)}</div>` : ""}
      ${criteriaListHtml(t)}
      ${t.status === "Cancelled" && t.cancel_reason ? `<div class="cancel-reason-static">Reason: ${escapeHtml(t.cancel_reason)}</div>` : ""}
      ${attachHtml}
      ${planeRowHtml(t)}
      ${activityTimelineHtml(t)}
    </div>
    <button class="del ${t.archived_at ? "restore-btn" : ""}" title="${t.archived_at ? "Restore" : "Delete"}">${t.archived_at ? "↩ Restore" : "✕ Delete"}</button>
  `;

  wireStatusAndDelete(card, t);
  wireHistoryToggle(card, t);
  wirePlaneButton(card, t);
  wireAddComment(card, t);
  wireAddAttachment(card, t);
  wireTaskAsk(card, t);
  card.querySelector(".edit-btn").addEventListener("click", () => {
    state.editingIds.add(t.id);
    render();
  });
}

export function renderCardEditing(card, t, statusHtml){
  const attachments = t.attachments || [];
  const attachHtml = attachments.map((a, i) => {
    const isUrl = /^https?:\/\//.test(a);
    return `<span class="attach-chip">${isUrl ? `<a href="${escapeHtml(a)}" target="_blank" rel="noopener">${escapeHtml(a)}</a>` : `<span>${escapeHtml(a)}</span>`}<span class="x" data-i="${i}">✕</span></span>`;
  }).join("");

  card.innerHTML = `
    ${statusHtml}
    <div style="flex:1;min-width:0;">
      <div class="title-row">
        <span class="task-id-badge" title="${t.plane_number ? `Plane: ${escapeHtml(t.plane_number)}` : "Not yet sent to Plane"}">${escapeHtml(t.id)}${t.plane_number ? ` · ${escapeHtml(t.plane_number)}` : ""}</span>
        <span class="title" contenteditable="true" spellcheck="false">${escapeHtml(t.title)}</span>
        <button type="button" class="ai-assist-btn" title="AI assist">✨</button>
        <button type="button" class="done-edit-btn">✓ Done</button>
      </div>
      <div class="ai-assist-panel" style="display:none"></div>
      <div class="field-row">
        <span class="field-label">Dates</span>
        <div class="date-edit-group">
          <label>Start <input type="date" class="date-in" data-k="start_date" value="${t.start_date||""}"></label>
          <label>Due <input type="date" class="date-in" data-k="due_date" value="${t.due_date||""}"></label>
          <label>Discussed <input type="date" class="date-in" data-k="discussed_from" value="${t.discussed_from||""}"> – <input type="date" class="date-in" data-k="discussed_to" value="${t.discussed_to||""}"></label>
          <label>Done <input type="date" class="date-in" data-k="done_at" value="${t.done_at||""}"></label>
          <label>Closed <input type="date" class="date-in" data-k="closed_at" value="${t.closed_at||""}"></label>
        </div>
      </div>
      <div class="field-row">
        <span class="field-label">Priority</span>
        <select class="priority-select">${priorityOptionsHtml(t.priority || "P3")}</select>
        <select class="type-select">${typeOptionsHtml(t.type || "Task")}</select>
      </div>
      <div class="field-row cancel-reason-row ${t.status === "Cancelled" ? "" : "muted-reason"}">
        <span class="field-label">Cancel reason</span>
        <input type="text" class="cancel-reason-input" value="${escapeHtml(t.cancel_reason || "")}" placeholder="Optional reason">
      </div>
      <div class="field-row">
        <span class="field-label">Project</span>
        ${chipFieldHtml("project", t.project||[], "dl-project")}
      </div>
      <div class="field-row">
        <span class="field-label">Tags</span>
        ${chipFieldHtml("tags", t.tags||[], "dl-tags", "tag-type")}
      </div>
      <div class="field-row">
        <span class="field-label">Stakeholders</span>
        ${chipFieldHtml("discussed_with", t.discussed_with||[], "dl-who", "who-type")}
      </div>
      <div class="notes" contenteditable="true" spellcheck="false">${escapeHtml(t.notes||"")}</div>
      <div class="field-row">
        <span class="field-label">Acceptance criteria</span>
        ${chipFieldHtml("acceptance_criteria", t.acceptance_criteria||[], "", "criteria-type")}
      </div>
      <div class="attach-row">
        ${attachHtml}
        <button type="button" class="add-attach">📎 add attachment</button>
        <button type="button" class="add-comment">💬 add comment</button>
      </div>
      ${planeRowHtml(t)}
      ${activityTimelineHtml(t)}
    </div>
    <button class="del ${t.archived_at ? "restore-btn" : ""}" title="${t.archived_at ? "Restore" : "Delete"}">${t.archived_at ? "↩ Restore" : "✕ Delete"}</button>
  `;

  wireStatusAndDelete(card, t);
  wireHistoryToggle(card, t);
  wirePlaneButton(card, t);
  wireAiAssist(card, t);

  card.querySelector(".done-edit-btn").addEventListener("click", () => {
    state.editingIds.delete(t.id);
    render();
  });

  const titleEl = card.querySelector(".title");
  titleEl.addEventListener("blur", async () => {
    const v = titleEl.textContent.trim();
    if (v !== t.title){ t.title = v; t.updated_at = todayStr(); await patch(t.id, { title: v }); }
  });
  titleEl.addEventListener("keydown", e => { if (e.key === "Enter"){ e.preventDefault(); titleEl.blur(); } });

  card.querySelectorAll(".date-in").forEach(dateInput => {
    dateInput.addEventListener("change", async () => {
      const k = dateInput.dataset.k;
      const v = dateInput.value;
      t[k] = v || null;
      t.updated_at = todayStr();
      await patch(t.id, { [k]: t[k] });
      render();
    });
  });

  card.querySelector(".priority-select").addEventListener("change", async e => {
    t.priority = e.target.value;
    t.updated_at = todayStr();
    await patch(t.id, { priority: t.priority });
    render();
  });

  card.querySelector(".type-select").addEventListener("change", async e => {
    t.type = e.target.value;
    t.updated_at = todayStr();
    await patch(t.id, { type: t.type });
    render();
  });

  card.querySelector(".cancel-reason-input").addEventListener("blur", async e => {
    const v = e.target.value.trim();
    if (v !== (t.cancel_reason || "")){
      t.cancel_reason = v;
      t.updated_at = todayStr();
      await patch(t.id, { cancel_reason: v });
      render();
    }
  });

  wireChipField(card.querySelector('[data-field="project"]'), t, "project");
  wireChipField(card.querySelector('[data-field="tags"]'), t, "tags");
  wireChipField(card.querySelector('[data-field="discussed_with"]'), t, "discussed_with");
  wireChipField(card.querySelector('[data-field="acceptance_criteria"]'), t, "acceptance_criteria");

  const notesEl = card.querySelector(".notes");
  notesEl.addEventListener("blur", async () => {
    const v = notesEl.textContent.trim();
    if (v !== (t.notes||"")){ t.notes = v; t.updated_at = todayStr(); await patch(t.id, { notes: v }); }
  });

  wireAddAttachment(card, t);

  wireAddComment(card, t);

  card.querySelectorAll(".attach-chip .x").forEach(x => {
    x.addEventListener("click", async () => {
      const i = parseInt(x.dataset.i, 10);
      const res = await fetch(`${API}/${t.id}/attachments/${i}`, { method: "DELETE" });
      if (res.ok) {
        const updated = await res.json();
        noticePlaneSyncResult(updated);
        const idx = state.tasks.findIndex(x => x.id === t.id);
        if (idx >= 0) state.tasks[idx] = updated;
      }
      render();
    });
  });
}

export function planeRowHtml(t){
  if (t.plane_url) {
    const cycleHtml = t.plane_cycle_name
      ? (t.plane_cycle_url
          ? `<a href="${escapeHtml(t.plane_cycle_url)}" target="_blank" rel="noopener" class="plane-cycle-tag" title="Open this cycle in Plane">🔁 ${escapeHtml(t.plane_cycle_name)}</a>`
          : `<span class="plane-cycle-tag" title="Plane cycle this was in when first sent">🔁 ${escapeHtml(t.plane_cycle_name)}</span>`)
      : "";
    const moduleHtml = t.plane_module_name
      ? (t.plane_module_url
          ? `<a href="${escapeHtml(t.plane_module_url)}" target="_blank" rel="noopener" class="plane-module-tag" title="Open this module in Plane">🧩 ${escapeHtml(t.plane_module_name)}</a>`
          : `<span class="plane-module-tag" title="Plane module this issue is in">🧩 ${escapeHtml(t.plane_module_name)}</span>`)
      : "";
    return `<div class="plane-row">
      <a href="${escapeHtml(t.plane_url)}" target="_blank" rel="noopener" class="plane-link">↗ View in Plane</a>
      ${cycleHtml}
      ${moduleHtml}
      <button type="button" class="plane-btn plane-update-btn" title="Push this task's current status/priority/dates/notes to Plane">🔄 Update in Plane</button>
    </div>`;
  }
  return `<div class="plane-row"><button type="button" class="plane-btn">📤 Send to Plane</button></div>`;
}

export function setActiveFilter(filter){
  state.activeFilter = filter;
  document.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c.dataset.filter === filter));
  render();
}

export function setViewMode(mode){
  state.viewMode = ["list", "board", "activity"].includes(mode) ? mode : "list";
  localStorage.setItem("taskViewMode", state.viewMode);
  render();
}

export function resetFilters(){
  state.activeFilter = "all";
  state.activeProject = "";
  state.activeTag = "";
  state.activeCycle = "";
  state.dateFrom = "";
  state.dateTo = "";
  state.searchTerm = "";
  document.getElementById("search").value = "";
  document.getElementById("projectFilter").value = "";
  document.getElementById("tagFilter").value = "";
  document.getElementById("cycleFilter").value = "";
  document.getElementById("dateFrom").value = "";
  document.getElementById("dateTo").value = "";
  document.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c.dataset.filter === "all"));
}
