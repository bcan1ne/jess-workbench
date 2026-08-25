var test = require('node:test');
var assert = require('node:assert');
var S = require('../sources');

var CFG = {
  titles: 'Client Success Manager; Client Manager; Implementation Manager; Program Manager; Partner Success; Account Manager',
  hardNos: 'Relocation required; commission-only; clinical licensure required'
};

function ok(body) {
  return function () {
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };
}
function fail(status) {
  return function () {
    return Promise.resolve({ ok: false, status: status, json: function () { return Promise.resolve({}); } });
  };
}

/* ------------------------------------------------------------ html text */

test('descriptions are unescaped and stripped to prose', function () {
  var html = '&lt;p&gt;Own &lt;strong&gt;enterprise&lt;/strong&gt; accounts&lt;/p&gt;&lt;p&gt;Remote, $120k&lt;/p&gt;';
  var out = S.toText(html);
  assert.match(out, /Own enterprise accounts/);
  assert.match(out, /Remote, \$120k/);
  assert.ok(out.indexOf('<') === -1, 'no markup should survive');
});

test('script and style blocks are removed, not just their tags', function () {
  var out = S.toText('<p>Real text</p><script>var x = "hidden";</script><style>.a{color:red}</style>');
  assert.match(out, /Real text/);
  assert.ok(out.indexOf('hidden') === -1);
  assert.ok(out.indexOf('color:red') === -1);
});

test('toText survives null and empty input', function () {
  assert.strictEqual(S.toText(null), '');
  assert.strictEqual(S.toText(''), '');
});

/* --------------------------------------------------------------- fetchers */

test('greenhouse postings are normalised', async function () {
  var seen;
  var out = await S.fetchGreenhouse({ name: 'Maven Clinic', board: 'mavenclinic' }, function (url) {
    seen = url;
    return ok({ jobs: [{
      title: 'Client Success Manager', absolute_url: 'https://boards.greenhouse.io/mavenclinic/jobs/1',
      location: { name: 'Remote - USA' }, updated_at: '2026-08-20T00:00:00Z',
      content: '&lt;p&gt;Own employer accounts&lt;/p&gt;'
    }] })();
  });
  assert.match(seen, /boards-api\.greenhouse\.io\/v1\/boards\/mavenclinic\/jobs\?content=true/);
  assert.deepStrictEqual(out[0], {
    company: 'Maven Clinic', title: 'Client Success Manager',
    url: 'https://boards.greenhouse.io/mavenclinic/jobs/1', location: 'Remote - USA',
    postedAt: '2026-08-20T00:00:00Z', description: 'Own employer accounts'
  });
});

test('lever postings are normalised, including its epoch timestamps', async function () {
  var out = await S.fetchLever({ name: 'Rightway', board: 'rightwayhealthcare' },
    ok([{ text: 'Client Manager', hostedUrl: 'https://jobs.lever.co/rightway/1',
          categories: { location: 'New York' }, createdAt: 1755000000000,
          descriptionPlain: 'Manage employer clients' }]));
  assert.strictEqual(out[0].title, 'Client Manager');
  assert.strictEqual(out[0].location, 'New York');
  assert.match(out[0].postedAt, /^2025-\d\d-\d\dT/);
});

test('ashby postings are normalised', async function () {
  var out = await S.fetchAshby({ name: 'Someco', board: 'someco' },
    ok({ jobs: [{ title: 'Implementation Manager', jobUrl: 'https://jobs.ashbyhq.com/someco/1',
                  location: 'Remote', publishedAt: '2026-08-01', descriptionPlain: 'Launch clients' }] }));
  assert.strictEqual(out[0].url, 'https://jobs.ashbyhq.com/someco/1');
  assert.strictEqual(out[0].description, 'Launch clients');
});

test('a renamed or missing field degrades to empty, it does not throw', async function () {
  var out = await S.fetchGreenhouse({ name: 'X', board: 'x' }, ok({ jobs: [{ title: 'CSM' }] }));
  assert.strictEqual(out[0].url, '');
  assert.strictEqual(out[0].location, '');
  assert.strictEqual(out[0].description, '');
});

