/**
 * Direct ATS polling.
 *
 * Web search discovers companies she does not know about. This does the other
 * half: it watches a fixed list of employers exhaustively, so a role that sits
 * open for three weeks cannot be missed just because one week's search did not
 * happen to return it.
 *
 * Every posting here comes from the employer's own feed, so unlike the search
 * path there is no way for a listing or a URL to be invented.
 *
 * Field names are read defensively — an ATS renaming a key should degrade a
 * single field, not crash the run.
 */

var UA = 'job-scout (github actions)';

function pick(obj, names, fallback) {
  for (var i = 0; i < names.length; i++) {
    var v = obj && obj[names[i]];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback === undefined ? '' : fallback;
}

/** Job descriptions arrive as HTML or HTML-escaped text; the model wants prose. */
function toText(html) {
  return String(html == null ? '' : html)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function getJson(url, fetchImpl) {
  var doFetch = fetchImpl || globalThis.fetch;
  var res = await doFetch(url, { headers: { 'accept': 'application/json', 'user-agent': UA } });
  if (!res.ok) {
    var err = new Error('HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/* ------------------------------------------------------------- per ATS */

async function fetchGreenhouse(company, fetchImpl) {
  var data = await getJson(
    'https://boards-api.greenhouse.io/v1/boards/' + encodeURIComponent(company.board) +
    '/jobs?content=true', fetchImpl);
  return (data.jobs || []).map(function (j) {
    return {
      company: company.name,
      title: pick(j, ['title']),
      url: pick(j, ['absolute_url']),
      location: (j.location && j.location.name) || '',
      postedAt: pick(j, ['updated_at', 'first_published'], ''),
      description: toText(pick(j, ['content']))
    };
  });
}

async function fetchLever(company, fetchImpl) {
  var data = await getJson(
    'https://api.lever.co/v0/postings/' + encodeURIComponent(company.board) + '?mode=json',
    fetchImpl);
  return (data || []).map(function (j) {
    return {
      company: company.name,
      title: pick(j, ['text', 'title']),
      url: pick(j, ['hostedUrl', 'applyUrl']),
      location: (j.categories && j.categories.location) || '',
      postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : '',
      description: toText(pick(j, ['descriptionPlain', 'description']))
    };
  });
}

async function fetchAshby(company, fetchImpl) {
  var data = await getJson(
    'https://api.ashbyhq.com/posting-api/job-board/' + encodeURIComponent(company.board) +
    '?includeCompensation=true', fetchImpl);
  return (data.jobs || []).map(function (j) {
    return {
      company: company.name,
      title: pick(j, ['title']),
      url: pick(j, ['jobUrl', 'applyUrl']),
      location: pick(j, ['location']),
      postedAt: pick(j, ['publishedAt', 'updatedAt'], ''),
      description: toText(pick(j, ['descriptionPlain', 'descriptionHtml', 'description']))
    };
  });
}

/**
 * Workday, which most health systems and large employers use.
 *
 * Its board is backed by a per-tenant JSON endpoint. Two differences from the
 * others: the list is a POST, and it carries no job description — so postings
 * come back marked for hydration, and only the ones that survive the title
 * filter are worth a second request.
 */
function workdayTenant(host) {
  return String(host || '').split('.')[0];
}

async function fetchWorkday(company, fetchImpl) {
  var doFetch = fetchImpl || globalThis.fetch;
  var host = company.host;
  var site = company.board;
  if (!host || !site) throw new Error('needs both host and board');

  var base = 'https://' + host + '/wday/cxs/' + workdayTenant(host) + '/' + site;
  var res = await doFetch(base + '/jobs', {
    method: 'POST',
    headers: { 'accept': 'application/json', 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' })
  });
  if (!res.ok) {
    var err = new Error('HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }

  var data = await res.json();
  return (data.jobPostings || []).map(function (j) {
    var external = pick(j, ['externalPath', 'externalUrl'], '');
    return {
      company: company.name,
      title: pick(j, ['title']),
      // The human-facing address, not the API one.
      url: external ? 'https://' + host + '/en-US/' + site + external : '',
      location: pick(j, ['locationsText', 'locations', 'location']),
      postedAt: pick(j, ['postedOn', 'startDate'], ''),
      description: '',
      // Enough to go back for the description if this one is worth scoring.
      detail: external ? base + external : ''
    };
  }).filter(function (p) { return p.url; });
}

/** Second request, for a posting that already looks plausible. */
async function hydrateWorkday(posting, fetchImpl) {
  var doFetch = fetchImpl || globalThis.fetch;
  var res = await doFetch(posting.detail, {
    headers: { 'accept': 'application/json', 'user-agent': UA }
  });
  if (!res.ok) return posting;

  var data = await res.json();
  var info = data.jobPostingInfo || data;
  return Object.assign({}, posting, {
    description: toText(pick(info, ['jobDescription', 'description'])),
    location: posting.location || pick(info, ['location', 'locationsText']),
    postedAt: posting.postedAt || pick(info, ['postedOn', 'startDate'], '')
  });
}

/**
 * Fills in descriptions for postings that arrived without one. Runs after the
 * title filter, so a board with a hundred openings costs a handful of requests
 * rather than a hundred.
 */
async function hydrate(postings, fetchImpl, log) {
  var out = [];
  for (var i = 0; i < (postings || []).length; i++) {
    var p = postings[i];
    if (!p.detail || p.description) { out.push(p); continue; }
    try {
      out.push(await hydrateWorkday(p, fetchImpl));
    } catch (err) {
      // Scoring a title with no description is worse than nothing, so drop it
      // rather than let the model guess at what the role involves.
      if (log) log('  could not read ' + p.company + ' — ' + p.title + ': ' + err.message);
    }
  }
  return out;
}

var FETCHERS = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  workday: fetchWorkday
};

/**
 * Polls every board. One employer being down, renamed, or rate limited must not
 * lose the rest of the run, so failures are collected rather than thrown.
 */
async function fetchAll(companies, fetchImpl, log) {
  var postings = [];
  var failures = [];

  for (var i = 0; i < (companies || []).length; i++) {
    var c = companies[i];
    var fn = FETCHERS[c.ats];
    if (!fn) { failures.push({ company: c.name, reason: 'unknown ats: ' + c.ats }); continue; }
    try {
      var got = await fn(c, fetchImpl);
      postings = postings.concat(got);
      if (log) log('  ' + c.name + ': ' + got.length + ' posting(s)');
    } catch (err) {
      failures.push({ company: c.name, reason: err.message });
      if (log) log('  ' + c.name + ': ' + err.message);
    }
  }
  return { postings: postings, failures: failures };
}

/* ----------------------------------------------------------- filtering */

function words(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * A cheap title gate before anything reaches the model. Only postings that look
 * plausible cost tokens, which is what keeps adding sources roughly free.
 */
function prefilter(postings, cfg, seenUrls) {
  var seen = new Set(seenUrls || []);
  var wanted = String(cfg.titles || '').split(';')
    .map(function (t) { return words(t); })
    .filter(function (w) { return w.length; });
  var banned = String(cfg.hardNos || '').split(';')
    .map(function (t) { return t.trim().toLowerCase(); })
    .filter(Boolean);

  var kept = [];
  var dropped = 0;

  (postings || []).forEach(function (p) {
    if (!p.url || seen.has(p.url)) { dropped++; return; }
    var title = String(p.title || '').toLowerCase();
    if (!title) { dropped++; return; }

    // Any target title whose words all appear in the posting title.
    var matches = wanted.some(function (w) {
      return w.every(function (word) { return title.indexOf(word) !== -1; });
    });
    if (!matches) { dropped++; return; }

    if (banned.some(function (b) { return b && title.indexOf(b) !== -1; })) { dropped++; return; }

    seen.add(p.url);
    kept.push(p);
  });

  return { kept: kept, dropped: dropped };
}

module.exports = {
  toText: toText,
  pick: pick,
  workdayTenant: workdayTenant,
  fetchGreenhouse: fetchGreenhouse,
  fetchLever: fetchLever,
  fetchAshby: fetchAshby,
  fetchWorkday: fetchWorkday,
  hydrateWorkday: hydrateWorkday,
  hydrate: hydrate,
  fetchAll: fetchAll,
  prefilter: prefilter
};
