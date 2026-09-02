# Task Tracker

A small local task tracker: a Python stdlib HTTP server + a vanilla HTML/CSS/JS frontend, with an
optional two-way integration into [Plane](https://plane.so) (self-hosted or plane.so). No database,
no build step — your data lives in one JSON file on your own machine.

Runs 100% locally. Nothing here talks to any server except Plane, and only if you connect it.

## Run it

```bash
pip install -r requirements.txt
python3 webapp/server.py
```

Open http://localhost:8787. `tasks.json` is created automatically on first run, right next to
`webapp/`, and everything you add lives there — nothing is bundled or shared between installs.

Change the port with `PORT=8080 python3 webapp/server.py`.

## Updating

Pull the latest code whenever you want:

```bash
git pull
```

Your data is never part of the repo (`tasks.json`, `plane_config.json`, and the exported `.xlsx`
are all gitignored), so pulling an update never touches it. Old tasks, notes, and your Plane
connection all carry forward untouched.

## Connecting Plane (optional)

Nothing Plane-related is hardcoded — no org, workspace, or user id ships with this code. Click
"Plane settings" in the app and paste:

- **Cookie** — the `Cookie` header from a logged-in request to your Plane instance (copy it from
  your browser's Network tab, or paste a whole "Copy as cURL" — the app pulls the cookie out of
  it for you either way)
- **Workspace slug** and **Project ID** — from your project's Plane URL

Everything else — your Plane user id (for assignment) and this project's status names (for
mapping "To Do"/"In Progress"/etc. onto your project's actual states) — is auto-detected the
moment you save. Nothing else to configure by hand.

If a status doesn't get auto-mapped (some workflows have ambiguous or unusual state setups), or
you want to point it at a different Plane instance entirely, edit `webapp/plane_config.json`
directly — it's a plain JSON file, gitignored, and never touched by an update.

### Config via environment variables

For scripted/headless setups, these override whatever's in `plane_config.json` on every run:

| Variable | Meaning |
|---|---|
| `PLANE_HOST` | Plane instance base URL (default `https://plane.alt-mobility.com`) |
| `PLANE_COOKIE` | Cookie header value |
| `PLANE_WORKSPACE` | Workspace slug |
| `PLANE_PROJECT_ID` | Project UUID |
| `PLANE_ASSIGNEE_ID` | Your Plane user id (skips auto-detection) |

The cookie expires roughly every 7 days (however your Plane instance's session is configured) —
when a Plane action fails because of it, the app offers to paste a fresh one right there and
retries automatically.

## Notes

- Plane pushes are manual only: "Send to Plane" creates an issue once; "Update in Plane" pushes
  your current local edits on demand. Nothing syncs automatically in the background.
- The Plane issue **description** holds only your notes; status/priority/project/tags/stakeholders/
  dates are posted as a **comment** instead, so Plane's own description field stays clean and the
  bookkeeping still shows up in the Activity feed.
