import { escapeHtml } from "./utils.js";

export function askText({ title, placeholder = "", initial = "", confirmText = "Save" }){
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

export function askConfirm({ title, message = "", confirmText = "Delete", danger = true }){
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

export function askTextarea({ title, placeholder = "", helpText = "", confirmText = "Save", initial = "" }){
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
      <form class="text-modal">
        <h2>${escapeHtml(title)}</h2>
        ${helpText ? `<p class="confirm-message">${escapeHtml(helpText)}</p>` : ""}
        <textarea class="modal-textarea" placeholder="${escapeHtml(placeholder)}" rows="6">${escapeHtml(initial)}</textarea>
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
    const ta = overlay.querySelector(".modal-textarea");
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
}

export function askCommentWithAI(task, { title = "Add comment", placeholder = "What's the update? (Hinglish is fine)", confirmText = "Add comment", initial = "" } = {}){
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
      <form class="text-modal">
        <h2>${escapeHtml(title)}</h2>
        <textarea class="modal-textarea" placeholder="${escapeHtml(placeholder)}" rows="5">${escapeHtml(initial)}</textarea>
        <div class="modal-ai-row">
          <button type="button" class="btn ghost ai-reframe-btn">✨ Reframe with AI</button>
          <span class="ai-reframe-status"></span>
        </div>
        <div class="ai-reframe-preview" hidden>
          <p class="ai-reframe-preview-text"></p>
          <div class="ai-refine-row">
            <input type="text" class="ai-refine-input" placeholder="Optional: tell it what to change, e.g. &quot;more formal&quot;">
            <button type="button" class="btn ghost ai-reframe-regenerate">Regenerate</button>
          </div>
          <div class="ai-result-buttons">
            <button type="button" class="btn ai-reframe-accept">Accept</button>
            <button type="button" class="btn ghost ai-reframe-reject">Reject</button>
          </div>
        </div>
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

    const reframeBtn = overlay.querySelector(".ai-reframe-btn");
    const statusEl = overlay.querySelector(".ai-reframe-status");
    const ta = overlay.querySelector(".modal-textarea");
    const preview = overlay.querySelector(".ai-reframe-preview");
    const previewText = overlay.querySelector(".ai-reframe-preview-text");
    const refineInput = overlay.querySelector(".ai-refine-input");
    const regenerateBtn = overlay.querySelector(".ai-reframe-regenerate");
    let lastResult = null;
    let sourceText = "";

    async function reframe(feedback) {
      reframeBtn.disabled = true;
      regenerateBtn.disabled = true;
      statusEl.textContent = "Rewriting…";
      try {
        const res = await fetch("/api/ai-generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "comment_reframe", task_id: task.id, input: sourceText,
            previous_result: lastResult, feedback,
          }),
        });
        const data = await res.json();
        if (data.result) {
          lastResult = data.result;
          previewText.textContent = lastResult;
          preview.hidden = false;
          refineInput.value = "";
          statusEl.textContent = "";
        } else {
          statusEl.textContent = data.error ? `AI error: ${data.error}` : "No result";
        }
      } catch (e) {
        statusEl.textContent = "AI unavailable";
      }
      reframeBtn.disabled = false;
      regenerateBtn.disabled = false;
    }

    reframeBtn.addEventListener("click", () => {
      const raw = ta.value.trim();
      if (!raw) { statusEl.textContent = "Type something first"; return; }
      sourceText = raw;
      lastResult = null;
      reframe();
    });

    regenerateBtn.addEventListener("click", () => reframe(refineInput.value.trim()));

    overlay.querySelector(".ai-reframe-accept").addEventListener("click", () => {
      if (!lastResult) return;
      ta.value = lastResult;
      preview.hidden = true;
      statusEl.textContent = "✓ Reframed";
      ta.focus();
    });

    overlay.querySelector(".ai-reframe-reject").addEventListener("click", () => {
      preview.hidden = true;
      lastResult = null;
      statusEl.textContent = "";
      ta.focus();
    });

    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    ta.focus();
  });
}

// One modal for both first-time setup and refreshing an expired cookie. Workspace/project id
// are pre-filled from whatever's already saved, so a returning user pasting a fresh cookie
// usually just has to paste and hit save — nothing to re-type. Everything discovered (states,
// status map, assignee id) is filled in automatically server-side once cookie+workspace+project
// are known; see discover_plane_setup in plane/sync.py.
export function askPlaneSetup({ cookie = "", workspace = "", projectId = "" } = {}){
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
