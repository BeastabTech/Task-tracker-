import { todayStr } from "./utils.js";
import { showToast } from "./notifications.js";
import { patch } from "./api.js";
import { render } from "./views.js";

export async function aiGenerate(mode, inputText, previousResult, feedback) {
  const res = await fetch("/api/ai-generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, input: inputText, previous_result: previousResult, feedback }),
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
        <div class="ai-refine-row">
          <input type="text" class="ai-refine-input" placeholder="Optional: tell it what to change, e.g. &quot;shorter&quot;">
          <button class="ai-regenerate-btn">Regenerate</button>
        </div>
        <div class="ai-result-buttons">
          <button class="ai-apply-btn">Apply</button>
          <button class="ai-discard-btn">Discard</button>
        </div>
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
        const resultArea = panel.querySelector(".ai-result-area");
        const resultText = panel.querySelector(".ai-result-text");
        const refineInput = panel.querySelector(".ai-refine-input");
        let result = null;

        async function generate(feedback) {
          ab.disabled = true;
          const regenBtn = panel.querySelector(".ai-regenerate-btn");
          if (feedback !== undefined) regenBtn.textContent = "…"; else ab.textContent = "…";
          try {
            result = await aiGenerate(mode, inputText, result, feedback);
            resultText.textContent = result;
            resultArea.style.display = "flex";
            refineInput.value = "";
          } catch (err) {
            showToast("AI error: " + err.message);
          }
          ab.disabled = false;
          regenBtn.textContent = "Regenerate";
          ab.textContent = ab.dataset.mode === "title" ? "Improve title"
            : ab.dataset.mode === "description" ? "Generate description" : "Suggest labels";
        }

        panel.querySelector(".ai-regenerate-btn").onclick = () => generate(refineInput.value.trim());
        panel.querySelector(".ai-apply-btn").onclick = async () => {
          if (!result) return;
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
        panel.querySelector(".ai-discard-btn").onclick = () => { resultArea.style.display = "none"; result = null; };

        await generate();
      });
    });
  });
}
