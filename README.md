# Humam Promotieplanner

A single-page website (GitHub Pages) that turns the ClickUp list
**Promotions** into a weekly hour planner:

- Shows every task in the list (with subtasks) with **time spent**, **time
  estimate** and what is **left**, straight from ClickUp.
- Lets you **plan hours per workday** (Mon–Wed by default) by dragging a task
  onto a day or pressing *Plan*.
- Checks that at least **7 of the 7.5 hours** of every workday are planned.
  Days before today are never checked; it is only about the plan going forward.
- Refreshes itself from ClickUp every minute (and on demand).

No build step, no server: the page calls the ClickUp API directly from the
browser with the visitor's own API token. The plan itself is stored in a
ClickUp **text custom field** on each task, so everybody who opens the page
sees the same plan and it is visible inside ClickUp too.

## One-time setup

1. **Create the planning field in ClickUp** (once, by a workspace admin):
   open the list, click **+** at the end of the column headers → **Text** →
   name it `Planning`. Without this field the page works read-only.
2. **Enable GitHub Pages**: repository *Settings → Pages → Build and
   deployment → Source: Deploy from a branch → `main` / `(root)`* → Save.
   The site appears at <https://easyseebv.github.io/Humam_Promotieplanner/>
   after a minute. On a free organisation plan GitHub Pages only works for
   **public** repositories; this repo contains no secrets, so it can be made
   public safely.
3. **Everyone who uses the page** signs in once, either with **Log in with
   ClickUp** (see below) or with their personal ClickUp API token (ClickUp →
   avatar → *Settings* → *Apps* → *API Token*). The token is kept in that
   browser's `localStorage` only and is never committed.

## "Log in with ClickUp" (optional, OAuth)

A ClickUp OAuth app (`humamscheduler`) lets people sign in with one click
instead of pasting a token. ClickUp's OAuth flow needs the app's **client
secret** to turn the login code into a token, and a secret can never live in
a public static site. The `worker/` folder therefore contains a ~60-line
Cloudflare Worker (free plan is plenty) that does only that exchange.

1. In ClickUp → *Settings* → *Integrations* → *ClickUp API* → your app, add
   the **Redirect URL** `https://easyseebv.github.io/Humam_Promotieplanner/`
   (exactly, with the trailing slash).
2. Deploy the worker once (needs a free Cloudflare account and Node):
   ```
   cd worker
   npx wrangler login
   npx wrangler secret put CLICKUP_CLIENT_SECRET   # paste the app's client secret
   npx wrangler deploy                             # prints https://humam-promotieplanner-auth.<account>.workers.dev
   ```
3. Put that URL in `DEFAULT_SETTINGS.oauthExchangeUrl` in `app.js` and push.
   The sign-in screen then shows **Log in with ClickUp**; the personal-token
   form stays available underneath.

The client id is public and already in `app.js` / `worker/wrangler.toml`; the
secret only ever lives in the worker's encrypted secrets. If the Worker URL is
left empty, the page simply offers the token login only.

## Configuration

Defaults live at the top of `app.js` (`DEFAULT_SETTINGS`) and can be
overridden per browser via the **Settings** button:

| Setting | Default | Meaning |
| --- | --- | --- |
| List ID | `901523821635` | ClickUp list to plan (from the URL `…/v/l/6-<LIST_ID>-1`). |
| Planning custom field name | `Planning` | Text custom field that stores the plan per task. |
| Workdays | Mon, Tue, Wed | Days that appear in the week view. |
| Hours rule applies | per workday | `per workday`: each day needs its minimum. `per week`: the week total is checked. |
| Capacity | 7.5 h | Hours available per workday (or per week). |
| Minimum to plan | 7 h | Hours that must be planned per workday (or per week). |
| Auto refresh | 60 s | How often the page reloads from ClickUp. |

## How the plan is stored

Each task's `Planning` field holds a readable list of `date: hours`, e.g.

```
2026-09-08: 2.5h, 2026-09-09: 4h
```

Entries older than 8 weeks are pruned whenever a task's plan is saved.

## Development

```
node --test        # unit tests: planner-core.js and worker/worker.js
```

Open `index.html` directly in a browser or serve the folder with any static
server (`python -m http.server`). Files:

- `index.html` – page shell and settings dialog
- `styles.css` – styling (light/dark)
- `planner-core.js` – pure logic: dates, ISO weeks, plan text format, checks
- `app.js` – ClickUp API calls, OAuth sign-in, state and rendering
- `test/core.test.js` – tests for `planner-core.js`
- `worker/` – Cloudflare Worker for the OAuth code→token exchange (+ tests)
