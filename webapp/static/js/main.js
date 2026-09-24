import { state, API, USER_NAME } from "./state.js";
import { todayStr, parseQuickInput, quickPreviewHtml, uniqueVals, copyText, stripMarkdown } from "./utils.js";
import { showToast } from "./notifications.js";
import { aiGenerate } from "./ai.js";
import { sendTaskToPlane, maybeAutoSyncCycles } from "./plane.js";
import {
  render, renderAttention, resetFilters, populateProjectFilter, populateTagFilter,
  populateCycleFilter, populateStatusSelect, populatePrioritySelects, populateTypeSelect,
  populateDatalists, initAddFormChipFields, renderUpdateModeSwitch, setActiveFilter, setViewMode,
} from "./views.js";
import { buildDailyUpdateText, refreshUpdatePreview, lastAiText, setLastAiText } from "./updates.js";
import { wireAskAI } from "./agent.js";
import { wireAiFill } from "./aifill.js";

/* ---------- theme ---------- */
export function applyTheme(mode){
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

export function initTheme(){
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
export function setGreeting(){
  const h = new Date().getHours();
  const g = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  document.getElementById("greeting").textContent = `${g}, ${USER_NAME} 👋`;
  document.getElementById("todayDate").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

export async function loadAll(){
  initTheme();
  setGreeting();
  const [tRes, mRes] = await Promise.all([fetch(API), fetch("/api/meta")]);
  const data = await tRes.json();
  const meta = await mRes.json();
  state.tasks = data.tasks;
  state.statuses = meta.statuses;
  state.priorities = meta.priorities || state.priorities;
  state.taskTypes = meta.types || state.taskTypes;
  populateProjectFilter();
  populateTagFilter();
  populateCycleFilter();
  populateStatusSelect();
  populatePrioritySelects();
  populateTypeSelect();
  populateDatalists();
  initAddFormChipFields();
  document.getElementById("backlogLimit").value = String(state.backlogLimit);
  render();
}

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
    state.updateMode = ["morning", "evening", "detailed", "speak"].includes(btn.dataset.updateMode) ? btn.dataset.updateMode : "detailed";
    localStorage.setItem("dailyUpdateMode", state.updateMode);
    setLastAiText(null);
    renderUpdateModeSwitch();
    if (document.getElementById("updatePreviewWrap").classList.contains("open")) refreshUpdatePreview(true);
  });
});

document.getElementById("projectFilter").addEventListener("change", e => {
  state.activeProject = e.target.value;
  render();
});

document.getElementById("tagFilter").addEventListener("change", e => {
  state.activeTag = e.target.value;
  render();
});

document.getElementById("cycleFilter").addEventListener("change", e => {
  state.activeCycle = e.target.value;
  render();
});

document.getElementById("dateFrom").addEventListener("change", e => { state.dateFrom = e.target.value; render(); });
document.getElementById("dateTo").addEventListener("change", e => { state.dateTo = e.target.value; render(); });
document.getElementById("clearFilters").addEventListener("click", () => {
  resetFilters();
  state.highlightedTaskId = "";
  render();
});

document.getElementById("exportExcelBtn").addEventListener("click", () => {
  const params = new URLSearchParams();
  if (state.statuses.includes(state.activeFilter)) params.set("status", state.activeFilter);
  else if (state.activeFilter !== "all") params.set("filter", state.activeFilter);
  if (state.activeProject) params.set("project", state.activeProject);
  if (state.activeTag) params.set("tag", state.activeTag);
  if (state.dateFrom) params.set("dateFrom", state.dateFrom);
  if (state.dateTo) params.set("dateTo", state.dateTo);
  if (state.searchTerm) params.set("search", state.searchTerm);
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
  state.backlogLimit = Math.max(0, Math.min(20, parseInt(e.target.value || "5", 10)));
  e.target.value = String(state.backlogLimit);
  localStorage.setItem("dailyBacklogLimit", String(state.backlogLimit));
  render();
});

document.getElementById("search").addEventListener("input", e => {
  state.searchTerm = e.target.value;
  render();
});

document.getElementById("quickTitle").addEventListener("input", e => {
  document.getElementById("quickPreview").innerHTML = quickPreviewHtml(parseQuickInput(e.target.value));
});

document.getElementById("attentionToggle").addEventListener("click", () => {
  state.attentionOpen = !state.attentionOpen;
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
    project: uniqueVals([...state.newProjectVals, ...parsed.projects]),
    tags: uniqueVals([...state.newTagVals, ...parsed.tags]),
    discussed_with: state.newWhoVals,
    attachments: state.newAttachVals,
    discussed_from: document.getElementById("newDiscussedFrom").value || todayStr(),
    discussed_to: document.getElementById("newDiscussedTo").value || "",
    status: document.getElementById("newStatus").value,
    priority: parsed.priority || document.getElementById("newPriority").value,
    type: document.getElementById("newType").value,
    start_date: parsed.start_date || document.getElementById("newStartDate").value || null,
    due_date: parsed.due_date || document.getElementById("newDueDate").value || null,
    notes: document.getElementById("newNotes").value,
    cancel_reason: document.getElementById("newCancelReason").value,
    acceptance_criteria: state.newCriteriaVals,
  };
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const created = await res.json();
  state.tasks.push(created);
  const alsoSendToPlane = document.getElementById("newSendToPlane").checked;
  document.getElementById("addForm").reset();
  document.getElementById("moreOptions").classList.remove("open");
  document.getElementById("aiFillPanel").hidden = true;
  state.newProjectVals = []; state.newTagVals = []; state.newWhoVals = []; state.newAttachVals = []; state.newCriteriaVals = [];
  initAddFormChipFields();
  document.getElementById("quickPreview").innerHTML = "";
  populateProjectFilter();
  populateTagFilter();
  populateCycleFilter();
  populateDatalists();
  render();
  showToast("Task added");

  if (alsoSendToPlane) {
    const data = await sendTaskToPlane(created.id);
    if (data) {
      populateCycleFilter();
      render();
      showToast("Sent to Plane ✓");
    } else {
      showToast("Task added, but sending to Plane failed");
    }
  }
});

document.getElementById("copyBtn").addEventListener("click", () => {
  const text = stripMarkdown(lastAiText || buildDailyUpdateText());
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

document.getElementById("aiStandupBtn").addEventListener("click", async () => {
  const aiBtn = document.getElementById("aiStandupBtn");
  const preview = document.getElementById("updatePreview");
  const wrap = document.getElementById("updatePreviewWrap");
  const baseText = buildDailyUpdateText();
  aiBtn.textContent = "✨ Thinking…";
  aiBtn.disabled = true;
  wrap.classList.add("open");
  setLastAiText(null);
  preview.textContent = baseText;
  renderUpdateModeSwitch();
  try {
    const result = await aiGenerate("standup", baseText);
    setLastAiText(result);
    preview.textContent = result;
  } catch (err) {
    showToast("AI error: " + err.message);
    preview.textContent = baseText;
  }
  aiBtn.textContent = "✨ AI";
  aiBtn.disabled = false;
});

const backToTopBtn = document.getElementById("backToTop");
window.addEventListener("scroll", () => {
  backToTopBtn.classList.toggle("show", window.scrollY > 400);
}, { passive: true });
backToTopBtn.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
});

wireAskAI();
wireAiFill();

loadAll().then(maybeAutoSyncCycles);
