import { API, state } from "./state.js";
import { todayStr } from "./utils.js";
import { showToast } from "./notifications.js";
import { patch, noticePlaneSyncResult } from "./api.js";
import { render, populateProjectFilter, populateTagFilter, populateDatalists } from "./views.js";

async function askAi(question, taskId) {
  const res = await fetch("/api/ai-ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, task_id: taskId }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

async function applyAction(action) {
  const { name, args } = action;

  if (name === "update_status") {
    const updated = await patch(args.task_id, { status: args.status });
    if (!updated) return false;
    render();
    return true;
  }

  if (name === "update_priority") {
    const updated = await patch(args.task_id, { priority: args.priority });
    if (!updated) return false;
    render();
    return true;
  }

  if (name === "add_comment") {
    const res = await fetch(`${API}/${args.task_id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: args.text }),
    });
    if (!res.ok) return false;
    const updated = await res.json();
    noticePlaneSyncResult(updated);
    const idx = state.tasks.findIndex(t => t.id === args.task_id);
    if (idx >= 0) state.tasks[idx] = updated;
    render();
    return true;
  }

  if (name === "archive_task") {
    const res = await fetch(`${API}/${args.task_id}`, { method: "DELETE" });
    if (!res.ok) return false;
    const archived = await res.json();
    noticePlaneSyncResult(archived);
    const idx = state.tasks.findIndex(t => t.id === args.task_id);
    if (idx >= 0) state.tasks[idx] = archived;
    populateProjectFilter();
    populateTagFilter();
    render();
    return true;
  }

  if (name === "create_task") {
    const body = {
      title: args.title,
      project: args.project || [],
      tags: args.tags || [],
      priority: args.priority || "P3",
      due_date: args.due_date || null,
      discussed_from: todayStr(),
    };
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return false;
    const created = await res.json();
    state.tasks.push(created);
    populateProjectFilter();
    populateTagFilter();
    populateDatalists();
    render();
    return true;
  }

  return false;
}

export function wireAskAI() {
  const btn = document.getElementById("askAiBtn");
  const panel = document.getElementById("askAiPanel");
  const closeBtn = document.getElementById("closeAskAi");
  const form = document.getElementById("askAiForm");
  const input = document.getElementById("askAiInput");
  const submitBtn = document.getElementById("askAiSubmit");
  const resultWrap = document.getElementById("askAiResult");
  const answerEl = document.getElementById("askAiAnswer");
  const actionCard = document.getElementById("askActionCard");
  const actionLabel = document.getElementById("askActionLabel");
  const actionApply = document.getElementById("askActionApply");
  const actionDiscard = document.getElementById("askActionDiscard");
  if (!btn || !panel || !form) return;

  let pendingAction = null;

  const openPanel = () => {
    panel.classList.add("open");
    input.focus();
  };
  const closePanel = () => panel.classList.remove("open");

  btn.addEventListener("click", () => {
    panel.classList.contains("open") ? closePanel() : openPanel();
  });
  closeBtn.addEventListener("click", closePanel);

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const question = input.value.trim();
    if (!question) return;
    pendingAction = null;
    actionCard.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "Thinking…";
    resultWrap.hidden = false;
    answerEl.textContent = "";
    try {
      const data = await askAi(question);
      if (data.action) {
        pendingAction = data.action;
        actionLabel.textContent = data.action.label;
        actionCard.hidden = false;
        answerEl.textContent = data.answer || "";
        answerEl.hidden = !data.answer;
      } else {
        answerEl.hidden = false;
        answerEl.textContent = data.answer || "(no answer)";
      }
    } catch (err) {
      answerEl.textContent = "";
      showToast("AI error: " + err.message);
    }
    submitBtn.disabled = false;
    submitBtn.textContent = "Ask";
  });

  actionApply.addEventListener("click", async () => {
    if (!pendingAction) return;
    actionApply.disabled = true;
    actionApply.textContent = "Applying…";
    const ok = await applyAction(pendingAction);
    actionApply.disabled = false;
    actionApply.textContent = "Apply";
    if (ok) {
      showToast("Applied ✓");
      actionCard.hidden = true;
      pendingAction = null;
    } else {
      showToast("Action failed");
    }
  });

  actionDiscard.addEventListener("click", () => {
    actionCard.hidden = true;
    pendingAction = null;
  });
}

export function wireTaskAsk(card, t) {
  const btn = card.querySelector(".task-ask-btn");
  const panel = card.querySelector(".task-ask-panel");
  if (!btn || !panel) return;

  btn.addEventListener("click", e => {
    e.stopPropagation();
    if (!panel.hidden) { panel.hidden = true; return; }

    panel.innerHTML = `
      <form class="task-ask-form">
        <input type="text" class="task-ask-input" placeholder="e.g. what's the status? what's blocking this?">
        <button type="submit" class="btn ghost task-ask-submit">Ask</button>
      </form>
      <div class="task-ask-result" hidden>
        <p class="task-ask-answer"></p>
        <div class="task-ask-action-card" hidden>
          <span class="task-ask-action-label"></span>
          <div class="ai-result-buttons">
            <button type="button" class="btn task-ask-action-apply">Apply</button>
            <button type="button" class="btn ghost task-ask-action-discard">Discard</button>
          </div>
        </div>
      </div>
    `;
    panel.hidden = false;

    const form = panel.querySelector(".task-ask-form");
    const input = panel.querySelector(".task-ask-input");
    const submitBtn = panel.querySelector(".task-ask-submit");
    const resultWrap = panel.querySelector(".task-ask-result");
    const answerEl = panel.querySelector(".task-ask-answer");
    const actionCard = panel.querySelector(".task-ask-action-card");
    const actionLabel = panel.querySelector(".task-ask-action-label");
    const actionApply = panel.querySelector(".task-ask-action-apply");
    const actionDiscard = panel.querySelector(".task-ask-action-discard");
    let pendingAction = null;

    input.focus();
    input.addEventListener("click", ev => ev.stopPropagation());
    form.addEventListener("click", ev => ev.stopPropagation());

    form.addEventListener("submit", async ev => {
      ev.preventDefault();
      ev.stopPropagation();
      const question = input.value.trim();
      if (!question) return;
      pendingAction = null;
      actionCard.hidden = true;
      submitBtn.disabled = true;
      submitBtn.textContent = "…";
      resultWrap.hidden = false;
      answerEl.textContent = "";
      try {
        const data = await askAi(question, t.id);
        if (data.action) {
          pendingAction = data.action;
          actionLabel.textContent = data.action.label;
          actionCard.hidden = false;
          answerEl.textContent = data.answer || "";
          answerEl.hidden = !data.answer;
        } else {
          answerEl.hidden = false;
          answerEl.textContent = data.answer || "(no answer)";
        }
      } catch (err) {
        showToast("AI error: " + err.message);
      }
      submitBtn.disabled = false;
      submitBtn.textContent = "Ask";
    });

    actionApply.addEventListener("click", async e2 => {
      e2.stopPropagation();
      if (!pendingAction) return;
      actionApply.disabled = true;
      actionApply.textContent = "Applying…";
      const ok = await applyAction(pendingAction);
      actionApply.disabled = false;
      actionApply.textContent = "Apply";
      if (ok) {
        showToast("Applied ✓");
        actionCard.hidden = true;
        pendingAction = null;
      } else {
        showToast("Action failed");
      }
    });

    actionDiscard.addEventListener("click", e2 => {
      e2.stopPropagation();
      actionCard.hidden = true;
      pendingAction = null;
    });
  });
}
