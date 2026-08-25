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

/* ------------------------------------------------ committed status syncing */

function contentsRes(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status: status,
    json: function () { return Promise.resolve(body); }
  });
}

function fileBody(obj, sha) {
  return { content: GH.b64encode(JSON.stringify(obj)), sha: sha || 'sha1' };
}

test('base64 round-trips non-ascii', function () {
  var s = JSON.stringify({ 'https://a/1': 'Applied', 'note': 'café — résumé' });
  assert.strictEqual(GH.b64decode(GH.b64encode(s)), s);
});

test('b64decode tolerates the newlines GitHub wraps content in', function () {
  var raw = GH.b64encode('{"a":1}');
  var wrapped = raw.slice(0, 4) + '\n' + raw.slice(4);
  assert.strictEqual(GH.b64decode(wrapped), '{"a":1}');
});

test('readJsonFile decodes content and returns the sha', async function () {
  var out = await GH.readJsonFile(TOKEN, SLUG, 'job-scout/statuses.json', null, function () {
    return contentsRes(200, fileBody({ 'https://a/1': 'Applied' }, 'abc'));
  });
  assert.deepStrictEqual(out.data, { 'https://a/1': 'Applied' });
  assert.strictEqual(out.sha, 'abc');
});

test('a missing file is a starting state, not an error', async function () {
  var out = await GH.readJsonFile(TOKEN, SLUG, 'job-scout/statuses.json', null,
    function () { return contentsRes(404, {}); });
  assert.deepStrictEqual(out, { data: null, sha: null });
});

test('a 403 while reading still propagates', async function () {
  await assert.rejects(
    GH.readJsonFile(TOKEN, SLUG, 'job-scout/statuses.json', null,
      function () { return contentsRes(403, {}); }),
    /Actions: Read and write|not accessible|cannot run/);
});

test('corrupt committed JSON is reported rather than silently ignored', async function () {
  await assert.rejects(
    GH.readJsonFile(TOKEN, SLUG, 'job-scout/statuses.json', null, function () {
      return contentsRes(200, { content: GH.b64encode('{not json'), sha: 'x' });
    }),
    /not valid JSON/);
});

test('patchJsonMap sets one key and sends the sha back', async function () {
  var put;
  await GH.patchJsonMap(TOKEN, SLUG, 'job-scout/statuses.json', 'main',
    'https://b/2', 'Screening', {
      fetchImpl: function (url, opts) {
        if (!opts || opts.method !== 'PUT') return contentsRes(200, fileBody({ 'https://a/1': 'Applied' }, 'abc'));
        put = JSON.parse(opts.body);
        return contentsRes(200, {});
      }
    });
  assert.strictEqual(put.sha, 'abc');
  assert.strictEqual(put.branch, 'main');
  assert.deepStrictEqual(JSON.parse(GH.b64decode(put.content)), {
    'https://a/1': 'Applied',
    'https://b/2': 'Screening'
  });
});

test('a change from a stale copy does not clobber another device', async function () {
  // This browser never saw https://c/3; the write must preserve it.
  var put;
  await GH.patchJsonMap(TOKEN, SLUG, 'job-scout/statuses.json', null,
    'https://a/1', 'Offer', {
      fetchImpl: function (url, opts) {
        if (!opts || opts.method !== 'PUT') {
          return contentsRes(200, fileBody({ 'https://a/1': 'Applied', 'https://c/3': 'Passed' }, 'abc'));
        }
        put = JSON.parse(opts.body);
        return contentsRes(200, {});
      }
    });
  var written = JSON.parse(GH.b64decode(put.content));
  assert.strictEqual(written['https://c/3'], 'Passed', 'another device\'s status was clobbered');
  assert.strictEqual(written['https://a/1'], 'Offer');
});

test('a null value removes the key', async function () {
  var put;
  await GH.patchJsonMap(TOKEN, SLUG, 'job-scout/statuses.json', null, 'https://a/1', null, {
    fetchImpl: function (url, opts) {
      if (!opts || opts.method !== 'PUT') return contentsRes(200, fileBody({ 'https://a/1': 'Applied', 'https://b/2': 'Offer' }, 'abc'));
      put = JSON.parse(opts.body);
      return contentsRes(200, {});
    }
  });
  assert.deepStrictEqual(JSON.parse(GH.b64decode(put.content)), { 'https://b/2': 'Offer' });
});

test('creating the file for the first time sends no sha', async function () {
  var put;
  await GH.patchJsonMap(TOKEN, SLUG, 'job-scout/statuses.json', null, 'https://a/1', 'Applied', {
    fetchImpl: function (url, opts) {
      if (!opts || opts.method !== 'PUT') return contentsRes(404, {});
      put = JSON.parse(opts.body);
      return contentsRes(201, {});
    }
  });
  assert.ok(!('sha' in put), 'a create must not carry a sha');
  assert.deepStrictEqual(JSON.parse(GH.b64decode(put.content)), { 'https://a/1': 'Applied' });
});

test('a sha conflict is re-read and retried, and the retry wins', async function () {
  var puts = 0, reads = 0, written;
  await GH.patchJsonMap(TOKEN, SLUG, 'job-scout/statuses.json', null, 'https://a/1', 'Offer', {
    fetchImpl: function (url, opts) {
      if (!opts || opts.method !== 'PUT') {
        reads++;
        // Second read reflects the other device's commit and a fresh sha.
        return contentsRes(200, reads === 1
          ? fileBody({}, 'stale')
          : fileBody({ 'https://z/9': 'Applied' }, 'fresh'));
      }
      puts++;
      var body = JSON.parse(opts.body);
      if (body.sha === 'stale') return contentsRes(409, {});
      written = body;
      return contentsRes(200, {});
    }
  });
  assert.strictEqual(puts, 2);
  assert.strictEqual(written.sha, 'fresh');
  assert.deepStrictEqual(JSON.parse(GH.b64decode(written.content)), {
    'https://z/9': 'Applied',
    'https://a/1': 'Offer'
  });
});

