var test = require('node:test');
var assert = require('node:assert');
var { buildPrompt, searchJobs } = require('../search');

var CFG = {
  radius: 20, lat: 41.79, lon: -76.008, multiplier: 1.3, minSalary: 100000,
  homeLabel: 'Friendsville, PA', industry: 'Healthcare / digital health (open to adjacent)',
  titles: 'Client Success Manager; Implementation Manager',
  workSetup: 'Remote preferred; on-site or hybrid acceptable inside radius',
  hardNos: 'Relocation required; commission-only; clinical licensure required'
};

function ok(body) {
  return function () {
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };
}

test('config values are interpolated into the prompt', function () {
  var p = buildPrompt(CFG, []);
  assert.match(p, /Minimum base salary: 100000/);
  assert.match(p, /within 20 driving miles of Friendsville, PA/);
  assert.match(p, /Client Success Manager; Implementation Manager/);
  assert.match(p, /Exclude: Relocation required/);
});

test('the tuned rules survive the port', function () {
  var p = buildPrompt(CFG, []);
  assert.match(p, /Only postings you have verified are currently open\. Never invent a listing or a URL\./);
  assert.match(p, /Prefer employer career pages and ATS boards \(Greenhouse, Lever, Ashby\) over aggregators\./);
  assert.match(p, /Skip LinkedIn and Indeed links\./);
});

test('already-seen urls are embedded so the model skips them', function () {
  var p = buildPrompt(CFG, ['https://a.com/1', 'https://b.com/2']);
  assert.match(p, /already-seen list/);
  assert.match(p, /https:\/\/a\.com\/1/);
});

test('the request carries the model, version header, and web_search tool', async function () {
  var captured;
  await searchJobs('sk-ant-test', CFG, [], function (url, opts) {
    captured = { url: url, opts: opts, body: JSON.parse(opts.body) };
    return ok({ content: [] })();
  });
  assert.strictEqual(captured.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(captured.opts.headers['anthropic-version'], '2023-06-01');
  assert.strictEqual(captured.opts.headers['x-api-key'], 'sk-ant-test');
  assert.strictEqual(captured.body.model, 'claude-sonnet-4-6');
  assert.deepStrictEqual(captured.body.tools, [{ type: 'web_search_20250305', name: 'web_search' }]);
});

test('a 401 is reported distinctly from other failures', async function () {
  await assert.rejects(
    searchJobs('bad-key', CFG, [], function () {
      return Promise.resolve({ ok: false, status: 401, text: function () { return Promise.resolve('unauthorized'); } });
    }),
    /key was rejected \(401\)/);
});

test('a 500 is reported as a plain API failure', async function () {
  await assert.rejects(
    searchJobs('sk-ant-test', CFG, [], function () {
      return Promise.resolve({ ok: false, status: 500, text: function () { return Promise.resolve('overloaded'); } });
    }),
    /returned 500/);
});

test('the api key never appears in an error message', async function () {
  var KEY = 'sk-ant-supersecret-value';
  for (var status of [401, 429, 500]) {
    var err = await searchJobs(KEY, CFG, [], (function (s) {
      return function () {
        return Promise.resolve({ ok: false, status: s, text: function () { return Promise.resolve('boom ' + KEY); } });
      };
    })(status)).then(function () { return null; }, function (e) { return e; });
    assert.ok(err, 'expected a rejection for ' + status);
    assert.ok(err.message.indexOf(KEY) === -1, 'key leaked into a ' + status + ' message');
  }
});

test('a network failure is wrapped, not thrown raw', async function () {
  await assert.rejects(
    searchJobs('sk-ant-test', CFG, [], function () { return Promise.reject(new Error('ECONNRESET')); }),
    /Could not reach the Anthropic API/);
});
