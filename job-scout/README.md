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
       ├─ reads config.json + companies.json + jobs.json
       ├─ src/sources.js  → polls employer ATS boards, filters by title
       ├─ src/score.js    → scores what survived, in batches
       ├─ src/search.js   → Anthropic Messages API with the web_search tool
       ├─ src/parse.js    → text blocks out of the response, fences stripped
       ├─ src/merge.js    → dedupe on url, append new, never touch existing
       ├─ commits boards.json (per-board results + why the run ended — always)
       └─ commits jobs.json (only when something new turned up)

GitHub Pages
  └─ site/index.html + site/app.js
       └─ fetch config.json, jobs.json, locals.json, statuses.json, boards.json
```

**The API key never reaches the browser.** Every call happens inside the Actions
runner using the `ANTHROPIC_API_KEY` repository secret. The published site is
static and reads only committed JSON. `search.js` also scrubs the key out of any
error text before it can reach a log line.

## Files

| Path | What it is |
|---|---|
| `config.json` | Every search setting. Editing this is the only way to change the search. |
| `companies.json` | The employer watchlist, editable in Settings, polled directly from Greenhouse, Lever, Ashby, and Workday. |
| `boards.json` | How each watched board answered on the last run, and why that run ended as it did. Written by the workflow, read by the board and Settings. |
| `jobs.json` | The board. Appended to by the workflow, never rewritten. |
| `locals.json` | Hand-curated nearby employers. The workflow does not touch it. |
| `statuses.json` | Committed statuses, written from the dashboard and shared by every browser. |
| `src/` | The workflow's Node modules and their tests. |
| `site/` | The dashboard — a sortable, filterable table. `github.js` starts runs and syncs statuses, `resume.js` tailors, `boards.js` reads a job link, `app.js` renders. |
| `build.js` | Stages `site/` plus the JSON into `_site/` for Pages and local preview. |

## Where listings come from

Two sources, deliberately different in kind.

**Company boards** (`companies.json`). A watchlist of employers polled straight
from their applicant-tracking system — Greenhouse, Lever, Ashby, and Workday all
publish free JSON with no auth. This is exhaustive for the companies on it: a role that
sits open for three weeks cannot be missed because one week's search happened
not to return it. Every URL is the employer's own, so nothing can be invented.

**Web search.** Finds employers that are not on the list. Broad, but
non-exhaustive and capped per run.

The two complement each other: search discovers, the watchlist watches.

### When a board goes dead

A company that renames its Greenhouse slug, or moves to Workday, leaves a
watchlist entry pointing at a 404. Polled weekly, that board contributes nothing
— and it looks exactly like a board with no openings, so nothing announces it.

So every run records what each board actually answered into `boards.json`, and
commits it whether the rest of the run succeeded or not — the run that first
revealed sixteen dead boards was itself a failed run. Settings reads that file
and marks the row **not answering**, with a **Find it again** button that runs
the same by-name lookup used to add a company and repoints the entry in place.

The slug is always parsed out of the URL the lookup says it found, never taken
from the model's word for it. An invented slug would poll a dead board every
week without ever announcing itself, which is the failure this exists to end.

### When a run fails

`refresh.js` records its own outcome into `boards.json` before it exits, so a
failed run commits the reason it failed alongside whatever board results it had
already gathered. The dashboard reads that and says it — "The Anthropic API key
was rejected (401)", with the fix underneath — instead of "the run finished as
failure", which is a dead end for anyone not about to go and read a workflow log.

The reason is redacted with the same scrubber `search.js` uses before it is
written, because it can contain an API error body and the repository is public.
A test asserts the key never reaches the file.

### Adding a company

In **Settings → Companies to keep an eye on**, either:

- **Type the company name.** It searches for their job board and adds it. This
  needs the Anthropic key, and it always shows the board it found so you can
  check it is the right company — similar names are common.
- **Paste a link to any job there.** Instant, and needs no key: the ATS and the
  employer's slug are both sitting in that link. Greenhouse, Lever, Ashby and
  Workday are recognised, including the `eu.` Greenhouse and Lever hosts and
  Greenhouse's embedded-board form.

Looking up by name never trusts the model's word for the slug. It is parsed out
of the URL the model says it found, through the same parser a pasted link goes
through — an invented slug would otherwise poll a dead board every week without
ever announcing itself. A URL that is not one of the three is refused rather
than saved.

A company on something else again (iCIMS, SmartRecruiters, a hand-rolled careers
page) cannot be watched employer by employer, and says so. The weekly web search
still covers them.

### Workday

Most health systems and large employers use Workday — Teladoc, UHS and Guthrie
among them — so it is worth the extra handling it needs.

A Workday board is per-tenant, so an entry carries the host as well as the site:

```json
{ "name": "Teladoc Health", "ats": "workday",
  "host": "teladoc.wd503.myworkdayjobs.com", "board": "teladochealth_is_hiring" }
