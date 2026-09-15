import { API, state } from "./state.js";
import { todayStr } from "./utils.js";
import { showToast } from "./notifications.js";
import { patch, noticePlaneSyncResult } from "./api.js";
import { askText, askConfirm, askCommentWithAI } from "./modals.js";
import { render, populateProjectFilter, populateTagFilter, afterChipChange } from "./views.js";

export async function moveTaskStatus(t, newStatus){
  if (!newStatus || newStatus === t.status) return t;
  const body = { status: newStatus };
  if (newStatus === "Cancelled") {
    const reason = await askCommentWithAI(t, {
      title: "Cancel task",
      placeholder: "Reason for cancelling? (Hinglish is fine)",
      confirmText: "Move to Cancelled",
      initial: t.cancel_reason || "",
    });
    if (reason === null) return null;
    body.cancel_reason = reason;
    body.status_note = reason;
  } else {
    const note = await askCommentWithAI(t, {
      title: `Move to ${newStatus}`,
      placeholder: "What's the update? (optional, Hinglish is fine)",
      confirmText: `Move to ${newStatus}`,
    });
    if (note === null) return null;
    if (note) body.status_note = note;
  }
  const updated = await patch(t.id, body);
  if (updated) showToast(`Moved to ${newStatus}`);
  return updated;
}

export function wireStatusAndDelete(card, t){
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
      const idx = state.tasks.findIndex(x => x.id === t.id);
      if (idx >= 0) state.tasks[idx] = archived;
      state.editingIds.delete(t.id);
      showToast("Task archived");
    }
    populateProjectFilter();
    populateTagFilter();
    render();
  });
}

export function wireChipField(fieldEl, t, field){
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

export function wireAddAttachment(card, t){
  const btn = card.querySelector(".add-attach");
  if (!btn) return;
  btn.addEventListener("click", async () => {
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
      const idx = state.tasks.findIndex(x => x.id === t.id);
      if (idx >= 0) state.tasks[idx] = updated;
    }
    render();
  });
}

export function wireAddComment(card, t){
  const btn = card.querySelector(".add-comment");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const text = await askCommentWithAI(t);
    if (!text) return;
    const res = await fetch(`${API}/${t.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (res.ok) {
      const updated = await res.json();
      noticePlaneSyncResult(updated);
      const idx = state.tasks.findIndex(x => x.id === t.id);
      if (idx >= 0) state.tasks[idx] = updated;
      showToast("Comment added");
    } else {
      showToast("Failed to add comment");
    }
    render();
  });
}

export function wireHistoryToggle(card, t){
  const btn = card.querySelector(".history-toggle");
  if (!btn) return;
  btn.addEventListener("click", e => {
    e.stopPropagation();
    if (state.historyOpenIds.has(t.id)) state.historyOpenIds.delete(t.id);
    else state.historyOpenIds.add(t.id);
    render();
  });
}
