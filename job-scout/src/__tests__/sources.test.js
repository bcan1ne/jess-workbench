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
  var res = await S.fetchAll([{ name: 'X', ats: 'icims', board: 'x' }], ok({}));
  assert.strictEqual(res.postings.length, 0);
  assert.match(res.failures[0].reason, /unknown ats: icims/);
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

/* --------------------------------------------------- recognising a job link */

var B = require('../../site/boards.js');

test('a Greenhouse job link yields the employer slug', function () {
  assert.deepStrictEqual(
    B.parseBoardUrl('https://job-boards.greenhouse.io/mavenclinic/jobs/8395016002'),
    { ats: 'greenhouse', board: 'mavenclinic' });
  assert.deepStrictEqual(
    B.parseBoardUrl('https://boards.greenhouse.io/cedar/jobs/123'),
    { ats: 'greenhouse', board: 'cedar' });
});

test('the EU hosts are recognised too — easy to miss and silently wrong', function () {
  assert.deepStrictEqual(B.parseBoardUrl('https://boards.eu.greenhouse.io/someco'),
    { ats: 'greenhouse', board: 'someco' });
  assert.deepStrictEqual(B.parseBoardUrl('https://jobs.eu.lever.co/someco/1'),
    { ats: 'lever', board: 'someco' });
});

test('Lever and Ashby links work', function () {
  assert.deepStrictEqual(B.parseBoardUrl('https://jobs.lever.co/rightwayhealthcare/abc-123'),
    { ats: 'lever', board: 'rightwayhealthcare' });
  assert.deepStrictEqual(B.parseBoardUrl('https://jobs.ashbyhq.com/openai/xyz'),
    { ats: 'ashby', board: 'openai' });
});

test("Greenhouse's embedded board keeps the slug in a query parameter", function () {
  assert.deepStrictEqual(B.parseBoardUrl('https://my.greenhouse.io/embed/job_board?for=acmehealth'),
    { ats: 'greenhouse', board: 'acmehealth' });
});

test('a bare host works, so a careers page pasted without https is fine', function () {
  assert.deepStrictEqual(B.parseBoardUrl('boards.greenhouse.io/pomelocare'),
    { ats: 'greenhouse', board: 'pomelocare' });
});

test('the slug is lowercased, since board slugs are', function () {
  assert.strictEqual(B.parseBoardUrl('https://jobs.lever.co/RightWay/1').board, 'rightway');
});

test('an aggregator or job site is not a board we can watch', function () {
  assert.strictEqual(B.parseBoardUrl('https://builtin.com/job/whatever/123'), null);
  assert.strictEqual(B.parseBoardUrl('https://www.linkedin.com/jobs/view/123'), null);
  assert.strictEqual(B.parseBoardUrl('https://www.indeed.com/viewjob?jk=1'), null);
});

test('path furniture is never mistaken for an employer', function () {
  assert.strictEqual(B.parseBoardUrl('https://job-boards.greenhouse.io/'), null);
  assert.strictEqual(B.parseBoardUrl('https://my.greenhouse.io/embed/job_board'), null);
});

test('junk in gives null out rather than a bogus company', function () {
  ['not a url', '', null, undefined, '   ', 'http://'].forEach(function (v) {
    assert.strictEqual(B.parseBoardUrl(v), null, 'failed for ' + JSON.stringify(v));
  });
});

test('a slug becomes a readable starting name', function () {
  assert.strictEqual(B.guessName('pomelocare'), 'Pomelocare');
  assert.strictEqual(B.guessName('rightway-healthcare'), 'Rightway Healthcare');
  assert.strictEqual(B.guessName('spring_health'), 'Spring Health');
  assert.strictEqual(B.guessName(''), '');
});

test('boardUrl points at a page a person can actually open and check', function () {
  assert.strictEqual(B.boardUrl({ ats: 'greenhouse', board: 'mavenclinic' }),
    'https://job-boards.greenhouse.io/mavenclinic');
  assert.strictEqual(B.boardUrl({ ats: 'lever', board: 'x' }), 'https://jobs.lever.co/x');
  assert.strictEqual(B.boardUrl({ ats: 'ashby', board: 'x' }), 'https://jobs.ashbyhq.com/x');
  assert.strictEqual(B.boardUrl({ ats: 'workday', board: 'x' }), '');
  assert.strictEqual(B.boardUrl(null), '');
});

test('every ats in the shipped watchlist is one the workflow can actually poll', function () {
  var companies = require('../../companies.json');
  companies.forEach(function (c) {
    assert.ok(B.isKnownAts(c.ats), c.name + ' uses an unsupported ats: ' + c.ats);
    assert.ok(c.board && c.name, 'a watchlist entry is missing board or name');
  });
});

/* ---------------------------------------------------------------- Workday */

test('a Workday board link yields host and site', function () {
  assert.deepStrictEqual(
    B.parseBoardUrl('https://teladoc.wd503.myworkdayjobs.com/teladochealth_is_hiring'),
    { ats: 'workday', host: 'teladoc.wd503.myworkdayjobs.com', board: 'teladochealth_is_hiring' });
});

test('a locale segment is not mistaken for the site name', function () {
  assert.deepStrictEqual(
    B.parseBoardUrl('https://teladoc.wd503.myworkdayjobs.com/en-US/teladochealth_is_hiring'),
    { ats: 'workday', host: 'teladoc.wd503.myworkdayjobs.com', board: 'teladochealth_is_hiring' });
});

