const API = "/api/tasks";
const USER_NAME = "Beastab";
const MONTH_ORDER = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const STATUS_ORDER = { "In Progress": 0, "In Review": 1, "Pending": 2, "To Do": 3, "Done": 4, "Cancelled": 5 };
const STATUS_DOT = { "In Progress": "var(--accent)", "In Review": "var(--review)", "Pending": "var(--warn)", "To Do": "var(--todo)", "Done": "var(--ok)", "Cancelled": "var(--cancel)" };
const PRIORITY_ORDER = { "P1": 0, "P2": 1, "P3": 2, "P4": 3 };
const DAILY_ACTIVITY_TYPES = new Set(["status_changed", "status_snapshot", "reopened", "cancelled"]);
const CLOSED_STATUSES = new Set(["Done", "Cancelled"]);
const ACTIVE_WORK_STATUSES = new Set(["In Progress", "In Review", "Pending"]);
const STALE_DAYS = 7;
const FILTER_LABELS = {
  all: "All tasks",
  today: "Today changed",
  overdue: "Overdue",
  high: "High priority",
  stale: "Stale tasks",
  archived: "Archived",
  review: "Reviews",
};
const CHIP_LABELS = {
  all: "All",
  today: "Today",
  overdue: "Overdue",
  high: "High",
  stale: "Stale",
  archived: "Archived",
  review: "Reviews",
};

let tasks = [];
let statuses = ["To Do", "In Progress", "In Review", "Pending", "Done", "Cancelled"];
let priorities = ["P1", "P2", "P3", "P4"];
let taskTypes = ["Task", "Review"];
let activeFilter = "all";
let activeProject = "";
let activeTag = "";
let dateFrom = "";
let dateTo = "";
let searchTerm = "";
let attentionOpen = true;
let backlogLimit = parseInt(localStorage.getItem("dailyBacklogLimit") || "5", 10);
let historyOpenIds = new Set();
let highlightedTaskId = "";
let viewMode = localStorage.getItem("taskViewMode") || "list";
let updateMode = localStorage.getItem("dailyUpdateMode") || "short";
let draggedTaskId = "";
let pointerDrag = null;

let newProjectVals = [];
let newTagVals = [];
let newWhoVals = [];
let newAttachVals = [];