test('a 422 is treated as a conflict too', async function () {
  var puts = 0;
  await GH.patchJsonMap(TOKEN, SLUG, 'job-scout/statuses.json', null, 'https://a/1', 'Offer', {
    fetchImpl: function (url, opts) {
      if (!opts || opts.method !== 'PUT') return contentsRes(200, fileBody({}, 'sha' + puts));
      puts++;
      return puts === 1 ? contentsRes(422, {}) : contentsRes(200, {});
    }
  });
  assert.strictEqual(puts, 2);
});

test('endless conflicts give up with a message rather than looping', async function () {
  var puts = 0;
  await assert.rejects(
    GH.patchJsonMap(TOKEN, SLUG, 'job-scout/statuses.json', null, 'https://a/1', 'Offer', {
      attempts: 3,
      fetchImpl: function (url, opts) {
        if (!opts || opts.method !== 'PUT') return contentsRes(200, fileBody({}, 'x'));
        puts++;
        return contentsRes(409, {});
      }
    }),
    /Another device is editing statuses/);
  assert.strictEqual(puts, 3, 'must stop at the attempt budget');
});

test('a permissions failure on write is not retried as a conflict', async function () {
  var puts = 0;
  await assert.rejects(
    GH.patchJsonMap(TOKEN, SLUG, 'job-scout/statuses.json', null, 'https://a/1', 'Offer', {
      fetchImpl: function (url, opts) {
        if (!opts || opts.method !== 'PUT') return contentsRes(200, fileBody({}, 'x'));
        puts++;
        return contentsRes(403, {});
      }
    }),
    /Actions: Read and write/);
  assert.strictEqual(puts, 1, 'a 403 must fail fast');
});

/* ------------------------------------------------------------ token health */

test('a healthy token reports all three checks green', async function () {
  var out = await GH.checkToken(TOKEN, SLUG, 'job-scout/statuses.json',
    function () { return contentsRes(200, { default_branch: 'main', content: GH.b64encode('{}'), sha: 'x' }); });
  assert.strictEqual(out.length, 3);
  assert.ok(out.every(function (r) { return r.ok; }));
  assert.deepStrictEqual(out.map(function (r) { return r.key; }), ['repo', 'actions', 'contents']);
});

test('the "Public repositories" mistake is named, not just reported as 404', async function () {
  var out = await GH.checkToken(TOKEN, SLUG, 'job-scout/statuses.json',
    function () { return contentsRes(404, {}); });
  assert.strictEqual(out[0].ok, false);
  assert.match(out[0].fix, /Only select repositories/);
});

test('a token missing Actions is told exactly which permission to change', async function () {
  var out = await GH.checkToken(TOKEN, SLUG, 'job-scout/statuses.json', function (url) {
    if (url.indexOf('/actions/') !== -1) return contentsRes(403, {});
    return contentsRes(200, { content: GH.b64encode('{}'), sha: 'x' });
  });
  var actions = out.filter(function (r) { return r.key === 'actions'; })[0];
  assert.strictEqual(actions.ok, false);
  assert.match(actions.fix, /Actions permission set to Read and write/);
  assert.strictEqual(out.filter(function (r) { return r.key === 'contents'; })[0].ok, true,
    'one failing probe must not fail the others');
});

test('a token missing Contents is told which permission to change', async function () {
  var out = await GH.checkToken(TOKEN, SLUG, 'job-scout/statuses.json', function (url) {
    if (url.indexOf('/contents/') !== -1) return contentsRes(403, {});
    return contentsRes(200, {});
  });
  var contents = out.filter(function (r) { return r.key === 'contents'; })[0];
  assert.strictEqual(contents.ok, false);
  assert.match(contents.fix, /Contents permission set to Read and write/);
});

test('a board with no statuses yet is healthy, not broken', async function () {
  // 404 on the statuses file means nothing has been saved, which is the normal
  // starting state — it must not be reported as a permissions problem.
  var out = await GH.checkToken(TOKEN, SLUG, 'job-scout/statuses.json', function (url) {
    if (url.indexOf('/contents/') !== -1) return contentsRes(404, {});
    return contentsRes(200, {});
  });
  var contents = out.filter(function (r) { return r.key === 'contents'; })[0];
  assert.strictEqual(contents.ok, true);
  assert.match(contents.note, /no statuses saved yet/);
});

test('a rejected token fails every check with the 401 message', async function () {
  var out = await GH.checkToken(TOKEN, SLUG, 'job-scout/statuses.json',
    function () { return contentsRes(401, {}); });
  assert.ok(out.every(function (r) { return !r.ok; }));
  assert.match(out[0].detail, /token was rejected/);
});

test('a token with no access at all reports every check red, not a false all-clear', async function () {
  // GitHub 404s on everything when a token cannot see the repository, so the
  // "missing statuses file" leniency must not turn that into a green tick.
  var out = await GH.checkToken(TOKEN, SLUG, 'job-scout/statuses.json',
    function () { return contentsRes(404, {}); });
  assert.ok(out.every(function (r) { return !r.ok; }),
    'a completely blind token must not report any check as working');
  assert.ok(!out.some(function (r) { return r.note; }), 'no "fresh board" note either');
});
