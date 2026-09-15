import { state } from "./state.js";
import { escapeHtml } from "./utils.js";
import { showToast } from "./notifications.js";
import { renderLocalChipField } from "./views.js";

const FIELD_LABELS = {
  title: "Title",
  description: "Description",
  labels: "Labels",
  priority: "Priority",
  type: "Type",
  acceptance_criteria: "Acceptance criteria",
};

function fieldValueText(field, value) {
  if (field === "labels") return value.join(", ");
  if (field === "acceptance_criteria") return value.map(v => `• ${v}`).join("  ");
  return value;
}

function currentDraft() {
  return {
    title: document.getElementById("quickTitle").value.trim(),
    notes: document.getElementById("newNotes").value.trim(),
    project: state.newProjectVals,
    tags: state.newTagVals,
    priority: document.getElementById("newPriority").value,
    type: document.getElementById("newType").value,
    due_date: document.getElementById("newDueDate").value,
  };
}

async function requestFill(previousResult, feedback) {
  const res = await fetch("/api/ai-fill-task", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft: currentDraft(), previous_result: previousResult, feedback }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.suggestion;
}

export function wireAiFill() {
  const btn = document.getElementById("aiFillBtn");
  const panel = document.getElementById("aiFillPanel");
  const fieldsWrap = document.getElementById("aiFillFields");
  const closeBtn = document.getElementById("aiFillClose");
  const feedbackInput = document.getElementById("aiFillFeedback");
  const regenerateBtn = document.getElementById("aiFillRegenerate");
  const applyBtn = document.getElementById("aiFillApply");
  const discardBtn = document.getElementById("aiFillDiscard");
  if (!btn || !panel) return;

  let lastSuggestion = null;

  function renderFields(suggestion) {
    fieldsWrap.innerHTML = Object.entries(suggestion).map(([field, value]) => `
      <label class="ai-fill-field">
        <input type="checkbox" checked data-field="${field}">
        <span><b>${FIELD_LABELS[field] || field}:</b> ${escapeHtml(fieldValueText(field, value))}</span>
      </label>
    `).join("");
  }

  async function generate(feedback) {
    btn.disabled = true;
    regenerateBtn.disabled = true;
    const wasRegenerate = Boolean(feedback !== undefined && lastSuggestion);
    if (wasRegenerate) regenerateBtn.textContent = "Thinking…";
    else btn.textContent = "✨ Thinking…";
    try {
      const suggestion = await requestFill(lastSuggestion ? JSON.stringify(lastSuggestion) : null, feedback || "");
      lastSuggestion = suggestion;
      renderFields(suggestion);
      panel.hidden = false;
      feedbackInput.value = "";
    } catch (err) {
      showToast("AI error: " + err.message);
    }
    btn.disabled = false;
    btn.textContent = "✨ Refine with AI";
    regenerateBtn.disabled = false;
    regenerateBtn.textContent = "Regenerate";
  }

  btn.addEventListener("click", () => {
    const title = document.getElementById("quickTitle").value.trim();
    if (!title) { showToast("Type a title first"); return; }
    lastSuggestion = null;
    generate();
  });

  regenerateBtn.addEventListener("click", () => generate(feedbackInput.value.trim()));

  closeBtn.addEventListener("click", () => { panel.hidden = true; });
  discardBtn.addEventListener("click", () => { panel.hidden = true; lastSuggestion = null; });

  applyBtn.addEventListener("click", () => {
    if (!lastSuggestion) return;
    const checked = new Set([...fieldsWrap.querySelectorAll("input[type=checkbox]:checked")].map(c => c.dataset.field));

    if (checked.has("title")) document.getElementById("quickTitle").value = lastSuggestion.title;

    if (checked.has("description")) {
      const notesEl = document.getElementById("newNotes");
      notesEl.value = lastSuggestion.description;
    }
    if (checked.has("acceptance_criteria")) {
      lastSuggestion.acceptance_criteria.forEach(c => { if (!state.newCriteriaVals.includes(c)) state.newCriteriaVals.push(c); });
      renderLocalChipField("newCriteriaField", "newCriteriaInput", state.newCriteriaVals);
    }
    if (checked.has("priority")) document.getElementById("newPriority").value = lastSuggestion.priority;
    if (checked.has("type")) document.getElementById("newType").value = lastSuggestion.type;
    if (checked.has("labels")) {
      lastSuggestion.labels.forEach(l => { if (!state.newTagVals.includes(l)) state.newTagVals.push(l); });
      renderLocalChipField("newTagsField", "newTagsInput", state.newTagVals);
    }

    document.getElementById("moreOptions").classList.add("open");
    panel.hidden = true;
    showToast("Applied ✓");
  });
}