```

Two differences from the other three. The listing endpoint is a POST, and it
returns titles without descriptions — so a Workday posting comes back marked for
a second request, and only the ones that survive the title filter are worth
making it for. A board with a hundred openings costs a handful of extra requests,
not a hundred. A posting whose description cannot be read is dropped rather than
scored on its title alone, which would invite the model to guess at the job.

The endpoint shape could not be exercised against the live service from the
development sandbox, whose egress is restricted. The fetcher reads field names
defensively and a wrong guess shows up as `0 posting(s)` or an HTTP error in the
run log for that one employer, never as a failed run.

The guessed name is editable, because it is what shows in the board's Company
column: `pomelohealth` guesses to "Pomelohealth", and only a person knows it
should read "Pomelo Health".

Saving commits `companies.json`. Under the hood an entry is just:

```json
{ "name": "Pomelo Care", "ats": "greenhouse", "board": "pomelocare" }
```

An unreachable or renamed board is reported in the run log and skipped — it
never fails the run.

### Keeping the cost flat

Polling 22 boards would be expensive if every posting were scored. It is not:

1. Postings already on the board are dropped by URL.
2. A title filter built from `titles` and `hardNos` drops the obvious misses —
   an engineering role at a health company never reaches the model.
3. Survivors are batched, twenty at a time, into one scoring call each.
4. Any scored listing whose URL was not one we supplied is discarded, so a
   mangled or invented URL cannot reach the board.

A typical run is one search call plus zero to two scoring calls.

## Changing the search

Everything the search uses is editable in **Settings**, in the panel itself —
home town, how far she will drive, the road factor, the salary floor, the job
titles, industries, work setup, and the things to never show. Saving commits
`config.json` through the same token the board already uses, so the board
updates immediately and the next search picks up the change.

Saving is a read-modify-write against the committed file rather than against
whatever this browser happens to be holding, so a stale tab cannot roll back a
change made somewhere else. Keys the page does not know about — `repo` — are
carried through untouched.

Values are checked before anything is written: the radius has to be 1–500 miles,
the road factor 1–3, coordinates have to be real coordinates, and there has to be
at least one job title. A bad value is refused with a plain sentence rather than
committed and left to produce a nonsense board.

Without a token the edits still apply to the board in front of you — they just
cannot be saved for the next search, and the panel says so.

## Changing the search by hand

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

You can also edit `config.json` directly. `repo` is `owner/name` — it tells the dashboard which repository to start runs
against, so the board works from GitHub Pages, a local preview, or any other
host. Everything else is search settings.

Widening the radius or moving the salary floor is a one-line edit. The workflow
interpolates these into the prompt; the dashboard recomputes distances,
in-radius flags, and salary checks client-side from the same file, so both sides
always agree.

`multiplier` turns straight-line miles into an estimated drive — 1.3 is a fair
factor for this terrain. It is an estimate, not a routed distance.

### Learning the settings from a job she likes

"Here is a role I want more of" is far easier to express than a semicolon-
separated list of target titles. **Settings → Show it a job you like** takes a
link to any posting, reads it, and proposes changes to the settings above.

The browser cannot fetch a job page itself — almost no job site sends CORS
headers — so the read happens through the Anthropic `web_fetch` tool,
server-side, and only the conclusions come back. Same key as tailoring; this
never touches the repository.

Nothing is applied automatically. Each proposal is a tick box with a one-line
reason, they land in the settings boxes when she accepts them, and she still has
to press **Save settings**. Suggestions naming a field the page does not edit —
coordinates, radius, `repo` — are discarded before they are shown: a suggestion
list is not a licence to write anywhere. Adding a title she already has is a
no-op rather than a duplicate.

If the link is a Greenhouse, Lever or Ashby board, it also offers to add that
employer to the watchlist.

A page that cannot be read says so. Server-tool failures come back as HTTP 200
with an error block rather than as an error, so that case is checked for
explicitly instead of being mistaken for an empty answer.

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
and is never committed.

### Why the token cannot just live in the repo

It is tempting to hardcode it as a default so every browser has it. That does
not work, for two independent reasons:

1. **GitHub kills it.** Push protection blocks a commit containing a
   recognisable `github_pat_*`, and secret scanning revokes any that get
   through, usually within minutes.
2. **It reaches further than the data does.** The token has
   `Contents: Read and write`, which includes `.github/workflows/job-scout.yml`
   — and that workflow runs with `ANTHROPIC_API_KEY`. Anyone holding the token
   can rewrite the workflow to print the Anthropic key in an obfuscated form.
   The job data being public is fine; this is not the same thing.

### Knowing a browser is not set up

A browser with nothing saved does not look unconfigured, it looks broken —
Refresh does nothing useful, statuses quietly fail to sync, Tailor refuses. So
the board shows a banner saying so in plain terms, with a **paste box for a
setup link** as the first thing offered: that is one paste instead of creating a
token, and it is what a second device should almost always do.

Under it, "No link? Set it up by hand" opens Settings focused on the missing
field. The paste box hides itself once the link can no longer help — a setup
link carries the sign-in bits, not the résumé.

The box applies whatever is pasted as soon as it parses, so there is no button
to find, and it stays quiet while the text is still half-typed rather than
flashing errors. It accepts the whole URL, just the fragment, or the bare
payload, because what ends up in a paste box depends on how it was shared.

The banner clears itself the moment the last piece is saved. Dismissing it is
remembered against *which* pieces were missing, so clearing one gap and leaving
another still speaks up, and it never nags about the same thing twice.

### Checking a token actually works

A token with the wrong permissions looks identical to a good one until
something silently fails to save. **Settings → Check it works** probes what the
board actually needs and reports it in plain language:

```
✓ Can see the repository
✓ Can start a search
✕ Can save statuses
    The token cannot read the statuses file. It needs the Contents
    permission set to Read and write.