test('a link to one Workday posting still identifies the board', function () {
  var out = B.parseBoardUrl(
    'https://teladoc.wd503.myworkdayjobs.com/en-US/teladochealth_is_hiring/job/Remote/Client-Success_R-1234');
  assert.strictEqual(out.board, 'teladochealth_is_hiring');
  assert.strictEqual(out.ats, 'workday');
});

test('the tenant is read off the host', function () {
  assert.strictEqual(S.workdayTenant('teladoc.wd503.myworkdayjobs.com'), 'teladoc');
  assert.strictEqual(S.workdayTenant(''), '');
});

test('a bare Workday host with no site is not a board', function () {
  assert.strictEqual(B.parseBoardUrl('https://teladoc.wd503.myworkdayjobs.com/'), null);
});

test('boardUrl for Workday needs the host and gives a page a person can open', function () {
  assert.strictEqual(
    B.boardUrl({ ats: 'workday', host: 'teladoc.wd503.myworkdayjobs.com', board: 'site' }),
    'https://teladoc.wd503.myworkdayjobs.com/en-US/site');
  assert.strictEqual(B.boardUrl({ ats: 'workday', board: 'site' }), '',
    'without a host there is nothing to point at');
});

test('the Workday list is a POST and normalises to the same shape', async function () {
  var seen;
  var out = await S.fetchWorkday(
    { name: 'Teladoc', ats: 'workday', host: 'teladoc.wd503.myworkdayjobs.com', board: 'tdh' },
    function (url, opts) {
      seen = { url: url, method: opts.method, body: JSON.parse(opts.body) };
      return ok({ total: 1, jobPostings: [{
        title: 'Client Success Manager', externalPath: '/job/Remote/CSM_R-1',
        locationsText: 'Remote, USA', postedOn: 'Posted 3 Days Ago'
      }] })();
    });
  assert.strictEqual(seen.url,
    'https://teladoc.wd503.myworkdayjobs.com/wday/cxs/teladoc/tdh/jobs');
  assert.strictEqual(seen.method, 'POST');
  assert.deepStrictEqual(seen.body, { appliedFacets: {}, limit: 20, offset: 0, searchText: '' });
  assert.strictEqual(out[0].url,
    'https://teladoc.wd503.myworkdayjobs.com/en-US/tdh/job/Remote/CSM_R-1');
  assert.strictEqual(out[0].description, '', 'the list carries no description');
  assert.ok(out[0].detail, 'but it carries enough to go and get one');
});

test('a Workday entry missing its host fails loudly rather than polling nothing', async function () {
  await assert.rejects(
    S.fetchWorkday({ name: 'X', ats: 'workday', board: 'site' }, ok({})),
    /needs both host and board/);
});

test('a posting with no path is dropped rather than given a broken url', async function () {
  var out = await S.fetchWorkday(
    { name: 'X', host: 'x.wd1.myworkdayjobs.com', board: 's' },
    ok({ jobPostings: [{ title: 'No path' }, { title: 'Fine', externalPath: '/job/a' }] }));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].title, 'Fine');
});

/* -------------------------------------------------------------- hydration */

test('hydration fills the description in from the detail endpoint', async function () {
  var out = await S.hydrate([{
    company: 'Teladoc', title: 'CSM', url: 'https://x/1', description: '',
    detail: 'https://teladoc.wd503.myworkdayjobs.com/wday/cxs/teladoc/tdh/job/Remote/CSM_R-1'
  }], ok({ jobPostingInfo: {
    jobDescription: '&lt;p&gt;Own enterprise accounts. $120,000-$150,000.&lt;/p&gt;',
    location: 'Remote, USA'
  } }));
  assert.match(out[0].description, /Own enterprise accounts/);
  assert.ok(out[0].description.indexOf('<') === -1, 'markup is stripped');
});

test('postings that already have a description are left alone and cost no request', async function () {
  var calls = 0;
  var out = await S.hydrate(
    [{ title: 'A', description: 'already here', detail: 'https://x' }, { title: 'B' }],
    function () { calls++; return ok({})(); });
  assert.strictEqual(calls, 0);
  assert.strictEqual(out.length, 2);
});

test('a posting whose description cannot be read is dropped, not scored blind', async function () {
  // Scoring a bare title invites the model to guess at what the role involves.
  var logged = [];
  var out = await S.hydrate(
    [{ company: 'X', title: 'CSM', detail: 'https://x/1' }],
    function () { return Promise.reject(new Error('ECONNRESET')); },
    function (m) { logged.push(m); });
  assert.strictEqual(out.length, 0);
  assert.match(logged[0], /could not read X — CSM/);
});

test('one unreadable posting does not lose the others', async function () {
  var n = 0;
  var out = await S.hydrate([
    { company: 'X', title: 'A', detail: 'https://x/1' },
    { company: 'X', title: 'B', detail: 'https://x/2' }
  ], function () {
    n++;
    if (n === 1) return Promise.reject(new Error('boom'));
    return ok({ jobPostingInfo: { jobDescription: 'Fine.' } })();
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].title, 'B');
});

test('workday is an ats the watchlist recognises', function () {
  assert.ok(B.isKnownAts('workday'));
  assert.strictEqual(B.label('workday'), 'Workday');
});
