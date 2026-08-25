/**
 * Scoring postings that came from an ATS feed.
 *
 * The search path asks the model to find AND score in one call. Here the
 * finding is already done and verifiable, so the model only judges fit against
 * text it was handed. It is told not to invent a URL precisely because it does
 * not need to — every posting arrives with one.
 */

var { CANDIDATE, CONTRACT } = require('./profile');

var API_URL = 'https://api.anthropic.com/v1/messages';
var MODEL = 'claude-sonnet-4-6';
var MAX_TOKENS = 8000;
var BATCH = 20;
var DESC_CHARS = 2500;

function redact(text, apiKey) {
  var out = String(text == null ? '' : text);
  if (apiKey) out = out.split(apiKey).join('[redacted]');
  return out.replace(/sk-ant-[A-Za-z0-9_\-]+/g, '[redacted]');
}

function postingBlock(p, i) {
  return '--- POSTING ' + (i + 1) + ' ---\n' +
    'company: ' + p.company + '\n' +
    'title: ' + p.title + '\n' +
    'url: ' + p.url + '\n' +
    'location: ' + (p.location || 'not stated') + '\n' +
    'posted: ' + (p.postedAt || 'not stated') + '\n' +
    'description:\n' + String(p.description || '').slice(0, DESC_CHARS);
}

function buildPrompt(cfg, postings) {
  return 'Score these job postings against a candidate profile. They were pulled ' +
    'directly from employer applicant-tracking boards, so they are already verified ' +
    'as live — do not search, and do not change any url.\n\n' +
    'CANDIDATE: ' + CANDIDATE + '\n\n' +
    'REQUIREMENTS:\n' +
    '- Minimum base salary: ' + cfg.minSalary + '\n' +
    '- Work setup: ' + cfg.workSetup + '\n' +
    '- If on-site or hybrid, must be within ' + cfg.radius + ' driving miles of ' + cfg.homeLabel + '\n' +
    '- Industry preference: ' + cfg.industry + '\n' +
    '- Target titles: ' + cfg.titles + '\n' +
    '- Exclude: ' + cfg.hardNos + '\n\n' +
    'POSTINGS:\n\n' + postings.map(postingBlock).join('\n\n') + '\n\n' +
    'RULES:\n' +
    '- Copy each url through exactly as given. Never invent or alter one.\n' +
    '- Drop any posting that clearly fails a hard requirement rather than scoring it low.\n' +
    '- Read salary from the description if it is stated; use null for salaryMin if it is not.\n' +
    '- Set lat and lon to null for fully remote roles.\n\n' +
    'Return ONLY a JSON array, no prose and no markdown fences. Each object:\n' + CONTRACT + '\n\n' +
    'Score fit against the candidate profile above, and name the specific limiting factor ' +
    'in watchOuts. Best fit first.';
}

/** Splits into batches so one oversized run cannot blow the context window. */
function batches(postings, size) {
  var out = [];
  var n = size || BATCH;
  for (var i = 0; i < postings.length; i += n) out.push(postings.slice(i, i + n));
  return out;
}

async function scoreBatch(apiKey, cfg, postings, fetchImpl) {
  var doFetch = fetchImpl || globalThis.fetch;
  var res;
  try {
    res = await doFetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: buildPrompt(cfg, postings) }]
      })
    });
  } catch (err) {
    throw new Error('Could not reach the Anthropic API: ' + redact(err.message, apiKey));
  }

  if (res.status === 401) {
    throw new Error(
      'The Anthropic API key was rejected (401). Check the ANTHROPIC_API_KEY repository secret.');
  }
  if (!res.ok) {
    var detail = '';
    try { detail = ' ' + redact(await res.text(), apiKey).slice(0, 400); } catch (e) { /* optional */ }
    throw new Error('Anthropic API returned ' + res.status + '.' + detail);
  }
  return res.json();
}

/**
 * A scored posting is only kept if its url is one we actually handed over, so a
 * hallucinated or mangled url cannot reach the board.
 */
function keepKnownUrls(scored, postings) {
  var known = new Set(postings.map(function (p) { return p.url; }));
  return (scored || []).filter(function (j) { return j && j.url && known.has(j.url); });
}

module.exports = {
  API_URL: API_URL,
  MODEL: MODEL,
  BATCH: BATCH,
  redact: redact,
  buildPrompt: buildPrompt,
  batches: batches,
  scoreBatch: scoreBatch,
  keepKnownUrls: keepKnownUrls
};
