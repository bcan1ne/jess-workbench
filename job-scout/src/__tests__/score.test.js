var test = require('node:test');
var assert = require('node:assert');
var SC = require('../score');

var CFG = {
  minSalary: 100000, workSetup: 'Remote preferred', radius: 20, homeLabel: 'Friendsville, PA',
  industry: 'Healthcare / digital health', titles: 'Client Success Manager', hardNos: 'commission-only'
};
var POSTINGS = [
  { company: 'Maven Clinic', title: 'Client Success Manager', url: 'https://boards.greenhouse.io/mavenclinic/jobs/1',
    location: 'Remote - USA', postedAt: '2026-08-20', description: 'Own employer accounts. $120,000-$150,000.' },
  { company: 'Cedar', title: 'Implementation Manager', url: 'https://boards.greenhouse.io/cedar/jobs/2',
    location: 'Remote', postedAt: '2026-08-19', description: 'Launch clients.' }
];

test('the prompt carries every posting with its url', function () {
  var p = SC.buildPrompt(CFG, POSTINGS);
  assert.match(p, /POSTING 1/);
  assert.match(p, /POSTING 2/);
  assert.match(p, /boards\.greenhouse\.io\/mavenclinic\/jobs\/1/);
  assert.match(p, /Own employer accounts/);
});

test('the prompt tells the model not to search — these are already verified', function () {
  var p = SC.buildPrompt(CFG, POSTINGS);
  assert.match(p, /already verified as live — do not search/);
  assert.match(p, /Copy each url through exactly as given\. Never invent or alter one\./);
});

test('the prompt reuses the tuned candidate profile', function () {
  var p = SC.buildPrompt(CFG, POSTINGS);
  assert.match(p, /Client success and implementation professional in digital health/);
  assert.match(p, /MBA plus MS in Entrepreneurial/);
});

test('config drives the requirements block', function () {
  var p = SC.buildPrompt(CFG, POSTINGS);
  assert.match(p, /Minimum base salary: 100000/);
  assert.match(p, /within 20 driving miles of Friendsville, PA/);
});

test('very long descriptions are truncated so one posting cannot eat the window', function () {
  var big = [{ company: 'X', title: 'T', url: 'u', description: 'x'.repeat(9000) }];
  assert.ok(SC.buildPrompt(CFG, big).length < 6000);
});

test('batching keeps a large poll within one request each', function () {
  var many = Array.from({ length: 47 }, function (_, i) { return { url: 'u' + i }; });
  var b = SC.batches(many);
  assert.strictEqual(b.length, 3);
  assert.strictEqual(b[0].length, 20);
  assert.strictEqual(b[2].length, 7);
  assert.strictEqual(b.reduce(function (n, g) { return n + g.length; }, 0), 47);
});

test('an empty list produces no batches and therefore no API call', function () {
  assert.deepStrictEqual(SC.batches([]), []);
});

test('a scored listing whose url we never supplied is discarded', function () {
  var scored = [
    { url: 'https://boards.greenhouse.io/mavenclinic/jobs/1', fit: 9 },
    { url: 'https://invented.example/job/999', fit: 10 },
    { url: 'https://boards.greenhouse.io/cedar/jobs/2', fit: 7 }
  ];
  var kept = SC.keepKnownUrls(scored, POSTINGS);
  assert.strictEqual(kept.length, 2);
  assert.ok(!kept.some(function (j) { return j.url.indexOf('invented') !== -1; }),
    'an invented url must never reach the board');
});

test('a url altered even slightly is discarded', function () {
  var kept = SC.keepKnownUrls(
    [{ url: 'https://boards.greenhouse.io/mavenclinic/jobs/1/' }], POSTINGS);
  assert.strictEqual(kept.length, 0);
});

test('keepKnownUrls survives junk', function () {
  assert.deepStrictEqual(SC.keepKnownUrls(null, POSTINGS), []);
  assert.deepStrictEqual(SC.keepKnownUrls([null, {}, { url: '' }], POSTINGS), []);
});

test('a 401 is reported distinctly here too', async function () {
  await assert.rejects(
    SC.scoreBatch('bad', CFG, POSTINGS, function () {
      return Promise.resolve({ ok: false, status: 401, text: function () { return Promise.resolve('nope'); } });
    }), /key was rejected \(401\)/);
});

test('the key never appears in an error message', async function () {
  var KEY = 'sk-ant-scoring-secret';
  for (var status of [401, 429, 500]) {
    var err = await SC.scoreBatch(KEY, CFG, POSTINGS, (function (s) {
      return function () {
        return Promise.resolve({ ok: false, status: s, text: function () { return Promise.resolve('boom ' + KEY); } });
      };
    })(status)).then(function () { return null; }, function (e) { return e; });
    assert.ok(err.message.indexOf(KEY) === -1, 'key leaked in a ' + status);
  }
});

test('the scoring call declares no web_search tool', async function () {
  var body;
  await SC.scoreBatch('k', CFG, POSTINGS, function (url, opts) {
    body = JSON.parse(opts.body);
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ content: [] }); } });
  });
  assert.ok(!body.tools, 'scoring must judge only what it was handed');
});
