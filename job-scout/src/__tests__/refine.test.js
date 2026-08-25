var test = require('node:test');
var assert = require('node:assert');
var R = require('../../site/refine.js');

var KEY = 'sk-ant-api03-REFINE-secret';
var CFG = {
  titles: 'Client Success Manager; Implementation Manager',
  industry: 'Healthcare / digital health',
  workSetup: 'Remote preferred',
  hardNos: 'Relocation required; commission-only',
  minSalary: 100000
};
var URL = 'https://job-boards.greenhouse.io/mavenclinic/jobs/1';

function res(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300, status: status,
    json: function () { return Promise.resolve(body); }
  });
}
function textReply(t, extra) {
  return res(200, { content: (extra || []).concat([{ type: 'text', text: t }]) });
}
var GOOD = JSON.stringify({
  readable: true, problem: '',
  role: { title: 'Partner Success Lead', company: 'Maven', salary: '$130,000 - $160,000',
          salaryMin: 130000, setup: 'Remote', industry: 'Virtual maternity', summary: 'Owns partners.' },
  suggestions: [
    { field: 'titles', action: 'add', value: 'Partner Success Lead', why: 'This role is titled that.' },
    { field: 'minSalary', action: 'replace', value: 130000, why: 'This one starts higher.' }
  ]
});

/* ------------------------------------------------------------- prompt */

test('the prompt carries the url and the settings as they stand', function () {
  var p = R.buildPrompt(URL, CFG);
  assert.match(p, /job-boards\.greenhouse\.io\/mavenclinic\/jobs\/1/);
  assert.match(p, /Client Success Manager; Implementation Manager/);
  assert.match(p, /Minimum salary: 100000/);
});

test('the prompt forbids inventing work and forbids cutting the salary floor', function () {
  var p = R.buildPrompt(URL, CFG);
  assert.match(p, /return no suggestions rather than inventing work/);
  assert.match(p, /Never suggest lowering the minimum salary below what this posting pays/);
});

test('empty settings are described rather than left blank', function () {
  assert.match(R.buildPrompt(URL, {}), /Target titles: \(none\)/);
});

/* --------------------------------------------------------------- call */

test('web_fetch is declared, which is what gets round CORS', async function () {
  var body;
  await R.refineFrom(KEY, URL, CFG, function (url, opts) {
    body = JSON.parse(opts.body);
    return textReply(GOOD);
  });
  assert.deepStrictEqual(body.tools, [{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3 }]);
  assert.strictEqual(body.model, 'claude-opus-5');
});

test('the browser-access header is sent', async function () {
  var headers;
  await R.refineFrom(KEY, URL, CFG, function (url, opts) {
    headers = opts.headers; return textReply(GOOD);
  });
  assert.strictEqual(headers['anthropic-dangerous-direct-browser-access'], 'true');
});

test('a missing key or a non-url fails before spending a request', async function () {
  var called = false;
  var spy = function () { called = true; return textReply(GOOD); };
  await assert.rejects(R.refineFrom('', URL, CFG, spy), /Add an Anthropic key/);
  await assert.rejects(R.refineFrom(KEY, 'maven jobs', CFG, spy), /starting with https/);
  await assert.rejects(R.refineFrom(KEY, '', CFG, spy), /starting with https/);
  assert.strictEqual(called, false);
});

/* ------------------------------------------------------------ results */

test('a good answer yields the role and its suggestions', async function () {
  var out = await R.refineFrom(KEY, URL, CFG, function () { return textReply(GOOD); });
  assert.strictEqual(out.role.company, 'Maven');
  assert.strictEqual(out.suggestions.length, 2);
  assert.strictEqual(out.suggestions[1].value, 130000, 'salary comes back as a number');
});

test('markdown fences are stripped', async function () {
  var out = await R.refineFrom(KEY, URL, CFG, function () {
    return textReply('```json\n' + GOOD + '\n```');
  });
  assert.strictEqual(out.suggestions.length, 2);
});

test('a settings-already-fine answer is not an error', async function () {
  var out = await R.refineFrom(KEY, URL, CFG, function () {
    return textReply(JSON.stringify({ readable: true, role: { title: 'X' }, suggestions: [] }));
  });
  assert.deepStrictEqual(out.suggestions, []);
});

/* --------------------------------------------------- refusing to overreach */