function slug(s){ return s.replace(/\s+/g, "-"); }
function statusToneClass(status){ return `status-tone-${slug(status || "To Do")}`; }
function localDateStr(d = new Date()){
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayStr(){ return localDateStr(); }
function yesterdayStr(){ const d = new Date(); d.setDate(d.getDate()-1); return localDateStr(d); }

function fmtDate(iso){
  if (!iso) return "";
  const [y,m,d] = iso.split("-").map(Number);
  return new Date(y, m-1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function fmtRange(from, to){
  if (!from) return "";
  if (!to || to === from) return fmtDate(from);
  return `${fmtDate(from)} – ${fmtDate(to)}`;
}
function ageDays(t){
  const start = t.created_at || t.discussed_from || t.updated_at;
  if (!start) return 0;
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((new Date() - d) / 86400000));
}
function isClosed(t){ return CLOSED_STATUSES.has(t.status); }
function isOverdue(t){ return !isClosed(t) && t.due_date && t.due_date < todayStr(); }
function isStale(t){ return !isClosed(t) && (t.updated_at || "") <= localDateStr(new Date(Date.now() - STALE_DAYS * 86400000)); }
function activityStatus(activity, task){
  const candidates = [activity.to, activity.to_status, activity.from_status, activity.from, task.status];
  return candidates.find(value => statuses.includes(value)) || task.status;
}
function activityTime(activity){
  if (!activity.at) return fmtDate(activity.date);
  const d = new Date(activity.at);
  if (Number.isNaN(d.getTime())) return fmtDate(activity.date);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function activityLabel(activity){
  const from = activity.from || activity.from_status || activity.from_value;
  const to = activity.to || activity.to_status || activity.to_value;
  const field = (activity.field || "").replaceAll("_", " ");
  if (activity.type === "created") return "Task created";
  if (activity.type === "status_snapshot") return `Status snapshot: ${to || "Unknown"}`;
  if (activity.type === "status_changed") {
    const base = from ? `Status changed: ${from} -> ${to}` : `Status changed: ${to}`;
    return activity.note ? `${base} — ${activity.note}` : base;
  }
  if (activity.type === "completed") return "Completed";
  if (activity.type === "reopened") return `Reopened: ${from || "Done"} -> ${to || "Open"}`;
  if (activity.type === "date_changed") return `${field || "Date"} changed: ${from || "empty"} -> ${to || "empty"}`;
  if (activity.type === "attachment_added") return `Attachment added: ${activity.label || "file"}`;
  if (activity.type === "attachment_removed") return `Attachment removed: ${activity.label || "file"}`;
  if (activity.type === "archived") return "Archived";
  if (activity.type === "restored") return "Restored";
  if (activity.type === "cancelled") return activity.reason ? `Cancelled: ${activity.reason}` : "Cancelled";
  if (activity.type === "cancel_reason_changed") return to ? `Cancel reason: ${to}` : "Cancel reason cleared";
  return activity.type.replaceAll("_", " ");
}
function recentActivities(limit = 8){
  const rows = [];
  tasks.forEach(task => {
    if (task.archived_at) return;
    const history = Array.isArray(task.activity_history) ? task.activity_history : [];
    history.forEach(activity => rows.push({ task, activity }));
  });
  return rows
    .sort((a,b) => (b.activity.at || b.activity.date || "").localeCompare(a.activity.at || a.activity.date || ""))
    .slice(0, limit);
}
function parseLooseDate(value){
  const v = (value || "").toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date();
  if (v === "today") return localDateStr(d);
  if (v === "tomorrow") {
    d.setDate(d.getDate() + 1);
    return localDateStr(d);
  }
  const plus = v.match(/^(\d+)d$/);
  if (plus) {
    d.setDate(d.getDate() + Number(plus[1]));
    return localDateStr(d);
  }
  return "";
}
function parseQuickInput(raw){
  const result = { title: raw.trim(), priority: "", projects: [], tags: [], due_date: "", start_date: "" };
  const remove = [];
  const tokenRe = /(^|\s)(p[1-4]|#[^\s#@]+|@[^\s#@]+|due:[^\s]+|start:[^\s]+)/gi;
  let match;
  while ((match = tokenRe.exec(raw)) !== null) {
    const token = match[2];
    const lower = token.toLowerCase();
    remove.push(token);
    if (/^p[1-4]$/i.test(token)) result.priority = token.toUpperCase();
    else if (token.startsWith("#")) result.projects.push(token.slice(1).replaceAll("_", " "));
    else if (token.startsWith("@")) result.tags.push(token.slice(1).replaceAll("_", " "));
    else if (lower.startsWith("due:")) result.due_date = parseLooseDate(token.slice(4));
    else if (lower.startsWith("start:")) result.start_date = parseLooseDate(token.slice(6));
  }
  let title = raw;
  remove.forEach(token => {
    title = title.replace(token, " ");
  });
  result.title = title.replace(/\s+/g, " ").trim();
  return result;
}
function uniqueVals(values){
  return [...new Set(values.filter(Boolean))];
}
function quickPreviewHtml(parsed){
  const chips = [];
  if (parsed.priority) chips.push(parsed.priority);
  parsed.projects.forEach(p => chips.push(`#${p}`));
  parsed.tags.forEach(t => chips.push(`@${t}`));
  if (parsed.due_date) chips.push(`Due ${fmtDate(parsed.due_date)}`);
  if (parsed.start_date) chips.push(`Start ${fmtDate(parsed.start_date)}`);
  return chips.map(c => `<span>${escapeHtml(c)}</span>`).join("");
}
function taskMetaLine(t){
  const bits = [];
  if ((t.project || []).length) bits.push((t.project || []).slice(0, 2).join(", "));
  if (t.due_date) bits.push(`Due ${fmtDate(t.due_date)}`);
  if (isStale(t)) bits.push(`${ageDays(t)}d old`);
  return bits.join(" · ");
}
function visibleTaskFilter(t, todayActivityIds){
  if (activeFilter !== "archived" && t.archived_at) return false;
  if (activeFilter === "archived" && !t.archived_at) return false;
  if (statuses.includes(activeFilter) && t.status !== activeFilter) return false;
  if (activeFilter === "today" && !todayActivityIds.has(t.id)) return false;
  if (activeFilter === "overdue" && !isOverdue(t)) return false;
  if (activeFilter === "high" && !["P1", "P2"].includes(t.priority || "P3")) return false;
  if (activeFilter === "stale" && !isStale(t)) return false;
  if (activeFilter === "review" && (t.type || "Task") !== "Review") return false;
  if (activeProject && !(t.project || []).includes(activeProject)) return false;
  if (activeTag && !(t.tags || []).includes(activeTag)) return false;
  if (dateFrom && (t.updated_at || "") < dateFrom) return false;
  if (dateTo && (t.updated_at || "") > dateTo) return false;
  if (searchTerm) {
    const hay = [t.title, t.notes, ...(t.discussed_with||[]), ...(t.project||[]), ...(t.tags||[])].join(" ").toLowerCase();
    if (!hay.includes(searchTerm.toLowerCase())) return false;
  }
  return true;
}

/* ---------- theme ---------- */
function applyTheme(mode){
  const root = document.documentElement;
  if (mode === "system"){
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", mode);
  }
  localStorage.setItem("theme", mode);
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const effective = mode === "system" ? (systemDark ? "dark" : "light") : mode;
  document.getElementById("themeLabel").textContent = effective === "dark" ? "Dark" : "Light";
  document.getElementById("themeToggle").firstChild.textContent = (effective === "dark" ? "🌙 " : "☀️ ");
}

function initTheme(){
  const saved = localStorage.getItem("theme") || "system";
  applyTheme(saved);
}

document.getElementById("themeToggle").addEventListener("click", () => {
  const saved = localStorage.getItem("theme") || "system";
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const effective = saved === "system" ? (systemDark ? "dark" : "light") : saved;
  applyTheme(effective === "dark" ? "light" : "dark");
});

/* ---------- greeting ---------- */
function setGreeting(){
  const h = new Date().getHours();
  const g = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  document.getElementById("greeting").textContent = `${g}, ${USER_NAME} 👋`;
  document.getElementById("todayDate").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

async function loadAll(){
  initTheme();
  setGreeting();
  const [tRes, mRes] = await Promise.all([fetch(API), fetch("/api/meta")]);
  const data = await tRes.json();
  const meta = await mRes.json();
  tasks = data.tasks;
  statuses = meta.statuses;
  priorities = meta.priorities || priorities;
  taskTypes = meta.types || taskTypes;
  populateProjectFilter();
  populateTagFilter();
  populateStatusSelect();
  populatePrioritySelects();
  populateTypeSelect();
  populateDatalists();
  initAddFormChipFields();
  document.getElementById("backlogLimit").value = String(backlogLimit);
  render();
}

function populateDatalists(){
  const map = { project: "dl-project", tags: "dl-tags", discussed_with: "dl-who" };
  Object.entries(map).forEach(([field, dlId]) => {
    const set = new Set();
    tasks.forEach(t => (t[field] || []).forEach(v => set.add(v)));
    document.getElementById(dlId).innerHTML =
      [...set].sort().map(v => `<option value="${escapeHtml(v)}">`).join("");
  });
}

function populateProjectFilter(){
  const sel = document.getElementById("projectFilter");
  const projects = new Set();
  tasks.forEach(t => (t.project || []).forEach(p => projects.add(p)));
  const current = sel.value;
  sel.innerHTML = '<option value="">All projects</option>' +
    [...projects].sort().map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
  sel.value = current;
}

function populateTagFilter(){
  const sel = document.getElementById("tagFilter");
  const tags = new Set();
  tasks.forEach(t => (t.tags || []).forEach(g => tags.add(g)));
  const current = sel.value;
  sel.innerHTML = '<option value="">All tags</option>' +
    [...tags].sort().map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join("");
  sel.value = current;
}

function populateStatusSelect(){
  document.getElementById("newStatus").innerHTML =
    statuses.map(s => `<option value="${s}">${s}</option>`).join("");
}

function populatePrioritySelects(){
  const html = priorities.map(p => `<option value="${p}" ${p==="P3"?"selected":""}>${p}</option>`).join("");
  document.getElementById("newPriority").innerHTML = html;
}

function populateTypeSelect(){
  document.getElementById("newType").innerHTML =
    taskTypes.map(ty => `<option value="${ty}">${ty}</option>`).join("");
}

function statusOptionsHtml(current){
  return statuses.map(s => `<option value="${s}" ${s===current?"selected":""}>${s}</option>`).join("");
}

function priorityOptionsHtml(current){
  return priorities.map(p => `<option value="${p}" ${p===current?"selected":""}>${p}</option>`).join("");
}

function typeOptionsHtml(current){
  return taskTypes.map(ty => `<option value="${ty}" ${ty===current?"selected":""}>${ty}</option>`).join("");
}

function sortedTasksDesc(list){
  return [...list].sort((a,b) => {
    const pa = PRIORITY_ORDER[a.priority || "P3"] ?? 2;
    const pb = PRIORITY_ORDER[b.priority || "P3"] ?? 2;
    if (pa !== pb && a.status !== "Done" && b.status !== "Done") return pa - pb;
    const ma = MONTH_ORDER.indexOf(a.month), mb = MONTH_ORDER.indexOf(b.month);
    if (ma !== mb) return mb - ma;
    const ta = a.updated_ts || a.created_at || a.updated_at || "";
    const tb = b.updated_ts || b.created_at || b.updated_at || "";
    return tb.localeCompare(ta);
  });
}

function backlogTasks(){
  return tasks
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
    .slice(0, Math.max(0, backlogLimit));
}

function statusEventsForDay(t, day){
  const history = Array.isArray(t.activity_history) ? t.activity_history : [];
  return history
    .filter(a => a.date === day && DAILY_ACTIVITY_TYPES.has(a.type))
    .filter(a => {
      const status = activityStatus(a, t);
      return status && !(a.type === "status_snapshot" && a.inferred && status === "To Do");
    })
    .sort((a,b) => (a.at || a.date || "").localeCompare(b.at || b.date || ""));
}

function statusEventsBeforeDay(t, day){
  const history = Array.isArray(t.activity_history) ? t.activity_history : [];
  return history
    .filter(a => (a.date || "") < day && DAILY_ACTIVITY_TYPES.has(a.type))
    .filter(a => activityStatus(a, t))
    .sort((a,b) => (a.at || a.date || "").localeCompare(b.at || b.date || ""));
}

function statusAtEndOfDay(t, day){
  const throughDay = [
    ...statusEventsBeforeDay(t, day),
    ...statusEventsForDay(t, day),
  ];
  const last = throughDay[throughDay.length - 1];
  if (last) return activityStatus(last, t);
  if ((t.created_at || t.discussed_from || t.updated_at || "") <= day) return t.status;
  return "";
}

function previousStatusForDay(t, day){
  const before = statusEventsBeforeDay(t, day);
  const last = before[before.length - 1];
  return last ? activityStatus(last, t) : "";
}

function dailyEntries(day){
  const entries = [];
  tasks.forEach(t => {
    if (t.archived_at) return;
    const candidates = statusEventsForDay(t, day);
    if (!candidates.length) {
      if (t.status !== "To Do" && (t.updated_at === day || t.done_at === day || t.closed_at === day)) {
        entries.push({ task: t, status: t.status, from: previousStatusForDay(t, day), at: t.updated_ts || t.updated_at || day, inferred: true, events: [] });
      }
      return;
    }
    const first = candidates[0];
    const last = candidates[candidates.length - 1];
    const from = first.from_status || first.from || previousStatusForDay(t, day);
    entries.push({
      task: t,
      status: activityStatus(last, t),
      from,
      at: last.at || last.date || day,
      inferred: candidates.some(a => a.inferred),
      events: candidates,
    });
  });
  return entries.sort((a,b) => {
    const sa = STATUS_ORDER[a.status] ?? 9;
    const sb = STATUS_ORDER[b.status] ?? 9;
    if (sa !== sb) return sa - sb;
    return a.at.localeCompare(b.at);
  });
}

function compactTaskRow(t, label){
  const row = document.createElement("button");
  row.type = "button";
  row.className = `task-row status-card ${statusToneClass(label || t.status)}`;
  row.dataset.id = t.id;
  row.innerHTML = `
    <span class="row-status status-${slug(label || t.status)}">${escapeHtml(label || t.status)}</span>
    <span class="row-main">
      <span class="row-title">${t.type === "Review" ? "👀 " : ""}${escapeHtml(t.title)}</span>
      <span class="row-meta">${escapeHtml(taskMetaLine(t) || (t.updated_at ? `Updated ${fmtDate(t.updated_at)}` : ""))}</span>
    </span>
    <span class="row-priority priority-${t.priority || "P3"}">${escapeHtml(t.priority || "P3")}</span>
    ${t.plane_url ? `<span class="row-plane-link" title="View in Plane">↗</span>` : ""}
  `;
  row.addEventListener("click", () => {
    resetFilters();
    highlightedTaskId = t.id;
    render();
    const target = document.querySelector(`#board [data-id="${t.id}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => {
      if (highlightedTaskId === t.id) {
        highlightedTaskId = "";
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
  return row;
}

function compactActivityRow(item){
  const row = document.createElement("button");
  row.type = "button";
  row.className = `activity-row status-card ${statusToneClass(activityStatus(item.activity, item.task) || item.task.status)}`;
  row.dataset.id = item.task.id;
  row.innerHTML = `
    <span class="timeline-dot status-${slug(activityStatus(item.activity, item.task) || item.task.status)}"></span>
    <span class="row-main">
      <span class="row-title">${escapeHtml(activityLabel(item.activity))}</span>
      <span class="row-meta">${escapeHtml(item.task.title)} · ${escapeHtml(activityTime(item.activity))}${item.activity.inferred ? " · inferred" : ""}</span>
    </span>
    ${item.task.plane_url ? `<span class="row-plane-link" title="View in Plane">↗</span>` : ""}
  `;
  row.addEventListener("click", () => {
    resetFilters();
    highlightedTaskId = item.task.id;
    viewMode = "list";
    localStorage.setItem("taskViewMode", viewMode);
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
  return row;
}

function renderPreview(containerId, rows, emptyText){
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  if (!rows.length) {
    container.innerHTML = `<div class="preview-empty">${escapeHtml(emptyText)}</div>`;
    return;
  }
  rows.forEach(row => container.appendChild(row));
}

function renderReview(){
  const todayRows = dailyEntries(todayStr())
    .slice(0, 5)
    .map(entry => compactTaskRow(entry.task, entry.status));
  const backlogRows = backlogTasks()
    .slice(0, 5)
    .map(t => compactTaskRow(t));
  const staleRows = tasks
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

function renderAttention(){
  const open = tasks.filter(t => !t.archived_at && !isClosed(t));
  const list = document.getElementById("attentionList");
  const title = document.getElementById("attentionTitle");
  title.textContent = `Needs attention (${open.length})`;

  if (!attentionOpen){
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

function render(){
  const board = document.getElementById("board");
  board.innerHTML = "";
  const todayActivityIds = new Set(dailyEntries(todayStr()).map(entry => entry.task.id));

  let visible = tasks.filter(t => visibleTaskFilter(t, todayActivityIds));

  renderStats();
  renderReview();
  renderAttention();
  renderViewSwitch();
  renderUpdateModeSwitch();
  if (document.getElementById("updatePreviewWrap")?.classList.contains("open")) refreshUpdatePreview(true);
  const baseTitle = FILTER_LABELS[activeFilter] || activeFilter;
  document.getElementById("boardTitle").textContent = viewMode === "board" ? `${baseTitle} board` : viewMode === "activity" ? "Activity timeline" : baseTitle;
  document.getElementById("resultCount").textContent = `${visible.length} task${visible.length === 1 ? "" : "s"}`;

  if (!visible.length && viewMode !== "activity"){
    board.innerHTML = '<div class="empty">No tasks match.</div>';
    return;
  }

  board.className = viewMode === "board" ? "kanban" : viewMode === "activity" ? "activity-feed" : "";
  if (viewMode === "board") return renderKanban(visible);
  if (viewMode === "activity") return renderActivityFeed(visible);
  renderList(visible);
}

function renderViewSwitch(){
  document.querySelectorAll(".view-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.viewMode === viewMode);
  });
}

function renderUpdateModeSwitch(){
  document.querySelectorAll(".mode-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.updateMode === updateMode);
  });
  const copyBtn = document.getElementById("copyBtn");
  if (copyBtn) copyBtn.textContent = updateMode === "detailed" ? "Copy detailed update" : "Copy short update";
  const previewBtn = document.getElementById("previewUpdateBtn");
  const previewOpen = document.getElementById("updatePreviewWrap")?.classList.contains("open");
  if (previewBtn) previewBtn.textContent = previewOpen ? "Hide preview" : "Show preview";
}

function renderList(visible){
  const board = document.getElementById("board");
  visible = sortedTasksDesc(visible);

  const months = [...new Set(visible.map(t => t.month || "Other"))]
    .sort((a,b) => {
      const ia = MONTH_ORDER.indexOf(a), ib = MONTH_ORDER.indexOf(b);
      return (ib === -1 ? -1 : ib) - (ia === -1 ? -1 : ia);
    });

  months.forEach(month => {
    const group = visible.filter(t => (t.month || "Other") === month);
    const head = document.createElement("div");
    head.className = "month-head";
    head.innerHTML = `<h2>${month}</h2><span class="count">${group.length}</span><div class="line"></div>`;
    board.appendChild(head);
    group.forEach(t => board.appendChild(renderCard(t)));
  });
}

function renderKanban(visible){
  const board = document.getElementById("board");
  const active = visible.filter(t => !t.archived_at);
  statuses.forEach(status => {
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

function wireKanbanDropZone(col, list){
  list.addEventListener("dragover", e => {
    if (!draggedTaskId) return;
    e.preventDefault();
    col.classList.add("drag-over");
  });
  list.addEventListener("dragleave", e => {
    if (!col.contains(e.relatedTarget)) col.classList.remove("drag-over");
  });
  list.addEventListener("drop", async e => {
    e.preventDefault();
    col.classList.remove("drag-over");
    const taskId = e.dataTransfer.getData("text/plain") || draggedTaskId;
    draggedTaskId = "";
    const task = tasks.find(t => t.id === taskId);
    const targetStatus = list.dataset.status;
    if (!task || !targetStatus || task.status === targetStatus) return render();
    const updated = await moveTaskStatus(task, targetStatus);
    if (!updated) return render();
    highlightedTaskId = task.id;
    render();
  });
}

function setDragOverList(list){
  document.querySelectorAll(".kanban-col.drag-over").forEach(col => col.classList.remove("drag-over"));
  if (list) list.closest(".kanban-col")?.classList.add("drag-over");
}

function cleanupPointerDrag(card){
  if (pointerDrag?.ghost) pointerDrag.ghost.remove();
  card.classList.remove("dragging");
  setDragOverList(null);
}

function wirePointerDrag(card, t){
  const startDrag = (e, pointerId = "mouse") => {
    pointerDrag = {
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
    const dx = e.clientX - pointerDrag.startX;
    const dy = e.clientY - pointerDrag.startY;
    if (!pointerDrag.moved && Math.hypot(dx, dy) < 8) return;
    e.preventDefault();
    pointerDrag.moved = true;
    if (!pointerDrag.ghost) {
      pointerDrag.ghost = card.cloneNode(true);
      pointerDrag.ghost.className = `${card.className} kanban-drag-ghost`;
      pointerDrag.ghost.style.width = `${card.getBoundingClientRect().width}px`;
      document.body.appendChild(pointerDrag.ghost);
      card.classList.add("dragging");
    }
    pointerDrag.ghost.style.left = `${e.clientX + 12}px`;
    pointerDrag.ghost.style.top = `${e.clientY + 12}px`;
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest(".kanban-list");
    pointerDrag.overList = over;
    setDragOverList(over);
  };

  const finishDrag = async e => {
    const targetList = pointerDrag.overList;
    const moved = pointerDrag.moved;
    cleanupPointerDrag(card);
    pointerDrag = null;
    if (!moved || !targetList) return;
    const targetStatus = targetList.dataset.status;
    if (!targetStatus || targetStatus === t.status) return render();
    const updated = await moveTaskStatus(t, targetStatus);
    if (updated) highlightedTaskId = t.id;
    render();
  };

  card.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    if (e.target.closest("button,a,select,input,textarea")) return;
    startDrag(e, e.pointerId);
    card.setPointerCapture?.(e.pointerId);
  });

  card.addEventListener("pointermove", e => {
    if (!pointerDrag || pointerDrag.taskId !== t.id || pointerDrag.pointerId !== e.pointerId) return;
    moveDrag(e);
  });

  card.addEventListener("pointerup", async e => {
    if (!pointerDrag || pointerDrag.taskId !== t.id || pointerDrag.pointerId !== e.pointerId) return;
    card.releasePointerCapture?.(e.pointerId);
    await finishDrag(e);
  });

  card.addEventListener("pointercancel", e => {
    if (!pointerDrag || pointerDrag.taskId !== t.id || pointerDrag.pointerId !== e.pointerId) return;
    cleanupPointerDrag(card);
    pointerDrag = null;
  });

  card.addEventListener("mousedown", e => {
    if (pointerDrag || e.button !== 0) return;
    if (e.target.closest("button,a,select,input,textarea")) return;
    startDrag(e);
    const onMove = moveEvent => {
      if (!pointerDrag || pointerDrag.taskId !== t.id || pointerDrag.pointerId !== "mouse") return;
      moveDrag(moveEvent);
    };
    const onUp = async upEvent => {
      window.removeEventListener("mousemove", onMove);
      if (!pointerDrag || pointerDrag.taskId !== t.id || pointerDrag.pointerId !== "mouse") return;
      await finishDrag(upEvent);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, { once: true });
  });
}

function renderKanbanCard(t){
  const card = document.createElement("article");
  card.className = `kanban-card status-card ${statusToneClass(t.status)} ${highlightedTaskId === t.id ? "highlighted" : ""}`;
  card.dataset.id = t.id;
  card.draggable = true;
  const nextStatus = nextWorkflowStatus(t.status);
  card.innerHTML = `
    <div class="kanban-title">${escapeHtml(t.title)}</div>
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
    draggedTaskId = t.id;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", t.id);
  });
  card.addEventListener("dragend", () => {
    draggedTaskId = "";
    card.classList.remove("dragging");
    document.querySelectorAll(".kanban-col.drag-over").forEach(col => col.classList.remove("drag-over"));
  });
  wirePointerDrag(card, t);
  card.querySelector(".open-task").addEventListener("click", () => {
    viewMode = "list";
    localStorage.setItem("taskViewMode", viewMode);
    resetFilters();
    highlightedTaskId = t.id;
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

function nextWorkflowStatus(status){
  const flow = ["To Do", "In Progress", "In Review", "Pending", "Done"];
  const idx = flow.indexOf(status);
  if (idx < 0 || idx >= flow.length - 1) return "";
  return flow[idx + 1];
}

function renderActivityFeed(visible){
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
      viewMode = "list";
      localStorage.setItem("taskViewMode", viewMode);
      resetFilters();
      highlightedTaskId = item.task.id;
      render();
      document.querySelector(`#board [data-id="${item.task.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    board.appendChild(row);
  });
}

function renderStats(){
  const stats = document.getElementById("stats");
  const counts = {};
  statuses.forEach(s => counts[s] = 0);
  const activeTasks = tasks.filter(t => !t.archived_at);
  activeTasks.forEach(t => { counts[t.status] = (counts[t.status]||0) + 1; });
  stats.innerHTML = statuses.map(s =>
    `<div class="stat status-card ${statusToneClass(s)}"><div class="n">${counts[s]||0}</div><div class="l">${s}</div></div>`
  ).join("") + `<div class="stat"><div class="n">${activeTasks.length}</div><div class="l">Active</div></div>`;
  renderFilterCounts();
}

function renderFilterCounts(){
  const todayIds = new Set(dailyEntries(todayStr()).map(entry => entry.task.id));
  const activeTasks = tasks.filter(t => !t.archived_at);
  const countMap = {
    all: activeTasks.length,
    today: todayIds.size,
    overdue: activeTasks.filter(isOverdue).length,
    high: activeTasks.filter(t => ["P1", "P2"].includes(t.priority || "P3")).length,
    stale: activeTasks.filter(isStale).length,
    archived: tasks.filter(t => t.archived_at).length,
    review: activeTasks.filter(t => (t.type || "Task") === "Review").length,
  };
  statuses.forEach(status => {
    countMap[status] = activeTasks.filter(t => t.status === status).length;
  });
  document.querySelectorAll(".toolbar .chip").forEach(chip => {
    const filter = chip.dataset.filter;
    const label = CHIP_LABELS[filter] || filter;
    chip.innerHTML = `${escapeHtml(label)} <span class="chip-count">${countMap[filter] || 0}</span>`;
  });
}

function chipFieldHtml(field, values, dlId, chipClass){
  const chips = values.map((v,i) => `<span class="chip-val ${chipClass||""}" data-i="${i}">${escapeHtml(v)}<span class="x">✕</span></span>`).join("");
  return `<div class="chip-field" data-field="${field}">${chips}<input type="text" class="chip-input" list="${dlId}" placeholder="+ add"></div>`;
}

function wireChipField(fieldEl, t, field){
  if (!fieldEl) return;

  fieldEl.querySelectorAll(".chip-val .x").forEach(x => {
    x.addEventListener("click", async (e) => {
      e.stopPropagation();
      const i = parseInt(x.parentElement.dataset.i, 10);
      t[field] = t[field] || [];
      t[field].splice(i, 1);
      t.updated_at = todayStr();
      await patch(t.id, { [field]: t[field] });
      afterChipChange(field);
    });
  });

  const input = fieldEl.querySelector(".chip-input");
  const addVal = async () => {
    const v = input.value.trim().replace(/,$/, "");
    if (!v) return;
    t[field] = t[field] || [];
    if (!t[field].includes(v)) t[field].push(v);
    t.updated_at = todayStr();
    await patch(t.id, { [field]: t[field] });
    afterChipChange(field);
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === ","){ e.preventDefault(); addVal(); }
  });
  input.addEventListener("blur", () => { if (input.value.trim()) addVal(); });
  input.addEventListener("click", e => e.stopPropagation());
}

/* local (not-yet-saved) chip field, used by the Add Task form */
function renderLocalChipField(containerId, inputId, arr){
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

function initAddFormChipFields(){
  renderLocalChipField("newProjectField", "newProjectInput", newProjectVals);
  renderLocalChipField("newTagsField", "newTagsInput", newTagVals);
  renderLocalChipField("newWhoField", "newWhoInput", newWhoVals);
  renderLocalChipField("newAttachField", "newAttachInput", newAttachVals);
}

function afterChipChange(field){
  populateDatalists();
  if (field === "project") populateProjectFilter();
  if (field === "tags") populateTagFilter();
  render();
}

const editingIds = new Set();

function activityTimelineHtml(t){
  const history = [...(Array.isArray(t.activity_history) ? t.activity_history : [])]
    .sort((a,b) => (b.at || b.date || "").localeCompare(a.at || a.date || ""));
  const latest = history[0];
  const expanded = historyOpenIds.has(t.id);
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

function renderCard(t){
  const card = document.createElement("div");
  const isEditing = editingIds.has(t.id);
  card.className = "card"
    + ` status-card ${statusToneClass(t.status)}`
    + (t.status === "Done" ? " done" : "")
    + (t.status === "Cancelled" ? " cancelled" : "")
    + (isEditing ? " editing" : "")
    + (isOverdue(t) ? " overdue" : "")
    + (isStale(t) ? " stale" : "")
    + (t.archived_at ? " archived" : "")
    + (highlightedTaskId === t.id ? " highlighted" : "");
  card.dataset.id = t.id;

  const statusHtml = `<select class="status-select status-${slug(t.status)}">${statusOptionsHtml(t.status)}</select>`;

  if (!isEditing){
    renderCardReadOnly(card, t, statusHtml);
  } else {
    renderCardEditing(card, t, statusHtml);
  }

  return card;
}

function renderCardReadOnly(card, t, statusHtml){
  const attachments = t.attachments || [];
  const attachHtml = attachments.length
    ? `<div class="attach-row">${attachments.map(a => {
        const isUrl = /^https?:\/\//.test(a);
        return isUrl
          ? `<span class="attach-chip static"><a href="${escapeHtml(a)}" target="_blank" rel="noopener">${escapeHtml(a)}</a></span>`
          : `<span class="attach-chip static">${escapeHtml(a)}</span>`;
      }).join("")}</div>`
    : "";

  card.innerHTML = `
    ${statusHtml}
    <div style="flex:1;min-width:0;">
      <div class="title-row">
        <span class="title-static">${escapeHtml(t.title)}</span>
        <button type="button" class="edit-btn">✎ Edit</button>
      </div>
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
  card.querySelector(".edit-btn").addEventListener("click", () => {
    editingIds.add(t.id);
    render();
  });
}

function renderCardEditing(card, t, statusHtml){
  const attachments = t.attachments || [];
  const attachHtml = attachments.map((a, i) => {
    const isUrl = /^https?:\/\//.test(a);
    return `<span class="attach-chip">${isUrl ? `<a href="${escapeHtml(a)}" target="_blank" rel="noopener">${escapeHtml(a)}</a>` : `<span>${escapeHtml(a)}</span>`}<span class="x" data-i="${i}">✕</span></span>`;
  }).join("");

  card.innerHTML = `
    ${statusHtml}
    <div style="flex:1;min-width:0;">
      <div class="title-row">
        <span class="title" contenteditable="true" spellcheck="false">${escapeHtml(t.title)}</span>
        <button type="button" class="done-edit-btn">✓ Done</button>
      </div>
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
      <div class="attach-row">
        ${attachHtml}
        <button type="button" class="add-attach">📎 add attachment</button>
      </div>
      ${planeRowHtml(t)}
      ${activityTimelineHtml(t)}
    </div>
    <button class="del ${t.archived_at ? "restore-btn" : ""}" title="${t.archived_at ? "Restore" : "Delete"}">${t.archived_at ? "↩ Restore" : "✕ Delete"}</button>
  `;

  wireStatusAndDelete(card, t);
  wireHistoryToggle(card, t);
  wirePlaneButton(card, t);

  card.querySelector(".done-edit-btn").addEventListener("click", () => {
    editingIds.delete(t.id);
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

  const notesEl = card.querySelector(".notes");
  notesEl.addEventListener("blur", async () => {
    const v = notesEl.textContent.trim();
    if (v !== (t.notes||"")){ t.notes = v; t.updated_at = todayStr(); await patch(t.id, { notes: v }); }
  });

  card.querySelector(".add-attach").addEventListener("click", async () => {
    const val = await askText({
      title: "Add attachment",
      placeholder: "Paste a link or file path",
      confirmText: "Add attachment",
    });
    if (!val || !val.trim()) return;
    t.attachments = t.attachments || [];
    t.attachments.push(val.trim());
    t.updated_at = todayStr();
    const res = await fetch(`${API}/${t.id}/attachments`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: val.trim() }),
    });
    if (res.ok) {
      const updated = await res.json();
      noticePlaneSyncResult(updated);
      const idx = tasks.findIndex(x => x.id === t.id);
      if (idx >= 0) tasks[idx] = updated;
    }
    render();
  });

  card.querySelectorAll(".attach-chip .x").forEach(x => {
    x.addEventListener("click", async () => {
      const i = parseInt(x.dataset.i, 10);
      const res = await fetch(`${API}/${t.id}/attachments/${i}`, { method: "DELETE" });
      if (res.ok) {
        const updated = await res.json();
        noticePlaneSyncResult(updated);
        const idx = tasks.findIndex(x => x.id === t.id);
        if (idx >= 0) tasks[idx] = updated;
      }
      render();
    });
  });
}

function wireHistoryToggle(card, t){
  const btn = card.querySelector(".history-toggle");
  if (!btn) return;
  btn.addEventListener("click", e => {
    e.stopPropagation();
    if (historyOpenIds.has(t.id)) historyOpenIds.delete(t.id);
    else historyOpenIds.add(t.id);
    render();
  });
}

function planeRowHtml(t){
  if (t.plane_url) {
    return `<div class="plane-row">
      <a href="${escapeHtml(t.plane_url)}" target="_blank" rel="noopener" class="plane-link">↗ View in Plane</a>
      <button type="button" class="plane-btn plane-update-btn" title="Push this task's current status/priority/dates/notes to Plane">🔄 Update in Plane</button>
    </div>`;
  }
  return `<div class="plane-row"><button type="button" class="plane-btn">📤 Send to Plane</button></div>`;
}

function wirePlaneButton(card, t){
  const btn = card.querySelector(".plane-btn:not(.plane-update-btn)");
  if (btn) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Sending…";
      try {
        let res = await fetch(`${API}/${t.id}/plane`, { method: "POST" });
        let data = await res.json();
        if ((!res.ok || data.error) && await offerPlaneCredsFix(data.error)) {
          // cookie fixed inline — retry once
          res = await fetch(`${API}/${t.id}/plane`, { method: "POST" });
          data = await res.json();
        }
        if (!res.ok || data.error) {
          btn.disabled = false;
          btn.textContent = "📤 Send to Plane";
          return;
        }
        t.plane_issue_id = data.plane_issue_id;
        t.plane_url = data.plane_url;
        showToast("Sent to Plane ✓");
        render();
      } catch (err) {
        showToast("Failed to send to Plane");
        btn.disabled = false;
        btn.textContent = "📤 Send to Plane";
      }
    });
  }

  const updateBtn = card.querySelector(".plane-update-btn");
  if (updateBtn) {
    updateBtn.addEventListener("click", async () => {
      updateBtn.disabled = true;
      updateBtn.textContent = "Updating…";
      try {
        let res = await fetch(`${API}/${t.id}/plane-update`, { method: "POST" });
        let data = await res.json();
        if ((!res.ok || data.error) && await offerPlaneCredsFix(data.error)) {
          // cookie fixed inline — retry once
          res = await fetch(`${API}/${t.id}/plane-update`, { method: "POST" });
          data = await res.json();
        }
        if (res.ok && !data.error) showToast("Plane updated ✓");
      } catch (err) {
        showToast("Failed to update Plane");
      }
      updateBtn.disabled = false;
      updateBtn.textContent = "🔄 Update in Plane";
    });
  }
}

function wireStatusAndDelete(card, t){
  const statusSel = card.querySelector(".status-select");
  statusSel.addEventListener("change", async () => {
    const updated = await moveTaskStatus(t, statusSel.value);
    if (!updated) statusSel.value = t.status;
    render();
  });

  card.querySelector(".del").addEventListener("click", async () => {
    if (t.archived_at) {
      const restored = await patch(t.id, { archived_at: null });
      Object.assign(t, restored);
      showToast("Task restored");
    } else {
      const ok = await askConfirm({
        title: "Delete this task?",
        message: t.title,
        confirmText: "Delete",
      });
      if (!ok) return;
      const res = await fetch(`${API}/${t.id}`, { method: "DELETE" });
      if (!res.ok) return showToast("Archive failed");
      const archived = await res.json();
      noticePlaneSyncResult(archived);
      const idx = tasks.findIndex(x => x.id === t.id);
      if (idx >= 0) tasks[idx] = archived;
      editingIds.delete(t.id);
      showToast("Task archived");
    }
    populateProjectFilter();
    populateTagFilter();
    render();
  });
}

function escapeHtml(s){
  return (s||"").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
}

// If a task is already linked to Plane, the backend auto-syncs this edit there on its own
// (see sync_plane_on_activity in server.py) — nothing to trigger here. We only need to surface
// it when that auto-sync failed (e.g. expired cookie), as a quiet heads-up; success stays silent
// so routine edits don't get noisy.
function noticePlaneSyncResult(updated){
  if (updated && updated._plane_sync_error) {
    showToast(`Plane sync failed: ${updated._plane_sync_error}`);
  }
}

async function patch(id, body){
  const res = await fetch(`${API}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    showToast("Update failed");
    return null;
  }
  const updated = await res.json();
  noticePlaneSyncResult(updated);
  const idx = tasks.findIndex(t => t.id === id);
  if (idx >= 0) tasks[idx] = updated;
  return updated;
}

async function moveTaskStatus(t, newStatus){
  if (!newStatus || newStatus === t.status) return t;
  const body = { status: newStatus };
  if (newStatus === "Cancelled") {
    const reason = await askText({
      title: "Cancel task",
      placeholder: "Reason (optional)",
      initial: t.cancel_reason || "",
      confirmText: "Move to Cancelled",
    });
    if (reason === null) return null;
    body.cancel_reason = reason;
    body.status_note = reason;
  } else {
    const note = await askText({
      title: `Update for moving to ${newStatus}`,
      placeholder: "What's the update? (optional)",
      confirmText: `Move to ${newStatus}`,
    });
    if (note === null) return null;
    if (note) body.status_note = note;
  }
  const updated = await patch(t.id, body);
  if (updated) showToast(`Moved to ${newStatus}`);
  return updated;
}

async function copyText(text){
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (err) {
      // Fall through to the textarea path for browsers that expose but deny clipboard writes.
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(ta);
  if (!ok) throw new Error("copy failed");
}

// Queued rather than clobbering: a Plane-sync warning can now land right alongside a normal
// action toast (e.g. "Moved to In Progress"), and both need to actually be seen.
let toastQueue = [];
let toastShowing = false;
function showToast(msg){
  toastQueue.push(msg);
  if (!toastShowing) drainToastQueue();
}
function drainToastQueue(){
  const msg = toastQueue.shift();
  if (msg === undefined) { toastShowing = false; return; }
  toastShowing = true;
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(drainToastQueue, 150);
  }, 1800);
}

function askText({ title, placeholder = "", initial = "", confirmText = "Save" }){
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
      <form class="text-modal">
        <h2>${escapeHtml(title)}</h2>
        <input type="text" class="modal-input" value="${escapeHtml(initial)}" placeholder="${escapeHtml(placeholder)}">
        <div class="modal-actions">
          <button type="button" class="btn ghost modal-cancel">Cancel</button>
          <button type="submit" class="btn">${escapeHtml(confirmText)}</button>
        </div>
      </form>
    `;
    const close = value => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = e => {
      if (e.key === "Escape") close(null);
    };
    overlay.addEventListener("click", e => {
      if (e.target === overlay) close(null);
    });
    overlay.querySelector(".modal-cancel").addEventListener("click", () => close(null));
    overlay.querySelector("form").addEventListener("submit", e => {
      e.preventDefault();
      close(overlay.querySelector(".modal-input").value.trim());
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    overlay.querySelector(".modal-input").focus();
  });
}

function askConfirm({ title, message = "", confirmText = "Delete", danger = true }){
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
      <div class="text-modal confirm-modal">
        <h2>${escapeHtml(title)}</h2>
        ${message ? `<p class="confirm-message">${escapeHtml(message)}</p>` : ""}
        <div class="modal-actions">
          <button type="button" class="btn ghost modal-cancel">Cancel</button>
          <button type="button" class="btn ${danger ? "btn-danger" : ""} modal-confirm">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;
    const close = value => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = e => {
      if (e.key === "Escape") close(false);
      if (e.key === "Enter") close(true);
    };
    overlay.addEventListener("click", e => { if (e.target === overlay) close(false); });
    overlay.querySelector(".modal-cancel").addEventListener("click", () => close(false));
    overlay.querySelector(".modal-confirm").addEventListener("click", () => close(true));
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    overlay.querySelector(".modal-confirm").focus();
  });
}

function askTextarea({ title, placeholder = "", helpText = "", confirmText = "Save" }){
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
      <form class="text-modal">
        <h2>${escapeHtml(title)}</h2>
        ${helpText ? `<p class="confirm-message">${escapeHtml(helpText)}</p>` : ""}
        <textarea class="modal-textarea" placeholder="${escapeHtml(placeholder)}" rows="6"></textarea>
        <div class="modal-actions">
          <button type="button" class="btn ghost modal-cancel">Cancel</button>
          <button type="submit" class="btn">${escapeHtml(confirmText)}</button>
        </div>
      </form>
    `;
    const close = value => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = e => { if (e.key === "Escape") close(null); };
    overlay.addEventListener("click", e => { if (e.target === overlay) close(null); });
    overlay.querySelector(".modal-cancel").addEventListener("click", () => close(null));
    overlay.querySelector("form").addEventListener("submit", e => {
      e.preventDefault();
      close(overlay.querySelector(".modal-textarea").value.trim());
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    overlay.querySelector(".modal-textarea").focus();
  });
}

// One modal for both first-time setup and refreshing an expired cookie. Workspace/project id
// are pre-filled from whatever's already saved, so a returning user pasting a fresh cookie
// usually just has to paste and hit save — nothing to re-type. Everything discovered (states,
// status map, assignee id) is filled in automatically server-side once cookie+workspace+project
// are known; see discover_plane_setup in server.py.
function askPlaneSetup({ cookie = "", workspace = "", projectId = "" } = {}){
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
      <form class="text-modal">
        <h2>Connect to Plane</h2>
        <p class="confirm-message">Paste a Cookie header from a logged-in Plane request (a whole "Copy as cURL" works too — we'll pull the cookie out of it), plus your workspace slug and project id. Your Plane user id and this project's statuses are auto-detected — nothing else to configure by hand.</p>
        <label class="modal-label">Cookie</label>
        <textarea class="modal-textarea plane-cookie-input" placeholder="Cookie header value, or a whole curl command" rows="5">${escapeHtml(cookie)}</textarea>
        <label class="modal-label">Workspace slug</label>
        <input type="text" class="modal-input plane-workspace-input" value="${escapeHtml(workspace)}" placeholder="e.g. alt-mobility">
        <label class="modal-label">Project ID</label>
        <input type="text" class="modal-input plane-project-input" value="${escapeHtml(projectId)}" placeholder="Project UUID, from the project's Plane URL">
        <div class="modal-actions">
          <button type="button" class="btn ghost modal-cancel">Cancel</button>
          <button type="submit" class="btn">Save &amp; connect</button>
        </div>
      </form>
    `;
    const close = value => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = e => { if (e.key === "Escape") close(null); };
    overlay.addEventListener("click", e => { if (e.target === overlay) close(null); });
    overlay.querySelector(".modal-cancel").addEventListener("click", () => close(null));
    overlay.querySelector("form").addEventListener("submit", e => {
      e.preventDefault();
      close({
        cookie: overlay.querySelector(".plane-cookie-input").value.trim(),
        workspace: overlay.querySelector(".plane-workspace-input").value.trim(),
        project_id: overlay.querySelector(".plane-project-input").value.trim(),
      });
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    overlay.querySelector(".plane-cookie-input").focus();
  });
}

async function openPlaneCookiePrompt(){
  let existing = {};
  try {
    existing = await (await fetch("/api/plane-config")).json();
  } catch (err) { /* fresh install / not reachable yet — blank form is fine */ }

  const result = await askPlaneSetup({
    workspace: existing.workspace || "",
    projectId: existing.project_id || "",
  });
  if (!result || !result.cookie) return false;
  if (!result.workspace || !result.project_id) {
    showToast("Workspace slug and project id are both required");
    return false;
  }

  const res = await fetch("/api/plane-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cookie: result.cookie, workspace: result.workspace, project_id: result.project_id }),
  });
  const data = await res.json();
  if (data.discovery && data.discovery.ok) {
    showToast(`Plane connected ✓ — ${data.discovery.state_count} statuses mapped, signed in as ${data.discovery.assignee_email}`);
  } else if (data.discovery && data.discovery.error) {
    showToast(`Cookie saved, but auto-detect failed: ${data.discovery.error}`);
  } else {
    showToast(data.configured ? "Plane connected ✓" : "Failed to save");
  }
  return !!data.configured;
}

function isPlaneCredsError(msg){
  msg = (msg || "").toLowerCase();
  return msg.includes("not configured") || msg.includes("401") || msg.includes("credentials") || msg.includes("authentication");
}

// Shows the error, and if it looks like an expired/missing Plane cookie, offers to fix it right there.
// Returns true if the cookie was updated (caller can retry the action once), false otherwise.
async function offerPlaneCredsFix(errMsg){
  showToast(errMsg || "Plane action failed");
  if (!isPlaneCredsError(errMsg)) return false;
  const wantsFix = await askConfirm({
    title: "Plane session expired",
    message: "Your saved Plane cookie looks expired or missing. Paste a fresh one now?",
    confirmText: "Update cookie",
    danger: false,
  });
  if (!wantsFix) return false;
  return await openPlaneCookiePrompt();
}

document.getElementById("planeSettingsBtn").addEventListener("click", openPlaneCookiePrompt);

document.querySelectorAll(".chip").forEach(chip => {
  chip.addEventListener("click", () => {
    setActiveFilter(chip.dataset.filter);
  });
});

document.querySelectorAll("[data-jump-filter]").forEach(btn => {
  btn.addEventListener("click", () => setActiveFilter(btn.dataset.jumpFilter));
});

document.querySelectorAll("[data-view-mode]").forEach(btn => {
  btn.addEventListener("click", () => setViewMode(btn.dataset.viewMode));
});

document.querySelectorAll("[data-update-mode]").forEach(btn => {
  btn.addEventListener("click", () => {
    updateMode = btn.dataset.updateMode === "detailed" ? "detailed" : "short";
    localStorage.setItem("dailyUpdateMode", updateMode);
    renderUpdateModeSwitch();
    if (document.getElementById("updatePreviewWrap").classList.contains("open")) refreshUpdatePreview(true);
  });
});

function setActiveFilter(filter){
  activeFilter = filter;
  document.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c.dataset.filter === filter));
  render();
}

function setViewMode(mode){
  viewMode = ["list", "board", "activity"].includes(mode) ? mode : "list";
  localStorage.setItem("taskViewMode", viewMode);
  render();
}

function resetFilters(){
  activeFilter = "all";
  activeProject = "";
  activeTag = "";
  dateFrom = "";
  dateTo = "";
  searchTerm = "";
  document.getElementById("search").value = "";
  document.getElementById("projectFilter").value = "";
  document.getElementById("tagFilter").value = "";
  document.getElementById("dateFrom").value = "";
  document.getElementById("dateTo").value = "";
  document.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c.dataset.filter === "all"));
}

