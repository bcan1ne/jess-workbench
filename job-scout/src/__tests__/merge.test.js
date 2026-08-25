var test = require('node:test');
var assert = require('node:assert');
var { mergeJobs, normalize, existingUrls } = require('../merge');

var TODAY = '2026-08-25';

function job(over) {
  return Object.assign({
    fit: 7, company: 'Acme Health', title: 'Client Success Manager',
    url: 'https://acme.com/jobs/1', salary: '$120,000 - $140,000', salaryMin: 120000,
    setup: 'Remote', location: 'Remote - USA', lat: null, lon: null,
    industry: 'Healthtech', why: 'Fits.', watchOuts: 'Travel.', posted: '3 days ago'
  }, over || {});
}

test('appends a listing that is not on the board', function () {
  var r = mergeJobs([], [job()], TODAY);
  assert.strictEqual(r.added, 1);
  assert.strictEqual(r.jobs.length, 1);
  assert.strictEqual(r.jobs[0].company, 'Acme Health');
});

test('dedupes on url', function () {
  var existing = [job({ status: 'Applied', firstSeen: '2026-01-01' })];
  var r = mergeJobs(existing, [job()], TODAY);
  assert.strictEqual(r.added, 0);
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(r.jobs.length, 1);
});

test('leaves an existing listing completely untouched', function () {
  var existing = [job({ status: 'Screening', firstSeen: '2026-01-01', fit: 9, why: 'Hers.' })];
  var incoming = [job({ fit: 3, why: 'Model changed its mind.', posted: 'today' })];
  var r = mergeJobs(existing, incoming, TODAY);

  assert.strictEqual(r.jobs[0], existing[0], 'same object, not a rewrite');
  assert.strictEqual(r.jobs[0].status, 'Screening');
  assert.strictEqual(r.jobs[0].firstSeen, '2026-01-01');
  assert.strictEqual(r.jobs[0].fit, 9);
  assert.strictEqual(r.jobs[0].why, 'Hers.');
});

test('adds only the new ones from a mixed batch', function () {
  var existing = [job({ url: 'https://acme.com/jobs/1' })];
  var incoming = [
    job({ url: 'https://acme.com/jobs/1' }),
    job({ url: 'https://acme.com/jobs/2', company: 'Beta Health' }),
    job({ url: 'https://acme.com/jobs/3', company: 'Gamma Health' })
  ];
  var r = mergeJobs(existing, incoming, TODAY);
  assert.strictEqual(r.added, 2);
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(r.jobs.length, 3);
});

test('dedupes within a single batch that repeats a url', function () {
  var r = mergeJobs([], [job(), job(), job()], TODAY);
  assert.strictEqual(r.added, 1);
  assert.strictEqual(r.skipped, 2);
});

test('drops a listing with no url — it cannot be deduped later', function () {
  var r = mergeJobs([], [job({ url: '' }), job({ url: undefined })], TODAY);
  assert.strictEqual(r.added, 0);
  assert.strictEqual(r.skipped, 2);
});

test('does not mutate the array it was given', function () {
  var existing = [job()];
  mergeJobs(existing, [job({ url: 'https://acme.com/jobs/2' })], TODAY);
  assert.strictEqual(existing.length, 1);
});

test('sorts the board by fit, best first', function () {
  var r = mergeJobs([], [
    job({ url: 'https://a.com/1', fit: 5 }),
    job({ url: 'https://a.com/2', fit: 9 }),
    job({ url: 'https://a.com/3', fit: 7 })
  ], TODAY);
  assert.deepStrictEqual(r.jobs.map(function (j) { return j.fit; }), [9, 7, 5]);
});

test('a new listing gets firstSeen and a Not started status', function () {
  var r = mergeJobs([], [job()], TODAY);
  assert.strictEqual(r.jobs[0].firstSeen, TODAY);
  assert.strictEqual(r.jobs[0].status, 'Not started');
});

test('a status the model tries to set is ignored', function () {
  var r = mergeJobs([], [job({ status: 'Offer' })], TODAY);
  assert.strictEqual(r.jobs[0].status, 'Not started');
});

test('normalize fills missing fields rather than leaving them undefined', function () {
  var n = normalize({ url: 'https://a.com/1' }, TODAY);
  assert.strictEqual(n.company, '');
  assert.strictEqual(n.fit, 0);
  assert.strictEqual(n.salaryMin, null);
  assert.strictEqual(n.lat, null);
  assert.strictEqual(n.posted, TODAY, 'an undated posting falls back to today');
});

test('normalize coerces stringy numbers the model sometimes returns', function () {
  var n = normalize({ url: 'https://a.com/1', fit: '8', salaryMin: '125000', lat: '41.79', lon: '-76.008' }, TODAY);
  assert.strictEqual(n.fit, 8);
  assert.strictEqual(n.salaryMin, 125000);
  assert.strictEqual(n.lat, 41.79);
  assert.strictEqual(n.lon, -76.008);
});

test('normalize keeps null lat/lon null instead of turning them into 0', function () {
  var n = normalize({ url: 'https://a.com/1', lat: null, lon: null }, TODAY);
  assert.strictEqual(n.lat, null);
  assert.strictEqual(n.lon, null);
});

test('normalize keeps an empty-string salaryMin as null, not 0', function () {
  assert.strictEqual(normalize({ url: 'https://a.com/1', salaryMin: '' }, TODAY).salaryMin, null);
});

test('existingUrls returns the deduping list, skipping blanks', function () {
  var urls = existingUrls([job(), { url: '' }, { company: 'No url' }, job({ url: 'https://a.com/2' })]);
  assert.deepStrictEqual(urls, ['https://acme.com/jobs/1', 'https://a.com/2']);
});

test('empty and missing inputs are safe', function () {
  assert.deepStrictEqual(mergeJobs([], [], TODAY), { jobs: [], added: 0, skipped: 0 });
  assert.strictEqual(mergeJobs(null, null, TODAY).added, 0);
  assert.deepStrictEqual(existingUrls(null), []);
});
