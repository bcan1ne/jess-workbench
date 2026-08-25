/**
 * Starting a workflow run from the dashboard.
 *
 * The page holds a fine-grained GitHub token scoped to Actions on this
 * repository, and nothing else. It starts the run; the runner still does the
 * searching with the Anthropic key, so that key never reaches the browser and
 * new listings are still committed to jobs.json.
 *
 * Written as a UMD shim so the same code the browser loads is the code the
 * Node tests exercise.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JobScoutGitHub = api;
})(typeof self !== 'undefined' ? self : this, function () {

  var API = 'https://api.github.com';
  var WORKFLOW = 'job-scout.yml';

  /** Scrubs a token out of anything on its way to a message or the console. */
  function redact(text, token) {
    var out = String(text == null ? '' : text);
    if (token) out = out.split(token).join('[redacted]');
    return out.replace(/gh[pousr]_[A-Za-z0-9]+/g, '[redacted]')
              .replace(/github_pat_[A-Za-z0-9_]+/g, '[redacted]');
  }

  /**
   * Turns a status code into something worth reading. GitHub answers 404 rather
   * than 403 when a fine-grained token simply cannot see the repository, so the
   * two messages both have to mention permissions.
   */
  function describeError(status) {
    if (status === 401) return 'The GitHub token was rejected. Check it in Settings.';
    if (status === 403) return 'That token cannot run workflows. It needs Actions: Read and write on this repository.';
    if (status === 404) return 'Could not find the workflow. The token may not have access to this repository.';
    if (status === 422) return 'GitHub would not start the run. Check that the workflow exists on the default branch.';
    if (status === 429) return 'GitHub is rate limiting this token. Wait a minute and try again.';
    return 'GitHub returned ' + status + '.';
  }

  function ghFetch(token, path, init, fetchImpl) {
    var doFetch = fetchImpl || globalThis.fetch;
    var opts = Object.assign({}, init || {});
    opts.headers = Object.assign({
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': 'Bearer ' + token
    }, opts.headers || {});

    return doFetch(API + path, opts).then(function (res) {
      if (res.status === 204) return null;
      if (!res.ok) {
        var err = new Error(describeError(res.status));
        err.status = res.status;
        throw err;
      }
      return res.json();
    }, function (netErr) {
      throw new Error('Could not reach GitHub: ' + redact(netErr.message, token));
    });
  }

  /** The branch the workflow deploys from, so a dispatch targets the right ref. */
  function defaultBranch(token, slug, fetchImpl) {
    return ghFetch(token, '/repos/' + slug, null, fetchImpl).then(function (repo) {
      return repo.default_branch;
    });
  }

  /** Newest run id, or null when the workflow has never run. */
  function latestRunId(token, slug, fetchImpl) {
    return ghFetch(token, '/repos/' + slug + '/actions/workflows/' + WORKFLOW +
      '/runs?per_page=1', null, fetchImpl).then(function (data) {
      var runs = (data && data.workflow_runs) || [];
      return runs.length ? runs[0].id : null;
    });
  }

  /** 204 on success. Anything else throws with a mapped message. */
  function dispatch(token, slug, ref, fetchImpl) {
    return ghFetch(token, '/repos/' + slug + '/actions/workflows/' + WORKFLOW + '/dispatches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: ref })
    }, fetchImpl);
  }

  function getRun(token, slug, runId, fetchImpl) {
    return ghFetch(token, '/repos/' + slug + '/actions/runs/' + runId, null, fetchImpl);
  }

  /**
   * A dispatch returns no run id, so the run has to be found by watching for one
   * newer than whatever was newest before. Resolves null if none appears in time.
   */
  function waitForRun(token, slug, sinceId, opts) {
    var o = opts || {};
    var sleep = o.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var tries = o.tries == null ? 12 : o.tries;
    var interval = o.interval == null ? 2500 : o.interval;

    function attempt(n) {
      if (n >= tries) return Promise.resolve(null);
      return sleep(interval)
        .then(function () { return latestRunId(token, slug, o.fetchImpl); })
        .then(function (id) {
          if (id != null && id !== sinceId) return id;
          return attempt(n + 1);
        });
    }
    return attempt(0);
  }

  /**
   * Polls until the run leaves "in_progress". Resolves the finished run object,
   * or null if it outlasts the budget — web search makes these runs slow, so the
   * default budget is generous.
   */
  function waitForCompletion(token, slug, runId, opts) {
    var o = opts || {};
    var sleep = o.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var tries = o.tries == null ? 90 : o.tries;
    var interval = o.interval == null ? 5000 : o.interval;

    function attempt(n) {
      if (n >= tries) return Promise.resolve(null);
      return getRun(token, slug, runId, o.fetchImpl).then(function (run) {
        if (o.onTick) o.onTick(run);
        if (run.status === 'completed') return run;
        return sleep(interval).then(function () { return attempt(n + 1); });
      });
    }
    return attempt(0);
  }

  return {
    WORKFLOW: WORKFLOW,
    redact: redact,
    describeError: describeError,
    defaultBranch: defaultBranch,
    latestRunId: latestRunId,
    dispatch: dispatch,
    getRun: getRun,
    waitForRun: waitForRun,
    waitForCompletion: waitForCompletion
  };
});
