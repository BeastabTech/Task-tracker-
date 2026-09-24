export const API = "/api/tasks";
export const USER_NAME = "Beastab";
export const MONTH_ORDER = ["January","February","March","April","May","June","July","August","September","October","November","December"];
export const STATUS_ORDER = { "Blocker": 0, "In Progress": 1, "In Review": 2, "Pending": 3, "To Do": 4, "Done": 5, "Cancelled": 6 };
export const STATUS_DOT = { "Blocker": "var(--danger)", "In Progress": "var(--accent)", "In Review": "var(--review)", "Pending": "var(--warn)", "To Do": "var(--todo)", "Done": "var(--ok)", "Cancelled": "var(--cancel)" };
export const PRIORITY_ORDER = { "P1": 0, "P2": 1, "P3": 2, "P4": 3 };
export const DAILY_ACTIVITY_TYPES = new Set(["status_changed", "status_snapshot", "reopened", "cancelled"]);
export const CLOSED_STATUSES = new Set(["Done", "Cancelled"]);
export const ACTIVE_WORK_STATUSES = new Set(["In Progress", "In Review", "Pending", "Blocker"]);
export const STALE_DAYS = 7;
export const FILTER_LABELS = {
  all: "All tasks",
  today: "Today changed",
  overdue: "Overdue",
  high: "High priority",
  stale: "Stale tasks",
  archived: "Archived",
  review: "Reviews",
  bugmodule: "Bug / Incident tasks",
};
export const CHIP_LABELS = {
  all: "All",
  today: "Today",
  overdue: "Overdue",
  high: "High",
  stale: "Stale",
  archived: "Archived",
  review: "Reviews",
  bugmodule: "🐛 Bugs",
};

/* Single shared mutable-state object — every module imports `state` and reads/writes its
   properties directly, so a reassignment in one module (e.g. loadAll() replacing state.tasks)
   is visible everywhere without each module needing its own setter function. */
export const state = {
  tasks: [],
  statuses: ["To Do", "In Progress", "In Review", "Pending", "Blocker", "Done", "Cancelled"],
  priorities: ["P1", "P2", "P3", "P4"],
  taskTypes: ["Task", "Review", "Bug"],
  activeFilter: "all",
  activeProject: "",
  activeTag: "",
  activeCycle: "",
  dateFrom: "",
  dateTo: "",
  searchTerm: "",
  attentionOpen: true,
  backlogLimit: parseInt(localStorage.getItem("dailyBacklogLimit") || "5", 10),
  historyOpenIds: new Set(),
  collapsedMonths: new Set(),
  collapsedWeeks: new Set(),
  editingIds: new Set(),
  highlightedTaskId: "",
  viewMode: localStorage.getItem("taskViewMode") || "list",
  updateMode: localStorage.getItem("dailyUpdateMode") || "short",
  draggedTaskId: "",
  pointerDrag: null,
  newProjectVals: [],
  newTagVals: [],
  newWhoVals: [],
  newAttachVals: [],
  newCriteriaVals: [],
};
