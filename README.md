# Humam Promotieplanner

A small website (GitHub Pages) that turns the ClickUp list **Promotions** into
a weekly hour planner. Nobody has to log in.

- Shows every task in the list (with subtasks) with **time spent**, **time
  estimate** and what is **left**, live from ClickUp.
- Lets you **plan hours per workday** (Mon–Wed by default) by dragging a task
  onto a day or pressing *Plan*.
- Checks that at least **7 of the 7.5 hours** of every workday are planned.
  Days before today are never checked; it is only about the plan going forward.
- Refreshes itself every minute (and on demand).
- The plan lives **only on this site** (in the worker's database), never in
  ClickUp. ClickUp is read, never written.

## How it works

```
browser (GitHub Pages)  ──►  Cloudflare Worker (worker/)  ──►  ClickUp API (read-only, one token)
                                     │
                                     └──►  D1 database: the weekly plan
```

The page is static HTML/JS. The worker holds a single ClickUp API token as a
secret and only relays two read-only calls for the allowed list (list details
and its tasks). The weekly plan is stored per task in a D1 (SQLite) table and
served to every visitor.

## One-time setup

1. **Worker** (free Cloudflare account, Node installed):
   ```
   cd worker
   npx wrangler login
   npx wrangler d1 create humam-promotieplanner-plan       # copy the database_id into wrangler.toml
   npx wrangler d1 execute humam-promotieplanner-plan --remote --file=schema.sql
   npx wrangler secret put CLICKUP_TOKEN                   # paste a personal ClickUp API token (pk_…)
   npx wrangler deploy                                     # prints the https://….workers.dev URL
   ```
   The token is the "permission": everything the page shows is read with it,
   so use a token of someone who can see the list. Only the two list calls are
   relayed; the token can do nothing else through the worker.
2. **Page**: put the worker URL in `DEFAULT_SETTINGS.workerUrl` in `app.js`
   (already done for this deployment) and enable GitHub Pages: repository
   *Settings → Pages → Deploy from a branch → `main` / `(root)`*. On a free
   organisation plan Pages needs a **public** repository; there are no secrets
   in it. The site then lives at
   <https://easyseebv.github.io/Humam_Promotieplanner/>.

Anyone who knows the page URL can view and change the plan. Nothing in ClickUp
can be changed through it.

## Configuration

Defaults live at the top of `app.js` (`DEFAULT_SETTINGS`) and can be overridden
per browser via the **Settings** button:

| Setting | Default | Meaning |
| --- | --- | --- |
| ClickUp list ID | `901523821635` | List to plan (from the URL `…/v/l/6-<LIST_ID>-1`); must be in the worker's `ALLOWED_LIST_IDS`. |
| Worker URL | the deployed worker | Where the page reads ClickUp data and stores the plan. |
| Workdays | Mon, Tue, Wed | Days that appear in the week view. |
| Hours rule applies | per workday | `per workday`: each day needs its minimum. `per week`: the week total is checked. |
| Capacity | 7.5 h | Hours available per workday (or per week). |
| Minimum to plan | 7 h | Hours that must be planned per workday (or per week). |
| Auto refresh | 60 s | How often the page reloads. |

Worker settings are in `worker/wrangler.toml` (`ALLOWED_LIST_IDS`,
`ALLOWED_ORIGINS`, the D1 binding) plus the `CLICKUP_TOKEN` secret.

## Development

```
node --test        # unit tests: planner-core.js and worker/worker.js
```

Serve the folder with any static server on port 8765 (that origin is allowed
by the worker), e.g. `python -m http.server 8765`. Files:

- `index.html` – page shell and settings dialog
- `styles.css` – styling (light/dark)
- `planner-core.js` – pure logic: dates, ISO weeks, planning maps, checks
- `app.js` – worker calls, state and rendering
- `test/core.test.js` – tests for `planner-core.js`
- `worker/` – Cloudflare Worker (read-only ClickUp relay + plan storage), schema and tests
