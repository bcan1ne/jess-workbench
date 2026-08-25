var test = require('node:test');
var assert = require('node:assert');
var R = require('../../site/resume.js');

var KEY = 'sk-ant-api03-supersecret-value';
var RESUME = 'Jane Doe\nClient Success Manager, Teladoc 2019-2024\nMBA, MS Nutrition';
var JOB = {
  fit: 9, company: 'Maven Clinic', title: 'Senior Client Success Manager',
  url: 'https://job-boards.greenhouse.io/mavenclinic/jobs/1',
  salary: 'Not posted', salaryMin: null, setup: 'Remote', location: 'Remote - USA',
  industry: 'Virtual maternity', why: 'Domain bullseye.', watchOuts: 'No salary posted.'
};

function res(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status: status,
    json: function () { return Promise.resolve(body); }
  });
}
function textReply(t) { return res(200, { content: [{ type: 'text', text: t }] }); }

test('the prompt carries both the résumé and the posting', function () {
  var p = R.buildPrompt(RESUME, JOB);
  assert.match(p, /CURRENT RÉSUMÉ/);
  assert.match(p, /Client Success Manager, Teladoc/);
  assert.match(p, /TARGET ROLE/);
  assert.match(p, /Maven Clinic/);
  assert.match(p, /Senior Client Success Manager/);
  assert.match(p, /No salary posted\./);
});

test('the prompt forbids invention — the thing that would make this dangerous', function () {
  var p = R.buildPrompt(RESUME, JOB);
  assert.match(p, /Never invent employers, titles, dates, degrees, certifications, metrics/);
  assert.match(p, /Every claim must trace to something already in the résumé/);
  assert.match(p, /leave the gap alone rather than papering over it/);
});

test('a job with missing fields still produces a usable brief', function () {
  var brief = R.jobBrief({ title: 'CSM' });
  assert.match(brief, /Title: CSM/);
  assert.match(brief, /Posted salary: not posted/);
  assert.match(brief, /Known gaps and watch-outs: none noted/);
});

test('the browser-access header is sent, or Anthropic refuses the request', async function () {
  var seen;
  await R.tailor(KEY, RESUME, JOB, function (url, opts) {
    seen = { url: url, opts: opts, body: JSON.parse(opts.body) };
    return textReply('# Résumé');
  });
  assert.strictEqual(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(seen.opts.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.strictEqual(seen.opts.headers['anthropic-version'], '2023-06-01');
  assert.strictEqual(seen.opts.headers['x-api-key'], KEY);
  assert.strictEqual(seen.body.model, 'claude-opus-5');
});

test('no web_search tool is declared — this call only rewrites what it was given', async function () {
  var body;
  await R.tailor(KEY, RESUME, JOB, function (url, opts) {
    body = JSON.parse(opts.body);
    return textReply('# Résumé');
  });
  assert.ok(!body.tools, 'tailoring must not be able to go looking for facts');
});

test('text blocks are joined rather than indexed', async function () {
  var out = await R.tailor(KEY, RESUME, JOB, function () {
    return res(200, { content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: '# Jane Doe' },
      { type: 'text', text: 'Tailored body' }
    ] });
  });
  assert.match(out.resume, /# Jane Doe/);
  assert.match(out.resume, /Tailored body/);
});

test('the rationale is split off from the résumé itself', function () {
  var out = R.splitResult('# Jane Doe\n\nExperience...\n\n## What changed and why\n- Promoted maternity work\n- Cut the retail job');
  assert.match(out.resume, /# Jane Doe/);
  assert.ok(out.resume.indexOf('What changed') === -1, 'the notes heading must not stay in the résumé');
  assert.match(out.notes, /Promoted maternity work/);
});

test('a response with no rationale section still yields a résumé', function () {
  var out = R.splitResult('# Jane Doe\n\nExperience...');
  assert.match(out.resume, /Jane Doe/);
  assert.strictEqual(out.notes, '');
});

test('the heading is matched case-insensitively and at any depth', function () {
  ['## What changed and why', '### what changed AND why', '# What Changed and Why'].forEach(function (h) {
    var out = R.splitResult('Body text\n\n' + h + '\n- a change');
    assert.strictEqual(out.resume, 'Body text', 'failed for ' + h);
    assert.match(out.notes, /a change/);
  });
});

test('a 401 is distinguished from every other failure', async function () {
  await assert.rejects(
    R.tailor(KEY, RESUME, JOB, function () { return res(401, {}); }),
    /Anthropic key was rejected/);
  assert.match(R.describeError(429), /Rate limited/);
  assert.match(R.describeError(400), /may be too long/);
  assert.match(R.describeError(503), /returned 503/);
});

test('the key never appears in an error message', async function () {
  for (var status of [400, 401, 403, 429, 500]) {
    var err = await R.tailor(KEY, RESUME, JOB, (function (st) {
      return function () { return res(st, { error: { message: 'bad key ' + KEY } }); };
    })(status)).then(function () { return null; }, function (e) { return e; });
    assert.ok(err, 'expected a rejection for ' + status);
    assert.ok(err.message.indexOf(KEY) === -1, 'key leaked into a ' + status + ' message');
  }
});

test('a network failure is wrapped and redacted', async function () {
  var err = await R.tailor(KEY, RESUME, JOB, function () {
    return Promise.reject(new Error('DNS failed for ' + KEY));
  }).then(function () { return null; }, function (e) { return e; });
  assert.match(err.message, /Could not reach Anthropic/);
  assert.ok(err.message.indexOf(KEY) === -1);
});

test('redact catches a key it was not handed', function () {
  assert.strictEqual(R.redact('leaked sk-ant-api03-abc_DEF-123 here'), 'leaked [redacted] here');
});

test('a missing key or résumé fails before any request is made', async function () {
  var called = false;
  var spy = function () { called = true; return textReply('x'); };
  await assert.rejects(R.tailor('', RESUME, JOB, spy), /Add an Anthropic key/);
  await assert.rejects(R.tailor(KEY, '', JOB, spy), /Add a résumé/);
  await assert.rejects(R.tailor(KEY, '   ', JOB, spy), /Add a résumé/);
  assert.strictEqual(called, false, 'must not spend a request on a known-bad input');
});

test('an empty response is reported rather than shown as a blank résumé', async function () {
  await assert.rejects(
    R.tailor(KEY, RESUME, JOB, function () { return res(200, { content: [] }); }),
    /empty response/);
});
