/**
 * Working out which applicant-tracking system a job link belongs to.
 *
 * Adding a company to the watchlist needs an ATS name and the employer's slug
 * on it. Nobody knows their own slug — but everyone can paste a link to a job
 * they found, and the slug is always sitting in that link. This turns one into
 * the other.
 *
 * Shared between the page and the Node tests, hence the UMD wrapper.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JobScoutBoards = api;
})(typeof self !== 'undefined' ? self : this, function () {

  var ATS = {
    greenhouse: { label: 'Greenhouse' },
    lever: { label: 'Lever' },
    ashby: { label: 'Ashby' },
    workday: { label: 'Workday' }
  };

  /* Workday is per-tenant, so an entry needs the host as well as the site name:
     https://teladoc.wd503.myworkdayjobs.com/en-US/teladochealth_is_hiring
             └──── host ─────────────────────┘        └──── site ────┘
     Locale segments sit between the two and are not part of either. */
  var WORKDAY_HOST = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i;
  var LOCALE = /^[a-z]{2}(-[A-Za-z]{2,4})?$/;

  /* Host patterns, each capturing the employer slug as the first path segment.
     The eu. variants are real and easy to miss. */
  var PATTERNS = [
    { ats: 'greenhouse', host: /(^|\.)(job-boards|boards)(\.eu)?\.greenhouse\.io$/ },
    { ats: 'lever',      host: /(^|\.)jobs(\.eu)?\.lever\.co$/ },
    { ats: 'ashby',      host: /(^|\.)jobs\.ashbyhq\.com$/ },
    { ats: 'ashby',      host: /(^|\.)ashbyhq\.com$/ }
  ];

  function firstSegment(pathname) {
    var parts = String(pathname || '').split('/').filter(Boolean);
    return parts.length ? parts[0] : '';
  }

  /**
   * Returns { ats, board } for a recognised job link, or null.
   * Accepts a bare host too, so a pasted careers-page URL still works.
   */
  function parseBoardUrl(input) {
    var text = String(input || '').trim();
    if (!text) return null;
    if (!/^https?:\/\//i.test(text)) text = 'https://' + text;

    var url;
    try { url = new URL(text); } catch (err) { return null; }

    // Greenhouse's embedded board puts the slug in a query parameter instead.
    if (/greenhouse\.io$/.test(url.hostname)) {
      var forParam = url.searchParams.get('for');
      if (forParam) return { ats: 'greenhouse', board: forParam };
    }

    if (WORKDAY_HOST.test(url.hostname)) {
      var segs = String(url.pathname || '').split('/').filter(Boolean)
        .filter(function (s) { return !LOCALE.test(s); });
      // Anything from /job/ onward is one posting, not the board.
      var jobAt = segs.indexOf('job');
      if (jobAt !== -1) segs = segs.slice(0, jobAt);
      if (!segs.length) return null;
      return { ats: 'workday', host: url.hostname.toLowerCase(), board: segs[0] };
    }

    for (var i = 0; i < PATTERNS.length; i++) {
      if (!PATTERNS[i].host.test(url.hostname)) continue;
      var board = firstSegment(url.pathname);
      // "embed" and "jobs" are path furniture, never an employer slug.
      if (!board || board === 'embed' || board === 'jobs') return null;
      return { ats: PATTERNS[i].ats, board: board.toLowerCase() };
    }
    return null;
  }

  /** "pomelocare" -> "Pomelocare", as a starting point she can correct. */
  function guessName(board) {
    var s = String(board || '').replace(/[-_]+/g, ' ').trim();
    if (!s) return '';
    return s.replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
  }

  /** Where a human can go and look at the board, to check it is the right one. */
  function boardUrl(company) {
    if (!company || !company.board) return '';
    if (company.ats === 'greenhouse') return 'https://job-boards.greenhouse.io/' + company.board;
    if (company.ats === 'lever') return 'https://jobs.lever.co/' + company.board;
    if (company.ats === 'ashby') return 'https://jobs.ashbyhq.com/' + company.board;
    if (company.ats === 'workday' && company.host) {
      return 'https://' + company.host + '/en-US/' + company.board;
    }
    return '';
  }

  function label(ats) {
    return (ATS[ats] && ATS[ats].label) || ats || '';
  }

  function isKnownAts(ats) {
    return Object.prototype.hasOwnProperty.call(ATS, ats);
  }

  return {
    ATS: ATS,
    parseBoardUrl: parseBoardUrl,
    guessName: guessName,
    boardUrl: boardUrl,
    label: label,
    isKnownAts: isKnownAts
  };
});
