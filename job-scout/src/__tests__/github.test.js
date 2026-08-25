var test = require('node:test');
var assert = require('node:assert');
var GH = require('../../site/github.js');

var SLUG = 'bcan1ne/jess-workbench';
var TOKEN = 'github_pat_11ABCDEFG_secretvalue';

function res(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status: status,
    json: function () { return Promise.resolve(body); }
  });
}

var nap = function () { return Promise.resolve(); };

test('dispatch posts the ref to the workflow dispatch endpoint', async function () {
  var seen;
  await GH.dispatch(TOKEN, SLUG, 'main', function (url, opts) {
    seen = { url: url, opts: opts, body: JSON.parse(opts.body) };
    return res(204, null);
  });
  assert.strictEqual(seen.url,
    'https://api.github.com/repos/bcan1ne/jess-workbench/actions/workflows/job-scout.yml/dispatches');
  assert.strictEqual(seen.opts.method, 'POST');
  assert.deepStrictEqual(seen.body, { ref: 'main' });
});

test('every request carries the auth and api-version headers', async function () {
  var seen;
  await GH.dispatch(TOKEN, SLUG, 'main', function (url, opts) { seen = opts; return res(204, null); });
  assert.strictEqual(seen.headers.Authorization, 'Bearer ' + TOKEN);
  assert.strictEqual(seen.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.strictEqual(seen.headers.Accept, 'application/vnd.github+json');
});

test('a 204 resolves rather than trying to parse a body', async function () {
  var out = await GH.dispatch(TOKEN, SLUG, 'main', function () {
    return Promise.resolve({
      ok: true, status: 204,
      json: function () { return Promise.reject(new Error('no body to parse')); }
    });
  });
  assert.strictEqual(out, null);
});

test('401 and 403 get different messages', function () {
  assert.match(GH.describeError(401), /token was rejected/);
  assert.match(GH.describeError(403), /Actions: Read and write/);
});

test('404 mentions permissions — a fine-grained token with no access gets 404, not 403', function () {
  assert.match(GH.describeError(404), /may not have access/);
});

test('422 and 429 are distinguishable from a generic failure', function () {
  assert.match(GH.describeError(422), /would not start the run/);
  assert.match(GH.describeError(429), /rate limiting/);
  assert.match(GH.describeError(500), /returned 500/);
});

test('a failing status rejects with the mapped message and the code attached', async function () {
  var err = await GH.dispatch(TOKEN, SLUG, 'main', function () { return res(403, {}); })
    .then(function () { return null; }, function (e) { return e; });
  assert.ok(err);
  assert.strictEqual(err.status, 403);
  assert.match(err.message, /Actions: Read and write/);
});

test('the token never appears in an error message', async function () {
  for (var status of [401, 403, 404, 422, 500]) {
    var err = await GH.dispatch(TOKEN, SLUG, 'main', (function (s) {
      return function () { return res(s, { message: 'bad credentials ' + TOKEN }); };
    })(status)).then(function () { return null; }, function (e) { return e; });
    assert.ok(err.message.indexOf(TOKEN) === -1, 'token leaked into a ' + status + ' message');
  }
});

test('a network failure is wrapped and redacted', async function () {
  var err = await GH.dispatch(TOKEN, SLUG, 'main', function () {
    return Promise.reject(new Error('connect failed for ' + TOKEN));
  }).then(function () { return null; }, function (e) { return e; });
  assert.match(err.message, /Could not reach GitHub/);
  assert.ok(err.message.indexOf(TOKEN) === -1);
});

test('redact scrubs both token formats even without the exact value', function () {
  assert.strictEqual(GH.redact('use github_pat_11ABC_xyz now'), 'use [redacted] now');
  assert.strictEqual(GH.redact('use ghp_abc123DEF now'), 'use [redacted] now');
  assert.strictEqual(GH.redact('leaked ' + TOKEN, TOKEN), 'leaked [redacted]');
});

test('defaultBranch reads the branch the deploy job needs', async function () {
  var b = await GH.defaultBranch(TOKEN, SLUG, function () {
    return res(200, { default_branch: 'claude/new-session-pu4xik' });
  });
  assert.strictEqual(b, 'claude/new-session-pu4xik');
});

test('latestRunId returns null when the workflow has never run', async function () {
  var id = await GH.latestRunId(TOKEN, SLUG, function () { return res(200, { workflow_runs: [] }); });
  assert.strictEqual(id, null);
});

test('latestRunId returns the newest run id', async function () {
  var id = await GH.latestRunId(TOKEN, SLUG, function () {
    return res(200, { workflow_runs: [{ id: 42 }, { id: 41 }] });
  });
  assert.strictEqual(id, 42);
});

test('waitForRun holds out for an id different from the one before the dispatch', async function () {
  var seq = [7, 7, 9];
  var i = 0;
  var id = await GH.waitForRun(TOKEN, SLUG, 7, {
    sleep: nap, tries: 5,
    fetchImpl: function () { return res(200, { workflow_runs: [{ id: seq[i++] }] }); }
  });
  assert.strictEqual(id, 9, 'must not return the pre-dispatch run');
});

test('waitForRun gives up rather than hanging forever', async function () {
  var id = await GH.waitForRun(TOKEN, SLUG, 7, {
    sleep: nap, tries: 3,
    fetchImpl: function () { return res(200, { workflow_runs: [{ id: 7 }] }); }
  });
  assert.strictEqual(id, null);
});

test('waitForRun treats a first-ever run as new', async function () {
  var id = await GH.waitForRun(TOKEN, SLUG, null, {
    sleep: nap, tries: 3,
    fetchImpl: function () { return res(200, { workflow_runs: [{ id: 5 }] }); }
  });
  assert.strictEqual(id, 5);
});

test('waitForCompletion polls until the run leaves in_progress', async function () {
  var states = [
    { status: 'queued' },
    { status: 'in_progress' },
    { status: 'completed', conclusion: 'success' }
  ];
  var i = 0;
  var ticks = 0;
  var run = await GH.waitForCompletion(TOKEN, SLUG, 9, {
    sleep: nap, tries: 10,
    onTick: function () { ticks++; },
    fetchImpl: function () { return res(200, states[i++]); }
  });
  assert.strictEqual(run.conclusion, 'success');
  assert.strictEqual(ticks, 3);
});

test('waitForCompletion surfaces a failed run rather than treating it as success', async function () {
  var run = await GH.waitForCompletion(TOKEN, SLUG, 9, {
    sleep: nap, tries: 3,
    fetchImpl: function () { return res(200, { status: 'completed', conclusion: 'failure' }); }
  });
  assert.strictEqual(run.conclusion, 'failure');
});

test('waitForCompletion returns null when the run outlasts the budget', async function () {
  var run = await GH.waitForCompletion(TOKEN, SLUG, 9, {
    sleep: nap, tries: 3,
    fetchImpl: function () { return res(200, { status: 'in_progress' }); }
  });
  assert.strictEqual(run, null);
});
