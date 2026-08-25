/**
 * Merging new findings into the committed board.
 *
 * The rule from the Apps Script version carries over unchanged: dedupe on url,
 * append what is new, and never touch a row that already exists. Status and
 * firstSeen on an existing listing are hers, not the model's.
 */

var FIELDS = [
  'fit', 'company', 'title', 'url', 'salary', 'salaryMin', 'setup',
  'location', 'lat', 'lon', 'industry', 'why', 'watchOuts', 'posted'
];

function normalize(job, today) {
  var out = {};
  FIELDS.forEach(function (k) {
    var v = job[k];
    out[k] = v === undefined ? null : v;
  });

  out.fit = Number(out.fit) || 0;
  out.salaryMin = out.salaryMin == null || out.salaryMin === ''
    ? null
    : Number(out.salaryMin);
  out.lat = out.lat == null || out.lat === '' ? null : Number(out.lat);
  out.lon = out.lon == null || out.lon === '' ? null : Number(out.lon);

  ['company', 'title', 'url', 'salary', 'setup', 'location', 'industry', 'why', 'watchOuts']
    .forEach(function (k) { out[k] = out[k] == null ? '' : String(out[k]); });

  out.posted = out.posted ? String(out.posted) : today;
  out.firstSeen = today;
  out.status = 'Not started';
  return out;
}

/**
 * Returns { jobs, added, skipped } — jobs is a new array, existing entries
 * are the same objects by reference so nothing already on the board is rewritten.
 */
function mergeJobs(existing, incoming, today) {
  var jobs = (existing || []).slice();
  var seen = new Set();
  jobs.forEach(function (j) { if (j && j.url) seen.add(j.url); });

  var added = 0;
  var skipped = 0;

  (incoming || []).forEach(function (job) {
    if (!job || !job.url) { skipped++; return; }
    if (seen.has(job.url)) { skipped++; return; }
    seen.add(job.url);
    jobs.push(normalize(job, today));
    added++;
  });

  jobs.sort(function (a, b) { return (b.fit || 0) - (a.fit || 0); });
  return { jobs: jobs, added: added, skipped: skipped };
}

/** The already-seen list handed to the model so it does not re-report them. */
function existingUrls(jobs) {
  return (jobs || [])
    .map(function (j) { return j && j.url; })
    .filter(Boolean);
}

module.exports = { mergeJobs: mergeJobs, normalize: normalize, existingUrls: existingUrls };
