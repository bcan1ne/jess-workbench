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
| `statuses.json` | Committed statuses — the shared baseline under each browser's local ones. |
| `src/` | The workflow's Node modules and their tests. |
| `site/` | The dashboard. `github.js` starts a run; `app.js` renders the board. |
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

To enable it, create a **fine-grained** personal access token at
[github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new):

- **Repository access** → Only select repositories → this repository
- **Permissions** → Repository permissions → **Actions: Read and write**
- Nothing else. It cannot read your code, your other repositories, or anything
  outside Actions on this one.

Paste it into Settings → Refresh. It is kept in `localStorage` in that browser
and is never committed. If it leaks, the worst anyone can do is start your job
search; revoke it from the same settings page.

The button starts the run, waits for it to finish, then waits for Pages to
republish before showing new listings — usually two to three minutes end to end.
**View runs** in the settings panel opens the Actions log if you want detail.

Without a token nothing breaks; the button just points you at Settings.

## Status tracking

A static site cannot write back, so status lives in two places:

- **`localStorage`**, keyed by listing URL — instant, private to that browser.
- **`statuses.json`**, committed — the baseline every browser starts from.

Local values win over committed ones. **Settings → Copy JSON** gives you the
merged map; paste it into `statuses.json` and commit to make it permanent
everywhere. **Reset to committed** clears just that browser.

## Working on it

```bash
npm test        # parse, merge, Anthropic contract, GitHub dispatch
npm run build   # stage job-scout/_site
npm run preview # stage and serve on :8080
npm run refresh # a real search — needs ANTHROPIC_API_KEY in the environment
```

`npm run refresh` writes `jobs.json` in place. It exits non-zero on a missing
key, a non-200, or unparseable JSON, and writes nothing when nothing is new.
