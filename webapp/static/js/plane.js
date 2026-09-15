import { API, state } from "./state.js";
import { todayStr } from "./utils.js";
import { showToast } from "./notifications.js";
import { askConfirm, askPlaneSetup } from "./modals.js";
import { render, populateCycleFilter } from "./views.js";
import { loadAll } from "./main.js";

// Shared by the per-card "Send to Plane" button and the Add Task form's "also send to Plane"
// checkbox — handles the creds-expired-retry dance once, and copies every plane_* field
// (including the cycle it landed in) onto the in-memory task so the UI reflects it without a
// full reload. Returns the response data on success, null on failure (a toast is already shown
// for the creds-fix path; callers still decide their own success/failure toast).
export async function sendTaskToPlane(taskId){
  let res = await fetch(`${API}/${taskId}/plane`, { method: "POST" });
  let data = await res.json();
  if ((!res.ok || data.error) && await offerPlaneCredsFix(data.error)) {
    res = await fetch(`${API}/${taskId}/plane`, { method: "POST" });
    data = await res.json();
  }
  if (!res.ok || data.error) return null;
  const t = state.tasks.find(x => x.id === taskId);
  if (t) {
    t.plane_issue_id = data.plane_issue_id;
    t.plane_url = data.plane_url;
    t.plane_cycle_id = data.plane_cycle_id;
    t.plane_cycle_name = data.plane_cycle_name;
    t.plane_cycle_url = data.plane_cycle_url;
  }
  return data;
}

export function wirePlaneButton(card, t){
  const btn = card.querySelector(".plane-btn:not(.plane-update-btn)");
  if (btn) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Sending…";
      try {
        const data = await sendTaskToPlane(t.id);
        if (!data) {
          btn.disabled = false;
          btn.textContent = "📤 Send to Plane";
          return;
        }
        showToast("Sent to Plane ✓");
        populateCycleFilter();
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

export async function openPlaneCookiePrompt(){
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

// Plane cycles are weekly and end on their own — nothing carries an unfinished issue into the
// new one automatically on Plane's side, so still-open tasks are left sitting in a stale, ended
// cycle until someone notices. `silent: true` (the once-a-day background check) never interrupts
// with the creds-recovery modal and stays quiet unless it actually moved something; the manual
// button always reports back, errors included.
export async function runCycleRollover({ silent = false } = {}){
  try {
    let res = await fetch("/api/plane-cycle-rollover", { method: "POST" });
    let data = await res.json();
    if ((!res.ok || data.error) && !silent && await offerPlaneCredsFix(data.error)) {
      res = await fetch("/api/plane-cycle-rollover", { method: "POST" });
      data = await res.json();
    }
    if (!res.ok || data.error) {
      if (!silent) showToast(data.error || "Cycle sync failed");
      return null;
    }
    if (data.moved && data.moved.length) {
      await loadAll();
      showToast(`Moved ${data.moved.length} task${data.moved.length === 1 ? "" : "s"} into ${data.cycle_name}`);
    } else if (!silent) {
      showToast(data.cycle_name ? `Already up to date with ${data.cycle_name}` : "No active Plane cycle right now");
    }
    if (data.failed && data.failed.length && !silent) {
      showToast(`${data.failed.length} task(s) couldn't be moved — check them in Plane`);
    }
    return data;
  } catch (err) {
    if (!silent) showToast("Cycle sync failed");
    return null;
  }
}

// Runs at most once per day, automatically — enough to catch a weekly cycle transition without
// hammering Plane on every page load.
export async function maybeAutoSyncCycles(){
  const today = todayStr();
  if (localStorage.getItem("lastCycleRolloverCheck") === today) return;
  localStorage.setItem("lastCycleRolloverCheck", today);
  await runCycleRollover({ silent: true });
}

document.getElementById("planeSettingsBtn").addEventListener("click", openPlaneCookiePrompt);

document.getElementById("cycleSyncBtn").addEventListener("click", async () => {
  const btn = document.getElementById("cycleSyncBtn");
  btn.disabled = true;
  await runCycleRollover({ silent: false });
  btn.disabled = false;
});

document.getElementById("bulkLabelSyncBtn").addEventListener("click", async () => {
  const btn = document.getElementById("bulkLabelSyncBtn");
  btn.disabled = true;
  btn.textContent = "🏷️ Syncing…";
  try {
    const res = await fetch("/api/plane-bulk-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ only_labels: true }),
    });
    const data = await res.json();
    if (data.error) {
      showToast("Label sync failed: " + data.error);
    } else {
      const msg = data.failed > 0
        ? `Labels synced: ${data.updated} ok, ${data.failed} failed`
        : `Labels synced to ${data.updated} Plane issues ✓`;
      showToast(msg);
    }
  } catch (err) {
    showToast("Label sync failed");
  } finally {
    btn.disabled = false;
    btn.textContent = "🏷️ Sync labels";
  }
});
