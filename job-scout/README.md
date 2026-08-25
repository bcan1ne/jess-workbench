# Job Scout

A scheduled search for open roles matching a fixed candidate profile, scored for
fit and published as a static dashboard.

Ported from the Google Apps Script version (`Code.gs` + `Index.html`). The search
prompt, the JSON contract, the dedupe rule, and the distance math are unchanged;
the dashboard's visual design is unchanged. What moved is where the work happens.

## How it fits together

```
GitHub Actions (weekly cron)
  └─ src/refresh.js
       ├─ reads config.json + jobs.json
       ├─ src/search.js   → Anthropic Messages API with the web_search tool
       ├─ src/parse.js    → text blocks out of the response, fences stripped
       ├─ src/merge.js    → dedupe on url, append new, never touch existing
       └─ commits jobs.json (only when something new turned up)

GitHub Pages
  └─ site/index.html + site/app.js
       └─ fetch config.json, jobs.json, locals.json, statuses.json
```

**The API key never reaches the browser.** Every call happens inside the Actions
runner using the `ANTHROPIC_API_KEY` repository secret. The published site is
static and reads only committed JSON. `search.js` also scrubs the key out of any
error text before it can reach a log line.

## Files

| Path | What it is |
|---|---|
| `config.json` | Every search setting. Editing this is the only way to change the search. |
| `jobs.json` | The board. Appended to by the workflow, never rewritten. |
| `locals.json` | Hand-curated nearby employers. The workflow does not touch it. |
| `statuses.json` | Committed statuses, written from the dashboard and shared by every browser. |
| `src/` | The workflow's Node modules and their tests. |
| `site/` | The dashboard — a sortable, filterable table. `github.js` starts runs and syncs statuses, `resume.js` tailors, `app.js` renders. |
| `build.js` | Stages `site/` plus the JSON into `_site/` for Pages and local preview. |

## Changing the search

Everything is in `config.json`:

```json
{
  "repo": "bcan1ne/jess-workbench",
  "radius": 20,
  "lat": 41.79,
  "lon": -76.008,
  "multiplier": 1.3,
  "minSalary": 100000,
  "homeLabel": "Friendsville, PA",
  "industry": "…",
  "titles": "…",
  "workSetup": "…",
  "hardNos": "…"
}
```

`repo` is `owner/name` — it tells the dashboard which repository to start runs
against, so the board works from GitHub Pages, a local preview, or any other
host. Everything else is search settings.

Widening the radius or moving the salary floor is a one-line edit. The workflow
interpolates these into the prompt; the dashboard recomputes distances,
in-radius flags, and salary checks client-side from the same file, so both sides
always agree.

`multiplier` turns straight-line miles into an estimated drive — 1.3 is a fair
factor for this terrain. It is an estimate, not a routed distance.

## Refreshing from the dashboard

**Refresh listings** in the sidebar starts a workflow run without leaving the
page. It does not do the search — it presses the button. The runner still does
the searching with `ANTHROPIC_API_KEY`, so that key never reaches the browser
and new listings are still committed to `jobs.json`.

The same token also keeps statuses in sync — see below.

To enable both, create a **fine-grained** personal access token at
[github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new):

- **Repository access** → Only select repositories → this repository
- **Permissions** → Repository permissions →
  **Actions: Read and write** (start runs) and
  **Contents: Read and write** (commit statuses)
- Nothing else, and no other repository.

Paste it into Settings → Refresh. It is kept in `localStorage` in that browser
and is never committed. Put it in each browser you use. If it leaks, the worst
anyone can do is start your job search or edit this repository; revoke it from
the same settings page.

The button starts the run, waits for it to finish, then waits for Pages to
republish before showing new listings — usually two to three minutes end to end.
**View runs** in the settings panel opens the Actions log if you want detail.

Without a token nothing breaks; the button just points you at Settings.

## Résumé tailoring

Each listing has a **Tailor résumé** button. It sends the saved résumé plus that
posting's details to Claude and returns a rewritten résumé alongside a note
explaining what changed.

**This is the one path that does not go through Actions**, and deliberately so.
Everything else here is committed because accumulating it is the point. A résumé
is the opposite: this repository is public, so a résumé committed to it, passed
as a workflow input, or printed in a run log would be world-readable — and there
is nothing worth accumulating anyway, since the output is a document to download
and send. So:

- The résumé is pasted into Settings → Résumé and kept in `localStorage`.
- The call goes from the browser straight to the Anthropic API.
- The result appears in a panel with copy and download. Nothing is committed.

That costs an Anthropic key in the browser, which is why the settings panel says
so plainly. Anthropic disables browser calls by default and requires the
`anthropic-dangerous-direct-browser-access` header to opt in; their guidance
allows it for an internal tool with a trusted user, which is what this is. Use a
key you are willing to revoke.

It is a **separate key** from the `ANTHROPIC_API_KEY` repository secret the
weekly search uses. That one still never leaves the runner.

The prompt forbids invention: no employers, titles, dates, degrees,
certifications, or metrics that are not already in the résumé, and gaps are left
alone rather than papered over. No `web_search` tool is declared, so the call
cannot go looking for facts to add. Read the "what changed and why" notes before
sending anything — the model reorders and reweights, and that deserves a check.

## Status tracking

Statuses are committed to `statuses.json` and are the same on every browser.

Changing a status writes through the GitHub API using the same token as
**Refresh listings**: the page re-reads the committed file, sets that one
listing's key, and commits. Because only the changed key is written, a browser
working from a stale copy cannot overwrite a change made on another machine, and
a lost race on the file's SHA is re-read and retried.

The board renders optimistically and reverts if the commit fails, so the status
shown is always one the repository actually holds. A local `localStorage` copy
is kept as a cache for the moment before the first sync lands.

Without a token there is nothing to sync to, so changes stay on that device and
the settings panel says so. **Copy JSON** gives you the map as a backup; with
syncing on you should not need to paste it anywhere.

## What is public

The repository is public, so `config.json` (home location, salary floor, target
titles), `jobs.json` (the roles and the notes on each), `statuses.json` (where
she has applied), and the Actions run logs are all readable by anyone.

`ANTHROPIC_API_KEY` is a repository secret and is not — GitHub masks secrets in
logs, and `search.js` scrubs the key from error text as a second line of
defence. `github.js` does the same for the GitHub token.

The résumé, the tailored output, and the Anthropic key used for tailoring are
also not public. None of them is ever written to the repository; they live in
the browser only.

## Working on it

```bash
npm test        # parse, merge, Anthropic contract, GitHub dispatch, résumé tailoring
npm run build   # stage job-scout/_site
npm run preview # stage and serve on :8080
npm run refresh # a real search — needs ANTHROPIC_API_KEY in the environment
```

`npm run refresh` writes `jobs.json` in place. It exits non-zero on a missing
key, a non-200, or unparseable JSON, and writes nothing when nothing is new.
