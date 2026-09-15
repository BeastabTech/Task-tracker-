import { todayStr } from "./utils.js";
import { showToast } from "./notifications.js";
import { patch } from "./api.js";
import { render } from "./views.js";

export async function aiGenerate(mode, inputText) {
  const res = await fetch("/api/ai-generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, input: inputText }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

export function wireAiAssist(card, t) {
  const btn = card.querySelector(".ai-assist-btn");
  const panel = card.querySelector(".ai-assist-panel");
  if (!btn || !panel) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panel.style.display !== "none") { panel.style.display = "none"; return; }
    const titleEl = card.querySelector(".title");
    const notesEl = card.querySelector(".notes");
    const currentTitle = titleEl.textContent.trim();
    const currentNotes = notesEl.textContent.trim();

    panel.innerHTML = `
      <div class="ai-panel-inner">
        <span class="ai-panel-label">✨ AI Assist</span>
        <button class="ai-action-btn" data-mode="title" data-target="title">Improve title</button>
        <button class="ai-action-btn" data-mode="description" data-target="notes">Generate description</button>
        <button class="ai-action-btn" data-mode="labels" data-target="labels">Suggest labels</button>
        <button class="ai-panel-close">✕</button>
      </div>
      <div class="ai-result-area" style="display:none">
        <span class="ai-result-text"></span>
        <button class="ai-apply-btn">Apply</button>
        <button class="ai-discard-btn">Discard</button>
      </div>`;
    panel.style.display = "block";

    panel.querySelector(".ai-panel-close").addEventListener("click", () => { panel.style.display = "none"; });

    panel.querySelectorAll(".ai-action-btn").forEach(ab => {
      ab.addEventListener("click", async () => {
        const mode = ab.dataset.mode;
        const target = ab.dataset.target;
        const inputText = mode === "title" ? currentTitle
          : mode === "labels" ? `${currentTitle}\n${currentNotes}`
          : `${currentTitle}\n${currentNotes || ""}`;
        ab.textContent = "…";
        ab.disabled = true;
        try {
          const result = await aiGenerate(mode, inputText);
          const resultArea = panel.querySelector(".ai-result-area");
          const resultText = panel.querySelector(".ai-result-text");
          resultText.textContent = result;
          resultArea.style.display = "flex";
          panel.querySelector(".ai-apply-btn").onclick = async () => {
            if (target === "title") {
              titleEl.textContent = result;
              t.title = result; t.updated_at = todayStr();
              await patch(t.id, { title: result });
            } else if (target === "notes") {
              notesEl.textContent = result;
              t.notes = result; t.updated_at = todayStr();
              await patch(t.id, { notes: result });
            } else if (target === "labels") {
              const newLabels = result.split(",").map(s => s.trim()).filter(Boolean);
              const existing = [...(t.tags || [])];
              const merged = [...new Set([...existing, ...newLabels])];
              t.tags = merged; t.updated_at = todayStr();
              await patch(t.id, { tags: merged });
              render();
            }
            panel.style.display = "none";
            showToast("Applied ✓");
          };
          panel.querySelector(".ai-discard-btn").onclick = () => { resultArea.style.display = "none"; };
        } catch (err) {
          showToast("AI error: " + err.message);
        }
        ab.disabled = false;
        ab.textContent = ab.dataset.mode === "title" ? "Improve title"
          : ab.dataset.mode === "description" ? "Generate description" : "Suggest labels";
      });
    });
  });
}