```

Read access is probed directly. Write access cannot be probed without writing,
so it is reported as unproven rather than guessed at. A 404 on the statuses file
counts as healthy only when the repository itself was reachable — a token with
no access 404s on everything, and calling that green would be a false all-clear.

Settings also carries a collapsed step-by-step walkthrough for creating the
token, naming this repository explicitly and calling out the one trap: the
default **Public repositories** option is read-only and will not work.

### Getting it onto a second browser

Two ways, neither of which puts it in the repository:

- **Settings → Set up another browser → Copy setup link.** The credentials ride
  in the URL fragment. Everything after the `#` is never sent over the network,
  so it reaches no server and no request log. Open the link once in the other
  browser, confirm the prompt, and it saves itself — then the fragment is
  stripped from the address bar. Keep it as a bookmark and your browser's own
  bookmark sync carries it between devices.
- **Let a password manager hold it.** The token and key fields are real form
  fields with `autocomplete` hints and distinct usernames, so managers store and
  autofill them as two separate credentials.

A setup link is a live credential. Bookmark it; do not email it. A browser
arriving via one always asks before saving, so a link from someone else cannot
arm a browser silently.

If the token leaks, revoke it from the same GitHub settings page and issue a new
one.

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

- The résumé is loaded in Settings → Résumé and kept in `localStorage`. Choose a
  PDF and its text is pulled out in the browser; pasting still works too.
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

### Reading the PDF

`pdf.js` is vendored under `site/vendor/pdfjs/` and **loaded only when a PDF is
actually chosen**, so the 1.7MB costs nothing on a normal visit.

Why a real library rather than a small hand-written parser: résumé PDFs use
TrueType fonts with ToUnicode CMaps, and getting those wrong does not throw — it
silently yields garbled text, which would then be sent to Claude as if it were a
résumé. That failure mode is worse than the bytes. Verified against the real
résumé: 694 words, no garbled characters, line breaks intact.

A PDF with no text in it (a scan) is detected and reported rather than saved as
an empty résumé.

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
npm test        # parse, merge, ATS sources, scoring, Anthropic contract,
                #   GitHub dispatch, résumé tailoring
npm run build   # stage job-scout/_site
npm run preview # stage and serve on :8080
npm run refresh # a real search — needs ANTHROPIC_API_KEY in the environment
```

`npm run refresh` writes `jobs.json` in place. It exits non-zero on a missing
key, a non-200, or unparseable JSON, and writes nothing when nothing is new.
