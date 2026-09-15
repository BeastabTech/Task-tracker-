import { API, state } from "./state.js";
import { showToast } from "./notifications.js";

// If a task is already linked to Plane, the backend auto-syncs this edit there on its own
// (see sync_plane_on_activity in plane/sync.py) — nothing to trigger here. We only need to
// surface it when that auto-sync failed (e.g. expired cookie), as a quiet heads-up; success
// stays silent so routine edits don't get noisy.
export function noticePlaneSyncResult(updated){
  if (updated && updated._plane_sync_error) {
    showToast(`Plane sync failed: ${updated._plane_sync_error}`);
  }
}

export async function patch(id, body){
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
  const idx = state.tasks.findIndex(t => t.id === id);
  if (idx >= 0) state.tasks[idx] = updated;
  return updated;
}
