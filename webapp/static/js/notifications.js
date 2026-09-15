// Queued rather than clobbering: a Plane-sync warning can now land right alongside a normal
// action toast (e.g. "Moved to In Progress"), and both need to actually be seen.
let toastQueue = [];
let toastShowing = false;

export function showToast(msg){
  toastQueue.push(msg);
  if (!toastShowing) drainToastQueue();
}

function drainToastQueue(){
  const msg = toastQueue.shift();
  if (msg === undefined) { toastShowing = false; return; }
  toastShowing = true;
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(drainToastQueue, 150);
  }, 1800);
}
