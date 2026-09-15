import { state, DAILY_ACTIVITY_TYPES, STATUS_ORDER } from "./state.js";
import { fmtDate } from "./utils.js";

export function activityStatus(activity, task){
  const candidates = [activity.to, activity.to_status, activity.from_status, activity.from, task.status];
  return candidates.find(value => state.statuses.includes(value)) || task.status;
}
export function activityTime(activity){
  if (!activity.at) return fmtDate(activity.date);
  const d = new Date(activity.at);
  if (Number.isNaN(d.getTime())) return fmtDate(activity.date);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
export function activityLabel(activity){
  const from = activity.from || activity.from_status || activity.from_value;
  const to = activity.to || activity.to_status || activity.to_value;
  const field = (activity.field || "").replaceAll("_", " ");
  if (activity.type === "created") return "Task created";
  if (activity.type === "status_snapshot") return `Status snapshot: ${to || "Unknown"}`;
  if (activity.type === "status_changed") {
    const base = from ? `Status changed: ${from} -> ${to}` : `Status changed: ${to}`;
    return activity.note ? `${base} — ${activity.note}` : base;
  }
  if (activity.type === "completed") return "Completed";
  if (activity.type === "reopened") return `Reopened: ${from || "Done"} -> ${to || "Open"}`;
  if (activity.type === "date_changed") return `${field || "Date"} changed: ${from || "empty"} -> ${to || "empty"}`;
  if (activity.type === "attachment_added") return `Attachment added: ${activity.label || "file"}`;
  if (activity.type === "attachment_removed") return `Attachment removed: ${activity.label || "file"}`;
  if (activity.type === "archived") return "Archived";
  if (activity.type === "restored") return "Restored";
  if (activity.type === "cancelled") return activity.reason ? `Cancelled: ${activity.reason}` : "Cancelled";
  if (activity.type === "cancel_reason_changed") return to ? `Cancel reason: ${to}` : "Cancel reason cleared";
  if (activity.type === "comment") return `💬 ${activity.text || ""}`;
  return activity.type.replaceAll("_", " ");
}
export function recentActivities(limit = 8){
  const rows = [];
  state.tasks.forEach(task => {
    if (task.archived_at) return;
    const history = Array.isArray(task.activity_history) ? task.activity_history : [];
    history.forEach(activity => rows.push({ task, activity }));
  });
  return rows
    .sort((a,b) => (b.activity.at || b.activity.date || "").localeCompare(a.activity.at || a.activity.date || ""))
    .slice(0, limit);
}

export function statusEventsForDay(t, day){
  const history = Array.isArray(t.activity_history) ? t.activity_history : [];
  return history
    .filter(a => a.date === day && DAILY_ACTIVITY_TYPES.has(a.type))
    .filter(a => {
      const status = activityStatus(a, t);
      return status && !(a.type === "status_snapshot" && a.inferred && status === "To Do");
    })
    .sort((a,b) => (a.at || a.date || "").localeCompare(b.at || b.date || ""));
}

export function statusEventsBeforeDay(t, day){
  const history = Array.isArray(t.activity_history) ? t.activity_history : [];
  return history
    .filter(a => (a.date || "") < day && DAILY_ACTIVITY_TYPES.has(a.type))
    .filter(a => activityStatus(a, t))
    .sort((a,b) => (a.at || a.date || "").localeCompare(b.at || b.date || ""));
}

export function statusAtEndOfDay(t, day){
  const throughDay = [
    ...statusEventsBeforeDay(t, day),
    ...statusEventsForDay(t, day),
  ];
  const last = throughDay[throughDay.length - 1];
  if (last) return activityStatus(last, t);
  if ((t.created_at || t.discussed_from || t.updated_at || "") <= day) return t.status;
  return "";
}

export function previousStatusForDay(t, day){
  const before = statusEventsBeforeDay(t, day);
  const last = before[before.length - 1];
  return last ? activityStatus(last, t) : "";
}

export function dailyEntries(day){
  const entries = [];
  state.tasks.forEach(t => {
    if (t.archived_at) return;
    const candidates = statusEventsForDay(t, day);
    if (!candidates.length) {
      if (t.status !== "To Do" && (t.updated_at === day || t.done_at === day || t.closed_at === day)) {
        entries.push({ task: t, status: t.status, from: previousStatusForDay(t, day), at: t.updated_ts || t.updated_at || day, inferred: true, events: [] });
      }
      return;
    }
    const first = candidates[0];
    const last = candidates[candidates.length - 1];
    const from = first.from_status || first.from || previousStatusForDay(t, day);
    entries.push({
      task: t,
      status: activityStatus(last, t),
      from,
      at: last.at || last.date || day,
      inferred: candidates.some(a => a.inferred),
      events: candidates,
    });
  });
  return entries.sort((a,b) => {
    const sa = STATUS_ORDER[a.status] ?? 9;
    const sb = STATUS_ORDER[b.status] ?? 9;
    if (sa !== sb) return sa - sb;
    return a.at.localeCompare(b.at);
  });
}