test('an empty board is not an error', async function () {
  assert.deepStrictEqual(await S.fetchGreenhouse({ name: 'X', board: 'x' }, ok({ jobs: [] })), []);
  assert.deepStrictEqual(await S.fetchGreenhouse({ name: 'X', board: 'x' }, ok({})), []);
});

/* ------------------------------------------------------------- fetchAll */

test('one dead board does not lose the rest of the run', async function () {
  var companies = [
    { name: 'Good', ats: 'greenhouse', board: 'good' },
    { name: 'Gone', ats: 'greenhouse', board: 'gone' },
    { name: 'AlsoGood', ats: 'greenhouse', board: 'also' }
  ];
  var res = await S.fetchAll(companies, function (url) {
    if (url.indexOf('/gone/') !== -1) return fail(404)();
    return ok({ jobs: [{ title: 'CSM', absolute_url: url }] })();
  });
  assert.strictEqual(res.postings.length, 2, 'the two live boards must still return');
  assert.strictEqual(res.failures.length, 1);
  assert.strictEqual(res.failures[0].company, 'Gone');
  assert.match(res.failures[0].reason, /404/);
});

test('an unknown ats is reported rather than silently skipped', async function () {
  var res = await S.fetchAll([{ name: 'X', ats: 'workday', board: 'x' }], ok({}));
  assert.strictEqual(res.postings.length, 0);
  assert.match(res.failures[0].reason, /unknown ats: workday/);
});

test('an empty company list is fine', async function () {
  assert.deepStrictEqual(await S.fetchAll([], ok({})), { postings: [], failures: [] });
  assert.deepStrictEqual(await S.fetchAll(null, ok({})), { postings: [], failures: [] });
});

/* ------------------------------------------------------------ prefilter */

function p(title, url) {
  return { company: 'X', title: title, url: url || ('https://x.com/' + title.replace(/\W/g, '')) };
}

test('titles matching a target are kept', function () {
  var r = S.prefilter([p('Client Success Manager'), p('Senior Implementation Manager')], CFG, []);
  assert.strictEqual(r.kept.length, 2);
});

test('unrelated titles are dropped before they can cost a token', function () {
  var r = S.prefilter([p('Staff Software Engineer'), p('Warehouse Associate'), p('Nurse Practitioner')], CFG, []);
  assert.strictEqual(r.kept.length, 0);
  assert.strictEqual(r.dropped, 3);
});

test('all words of a target title must appear, so "Manager" alone is not enough', function () {
  var r = S.prefilter([p('Engineering Manager'), p('Client Success Manager')], CFG, []);
  assert.deepStrictEqual(r.kept.map(function (x) { return x.title; }), ['Client Success Manager']);
});

test('already-seen urls never reach the model', function () {
  var seen = ['https://x.com/ClientSuccessManager'];
  var r = S.prefilter([p('Client Success Manager')], CFG, seen);
  assert.strictEqual(r.kept.length, 0);
  assert.strictEqual(r.dropped, 1);
});

test('duplicates inside one poll are collapsed', function () {
  var r = S.prefilter([p('Client Success Manager'), p('Client Success Manager')], CFG, []);
  assert.strictEqual(r.kept.length, 1);
});

test('a posting with no url is dropped — it could not be deduped later', function () {
  var r = S.prefilter([{ company: 'X', title: 'Client Success Manager', url: '' }], CFG, []);
  assert.strictEqual(r.kept.length, 0);
});

test('hard exclusions knock out a matching title', function () {
  var cfg = { titles: 'Account Manager', hardNos: 'commission-only' };
  var r = S.prefilter([p('Account Manager, commission-only'), p('Account Manager')], cfg, []);
  assert.deepStrictEqual(r.kept.map(function (x) { return x.title; }), ['Account Manager']);
});

test('matching is case-insensitive and tolerates punctuation', function () {
  var r = S.prefilter([p('CLIENT SUCCESS MANAGER (Strategic Accounts)'), p('client-success-manager')], CFG, []);
  assert.strictEqual(r.kept.length, 2);
});