test('a suggestion naming a field we do not edit is dropped', function () {
  // The settings are hers; a suggestion list is not a licence to write anywhere.
  var out = R.sanitise([
    { field: 'lat', action: 'replace', value: 0 },
    { field: 'radius', action: 'replace', value: 500 },
    { field: 'repo', action: 'replace', value: 'someone/else' },
    { field: 'titles', action: 'add', value: 'Partner Success' }
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].field, 'titles');
});

test('empty or unparseable values are dropped', function () {
  assert.deepStrictEqual(R.sanitise([
    { field: 'titles', action: 'add', value: '' },
    { field: 'titles', action: 'add', value: null },
    { field: 'minSalary', action: 'replace', value: 'lots' }
  ]), []);
});

test('an unknown action falls back to add rather than replacing her settings', function () {
  assert.strictEqual(R.sanitise([{ field: 'titles', action: 'obliterate', value: 'X' }])[0].action, 'add');
});

test('junk instead of a list is survivable', function () {
  assert.deepStrictEqual(R.sanitise(null), []);
  assert.deepStrictEqual(R.sanitise('nope'), []);
  assert.deepStrictEqual(R.sanitise([null, {}, 3]), []);
});

/* ------------------------------------------------------------ applying */

test('adding a title appends rather than replacing the list', function () {
  var next = R.applySuggestion(CFG, { field: 'titles', action: 'add', value: 'Partner Success Lead' });
  assert.strictEqual(next.titles,
    'Client Success Manager; Implementation Manager; Partner Success Lead');
});

test('adding a title she already has changes nothing', function () {
  var next = R.applySuggestion(CFG, { field: 'titles', action: 'add', value: 'client success manager' });
  assert.strictEqual(next.titles, CFG.titles, 'a duplicate must not be appended');
});

test('replace overwrites, add on an empty field just sets it', function () {
  assert.strictEqual(R.applySuggestion(CFG, { field: 'titles', action: 'replace', value: 'Only This' }).titles, 'Only This');
  assert.strictEqual(R.applySuggestion({ titles: '' }, { field: 'titles', action: 'add', value: 'First' }).titles, 'First');
});

test('minSalary is set as a number, never appended', function () {
  var next = R.applySuggestion(CFG, { field: 'minSalary', action: 'replace', value: 130000 });
  assert.strictEqual(next.minSalary, 130000);
});

test('applying does not mutate the settings it was given', function () {
  var before = Object.assign({}, CFG);
  R.applySuggestion(CFG, { field: 'titles', action: 'add', value: 'New' });
  assert.deepStrictEqual(CFG, before);
});

/* ------------------------------------------------------------- failures */

test('a page that could not be fetched is reported, not silently ignored', async function () {
  // Server-tool errors come back HTTP 200, so they have to be checked for.
  await assert.rejects(
    R.refineFrom(KEY, URL, CFG, function () {
      return textReply('{}', [{ type: 'web_fetch_tool_result', content: { error_code: 'unavailable' } }]);
    }),
    /could not be read/);
});

test('a successful fetch alongside a failed one is not treated as failure', function () {
  assert.strictEqual(R.fetchFailed({ content: [
    { type: 'web_fetch_tool_result', content: { error_code: 'x' } },
    { type: 'web_fetch_tool_result', content: [{ type: 'web_fetch_result' }] }
  ] }), false);
});

test('readable:false is surfaced with the model\'s own explanation', async function () {
  await assert.rejects(
    R.refineFrom(KEY, URL, CFG, function () {
      return textReply(JSON.stringify({ readable: false, problem: 'The page needs a login.' }));
    }),
    /needs a login/);
});

test('a 401 is distinguished, and the key never leaks', async function () {
  await assert.rejects(R.refineFrom(KEY, URL, CFG, function () { return res(401, {}); }),
    /Anthropic key was rejected/);
  for (var status of [400, 401, 429, 500]) {
    var err = await R.refineFrom(KEY, URL, CFG, (function (s) {
      return function () { return res(s, { error: { message: 'bad ' + KEY } }); };
    })(status)).then(function () { return null; }, function (e) { return e; });
    assert.ok(err.message.indexOf(KEY) === -1, 'key leaked in a ' + status);
  }
});

test('an unparseable answer says so rather than throwing something cryptic', async function () {
  await assert.rejects(R.refineFrom(KEY, URL, CFG, function () { return textReply('I had a look and...'); }),
    /unexpected shape|not readable/);
});