document.getElementById("projectFilter").addEventListener("change", e => {
  activeProject = e.target.value;
  render();
});

document.getElementById("tagFilter").addEventListener("change", e => {
  activeTag = e.target.value;
  render();
});

document.getElementById("dateFrom").addEventListener("change", e => { dateFrom = e.target.value; render(); });
document.getElementById("dateTo").addEventListener("change", e => { dateTo = e.target.value; render(); });
document.getElementById("clearFilters").addEventListener("click", () => {
  resetFilters();
  highlightedTaskId = "";
  render();
});

document.getElementById("exportExcelBtn").addEventListener("click", () => {
  const params = new URLSearchParams();
  if (statuses.includes(activeFilter)) params.set("status", activeFilter);
  else if (activeFilter !== "all") params.set("filter", activeFilter);
  if (activeProject) params.set("project", activeProject);
  if (activeTag) params.set("tag", activeTag);
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo) params.set("dateTo", dateTo);
  if (searchTerm) params.set("search", searchTerm);
  const url = `/api/export?${params.toString()}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
  const scope = params.toString() ? "filtered" : "all";
  showToast(`Exporting ${scope} tasks…`);
});

document.getElementById("backlogLimit").addEventListener("change", e => {
  backlogLimit = Math.max(0, Math.min(20, parseInt(e.target.value || "5", 10)));
  e.target.value = String(backlogLimit);
  localStorage.setItem("dailyBacklogLimit", String(backlogLimit));
  render();
});

document.getElementById("search").addEventListener("input", e => {
  searchTerm = e.target.value;
  render();
});

document.getElementById("quickTitle").addEventListener("input", e => {
  document.getElementById("quickPreview").innerHTML = quickPreviewHtml(parseQuickInput(e.target.value));
});

document.getElementById("attentionToggle").addEventListener("click", () => {
  attentionOpen = !attentionOpen;
  renderAttention();
});

document.getElementById("moreOptionsBtn").addEventListener("click", () => {
  document.getElementById("moreOptions").classList.toggle("open");
});
document.getElementById("cancelAdd") && document.getElementById("cancelAdd").addEventListener("click", () => {
  document.getElementById("moreOptions").classList.remove("open");
});

document.getElementById("addForm").addEventListener("submit", async e => {
  e.preventDefault();
  const parsed = parseQuickInput(document.getElementById("quickTitle").value);
  const title = parsed.title;
  if (!title) return;
  const body = {
    title,
    project: uniqueVals([...newProjectVals, ...parsed.projects]),
    tags: uniqueVals([...newTagVals, ...parsed.tags]),
    discussed_with: newWhoVals,
    attachments: newAttachVals,
    discussed_from: document.getElementById("newDiscussedFrom").value || todayStr(),
    discussed_to: document.getElementById("newDiscussedTo").value || "",
    status: document.getElementById("newStatus").value,
    priority: parsed.priority || document.getElementById("newPriority").value,
    type: document.getElementById("newType").value,
    start_date: parsed.start_date || document.getElementById("newStartDate").value || null,
    due_date: parsed.due_date || document.getElementById("newDueDate").value || null,
    notes: document.getElementById("newNotes").value,
    cancel_reason: document.getElementById("newCancelReason").value,
  };
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const created = await res.json();
  tasks.push(created);
  document.getElementById("addForm").reset();
  document.getElementById("moreOptions").classList.remove("open");
  newProjectVals = []; newTagVals = []; newWhoVals = []; newAttachVals = [];
  initAddFormChipFields();
  document.getElementById("quickPreview").innerHTML = "";
  populateProjectFilter();
  populateTagFilter();
  populateDatalists();
  render();
  showToast("Task added");
});

function clipText(text, max = 220){
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 3)}...`;
}

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

