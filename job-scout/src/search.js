/**
 * The Anthropic call.
 *
 * The prompt below is ported verbatim from runRefresh() in the Apps Script
 * version. It is tuned — particularly the rules about verifying postings are
 * live, preferring ATS boards over aggregators, and never inventing a URL.
 * Change the wording only on purpose.
 */

var API_URL = 'https://api.anthropic.com/v1/messages';
var MODEL = 'claude-sonnet-4-6';
var MAX_TOKENS = 8000;

function buildPrompt(cfg, existing) {
  return 'Find currently open job postings matching this candidate profile. Use web search.\n\n' +
    'CANDIDATE: Client success and implementation professional in digital health. Background spans ' +
    'telehealth client implementation and account management, virtual maternity and doula program client ' +
    'success, corporate workplace wellbeing for self-insured employers, public health outreach and ' +
    'lactation consulting, and adjunct health science instruction. MBA plus MS in Entrepreneurial ' +
    'Nutrition, BS in Nutrition. Strengths: client relationship management, program implementation and ' +
    'launch readiness, cross-functional coordination, webinar and public speaking, translating nutrition ' +
    'science for lay audiences. Tools: Salesforce, Metabase, Box, Microsoft Office, Google Workspace, ' +
    'Zoom, LMS platforms.\n\n' +
    'REQUIREMENTS:\n' +
    '- Minimum base salary: ' + cfg.minSalary + '\n' +
    '- Work setup: ' + cfg.workSetup + '\n' +
    '- If on-site or hybrid, must be within ' + cfg.radius + ' driving miles of ' + cfg.homeLabel + '\n' +
    '- Industry preference: ' + cfg.industry + '\n' +
    '- Target titles: ' + cfg.titles + '\n' +
    '- Exclude: ' + cfg.hardNos + '\n\n' +
    'RULES:\n' +
    '- Only postings you have verified are currently open. Never invent a listing or a URL.\n' +
    '- Prefer employer career pages and ATS boards (Greenhouse, Lever, Ashby) over aggregators.\n' +
    '- Skip LinkedIn and Indeed links.\n' +
    '- Skip any posting whose URL appears in this already-seen list:\n' +
      JSON.stringify(existing) + '\n\n' +
    'Return ONLY a JSON array, no prose and no markdown fences. Each object:\n' +
    '{"fit": <1-10 integer>, "company": "", "title": "", "url": "", "salary": "", ' +
    '"salaryMin": <number or null>, "setup": "Remote|Hybrid|On-site", "location": "", ' +
    '"lat": <number or null>, "lon": <number or null>, "industry": "", "why": "", ' +
    '"watchOuts": "", "posted": ""}\n\n' +
    'Set lat and lon to null for fully remote roles. Score fit against the candidate profile above, and ' +
    'name the specific limiting factor in watchOuts. Return at most 15 objects, best fit first.';
}

/**
 * Scrubs the key out of anything headed for an error message or the Actions log.
 * An upstream error body can echo the request that produced it.
 */
function redact(text, apiKey) {
  var out = String(text == null ? '' : text);
  if (apiKey) out = out.split(apiKey).join('[redacted]');
  return out.replace(/sk-ant-[A-Za-z0-9_\-]+/g, '[redacted]');
}

/**
 * Calls the Messages API with web search enabled.
 * Throws on any non-200; a 401 gets its own message so a bad key is obvious.
 * The key is never echoed into an error, a log line, or the thrown message.
 */
async function searchJobs(apiKey, cfg, existing, fetchImpl) {
  var doFetch = fetchImpl || globalThis.fetch;
  var prompt = buildPrompt(cfg, existing);

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
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }]
      })
    });
  } catch (err) {
    throw new Error('Could not reach the Anthropic API: ' + err.message);
  }

  if (res.status === 401) {
    throw new Error(
      'The Anthropic API key was rejected (401). Check the ANTHROPIC_API_KEY repository secret.');
  }
  if (!res.ok) {
    var detail = '';
    try {
      var body = await res.text();
      detail = ' ' + redact(body, apiKey).slice(0, 400);
    } catch (err) { /* body is optional context */ }
    throw new Error('Anthropic API returned ' + res.status + '.' + detail);
  }

  return res.json();
}

module.exports = {
  buildPrompt: buildPrompt,
  redact: redact,
  searchJobs: searchJobs,
  API_URL: API_URL,
  MODEL: MODEL
};
