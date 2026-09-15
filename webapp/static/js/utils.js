import { CLOSED_STATUSES, STALE_DAYS } from "./state.js";

export function slug(s){ return s.replace(/\s+/g, "-"); }
export function statusToneClass(status){ return `status-tone-${slug(status || "To Do")}`; }
export function localDateStr(d = new Date()){
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
export function todayStr(){ return localDateStr(); }
export function yesterdayStr(){ const d = new Date(); d.setDate(d.getDate()-1); return localDateStr(d); }

export function fmtDate(iso){
  if (!iso) return "";
  const [y,m,d] = iso.split("-").map(Number);
  return new Date(y, m-1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
export function fmtRange(from, to){
  if (!from) return "";
  if (!to || to === from) return fmtDate(from);
  return `${fmtDate(from)} – ${fmtDate(to)}`;
}
// Buckets a date into its (Monday-start) week — used to add weekly sub-sections inside each
// month group in the list view. `key` sorts chronologically (the week's Monday, as an ISO
// string); `label` is what's shown in the sub-header.
export function weekKeyAndLabel(dateIso){
  if (!dateIso) return { key: "0000-00-00", label: "No date" };
  const [y,m,d] = dateIso.split("-").map(Number);
  const date = new Date(y, m-1, d);
  const day = date.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  date.setDate(date.getDate() + diff);
  const end = new Date(date);
  end.setDate(date.getDate() + 6);
  const key = localDateStr(date);
  const label = `${date.toLocaleDateString(undefined,{month:"short",day:"numeric"})} – ${end.toLocaleDateString(undefined,{month:"short",day:"numeric"})}`;
  return { key, label };
}
export function ageDays(t){
  const start = t.created_at || t.discussed_from || t.updated_at;
  if (!start) return 0;
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((new Date() - d) / 86400000));
}
export function isClosed(t){ return CLOSED_STATUSES.has(t.status); }
export function isOverdue(t){ return !isClosed(t) && t.due_date && t.due_date < todayStr(); }
export function isStale(t){ return !isClosed(t) && (t.updated_at || "") <= localDateStr(new Date(Date.now() - STALE_DAYS * 86400000)); }

export function parseLooseDate(value){
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
export function parseQuickInput(raw){
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
export function uniqueVals(values){
  return [...new Set(values.filter(Boolean))];
}
export function quickPreviewHtml(parsed){
  const chips = [];
  if (parsed.priority) chips.push(parsed.priority);
  parsed.projects.forEach(p => chips.push(`#${p}`));
  parsed.tags.forEach(t => chips.push(`@${t}`));
  if (parsed.due_date) chips.push(`Due ${fmtDate(parsed.due_date)}`);
  if (parsed.start_date) chips.push(`Start ${fmtDate(parsed.start_date)}`);
  return chips.map(c => `<span>${escapeHtml(c)}</span>`).join("");
}
export function taskMetaLine(t){
  const bits = [];
  if ((t.project || []).length) bits.push((t.project || []).slice(0, 2).join(", "));
  if (t.due_date) bits.push(`Due ${fmtDate(t.due_date)}`);
  if (isStale(t)) bits.push(`${ageDays(t)}d old`);
  return bits.join(" · ");
}

export function escapeHtml(s){
  return (s||"").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
}

export function clipText(text, max = 220){
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 3)}...`;
}

export async function copyText(text){
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