function buildUpdateContext(){
  const today = todayStr();
  const yesterday = yesterdayStr();
  const yesterdayEntries = dailyEntries(yesterday);
  const todayEntries = dailyEntries(today);
  const todayById = new Map(todayEntries.map(entry => [entry.task.id, entry]));

  const yesterdayCarry = tasks
    .filter(t => !t.archived_at && ACTIVE_WORK_STATUSES.has(statusAtEndOfDay(t, yesterday)))
    .sort((a,b) => (STATUS_ORDER[statusAtEndOfDay(a, yesterday)] ?? 9) - (STATUS_ORDER[statusAtEndOfDay(b, yesterday)] ?? 9))
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
  const currentActive = tasks
    .filter(t => !t.archived_at && ACTIVE_WORK_STATUSES.has(t.status))
    .sort((a,b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9))
    .map(t => formatUpdateTask(todayById.get(t.id) || { task: t, status: t.status, from: previousStatusForDay(t, today) }));
  const otherToday = todayEntries
    .filter(entry => !["Done", "Cancelled"].includes(entry.status) && !ACTIVE_WORK_STATUSES.has(entry.status))
    .map(entry => formatUpdateTask(entry));
  const backlogRows = backlogTasks().map(t => formatUpdateTask(t));

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
    rawCurrentActive: tasks
      .filter(t => !t.archived_at && ACTIVE_WORK_STATUSES.has(t.status))
      .sort((a,b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)),
    rawBacklog: backlogTasks(),
    rawCancelledToday: todayEntries.filter(entry => entry.status === "Cancelled").map(entry => entry.task),
    rawCompletedToday: todayEntries.filter(entry => entry.status === "Done").map(entry => entry.task),
    rawCompletedYesterday: yesterdayEntries.filter(entry => entry.status === "Done").map(entry => entry.task),
  };
}

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
    `Backlog focus (top ${backlogLimit})`,
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

function buildDailyUpdateText(mode = updateMode){
  const context = buildUpdateContext();
  return mode === "detailed" ? buildDetailedUpdateText(context) : buildShortUpdateText(context);
}

function refreshUpdatePreview(open = false){
  const preview = document.getElementById("updatePreview");
  const wrap = document.getElementById("updatePreviewWrap");
  preview.textContent = buildDailyUpdateText();
  wrap.classList.toggle("open", open || wrap.classList.contains("open"));
  renderUpdateModeSwitch();
}

document.getElementById("copyBtn").addEventListener("click", () => {
  const text = buildDailyUpdateText();
  refreshUpdatePreview(false);
  copyText(text).then(() => showToast("Copied daily update ✓")).catch(() => {
    console.log(text);
    showToast("Copy failed; update logged");
  });
});

document.getElementById("previewUpdateBtn").addEventListener("click", () => {
  const preview = document.getElementById("updatePreviewWrap");
  const nextOpen = !preview.classList.contains("open");
  refreshUpdatePreview(nextOpen);
});

document.getElementById("closeUpdatePreview").addEventListener("click", () => {
  document.getElementById("updatePreviewWrap").classList.remove("open");
  renderUpdateModeSwitch();
});

loadAll();
