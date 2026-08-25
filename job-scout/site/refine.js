/**
 * Learning the search settings from a job she likes.
 *
 * "Here is a role I want more of" is a much easier thing to express than a
 * semicolon-separated list of target titles, so this reads the posting and
 * proposes changes to the settings rather than asking her to write them.
 *
 * The browser cannot fetch a job page itself — almost no job site sends CORS
 * headers — so the read happens through the web_fetch tool, server-side, and
 * only the conclusions come back. Same key as tailoring: this never touches the
 * repository, and nothing is applied without her pressing a button.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JobScoutRefine = api;
})(typeof self !== 'undefined' ? self : this, function () {

  var API_URL = 'https://api.anthropic.com/v1/messages';
  var MODEL = 'claude-opus-5';
  var MAX_TOKENS = 4000;

  // The dynamic-filtering variant; needs a current model, which MODEL is.
  var FETCH_TOOL = { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3 };

  /** Fields the model may propose changes to. Nothing else is applied. */
  var EDITABLE = ['titles', 'industry', 'workSetup', 'hardNos', 'minSalary'];

  function redact(text, apiKey) {
    var out = String(text == null ? '' : text);
    if (apiKey) out = out.split(apiKey).join('[redacted]');
    return out.replace(/sk-ant-[A-Za-z0-9_\-]+/g, '[redacted]');
  }

  function describeError(status) {
    if (status === 401) return 'The Anthropic key was rejected. Check it in Settings.';
    if (status === 429) return 'Rate limited by Anthropic. Wait a moment and try again.';
    if (status >= 500) return 'Anthropic returned ' + status + '. Try again shortly.';
    return 'Anthropic returned ' + status + '.';
  }

  function buildPrompt(url, cfg) {
    return 'Read this job posting and suggest how to tune a job search so it finds more ' +
      'roles like it.\n\n' +
      'POSTING: ' + url + '\n\n' +
      'Fetch that URL and read it before answering.\n\n' +
      'THE SEARCH AS IT STANDS:\n' +
      '- Target titles: ' + (cfg.titles || '(none)') + '\n' +
      '- Industry preference: ' + (cfg.industry || '(none)') + '\n' +
      '- Work setup: ' + (cfg.workSetup || '(none)') + '\n' +
      '- Minimum salary: ' + (cfg.minSalary == null ? '(none)' : cfg.minSalary) + '\n' +
      '- Exclusions: ' + (cfg.hardNos || '(none)') + '\n\n' +
      'RULES:\n' +
      '- Only suggest a change the posting actually supports. If the settings already ' +
        'cover this role, say so and return no suggestions rather than inventing work.\n' +
      '- Never suggest lowering the minimum salary below what this posting pays.\n' +
      '- Titles are semicolon separated. Suggest the wording an employer would use in a ' +
        'job title, not a description of the work.\n' +
      '- Keep each "why" to one sentence, addressed to the person searching.\n' +
      '- If the page cannot be read, set readable to false and explain in problem.\n\n' +
      'Return ONLY a JSON object, no prose and no markdown fences:\n' +
      '{"readable": true, "problem": "", ' +
      '"role": {"title": "", "company": "", "salary": "", "salaryMin": <number or null>, ' +
      '"setup": "", "industry": "", "summary": ""}, ' +
      '"suggestions": [{"field": "titles|industry|workSetup|hardNos|minSalary", ' +
      '"action": "add|replace", "value": "<the new value, or the item to add>", "why": ""}]}';
  }

  function extractText(data) {
    return (data.content || [])
      .filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; })
      .join('\n');
  }

  /** True when every fetch the model attempted came back as an error block. */
  function fetchFailed(data) {
    var results = (data.content || []).filter(function (b) {
      return b.type === 'web_fetch_tool_result';
    });
    if (!results.length) return false;
    return results.every(function (b) {
      var c = b.content;
      return c && !Array.isArray(c) && c.error_code;
    });
  }

  function parseResult(text) {
    var cleaned = String(text == null ? '' : text)
      .replace(/```json/g, '').replace(/```/g, '').trim();
    var start = cleaned.indexOf('{');
    var end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) {
      throw new Error('The answer came back in an unexpected shape. Try again.');
    }
    var out;
    try {
      out = JSON.parse(cleaned.slice(start, end + 1));
    } catch (err) {
      throw new Error('The answer was not readable. Try again.');
    }
    out.suggestions = sanitise(out.suggestions);
    return out;
  }

  /**
   * Drops anything that names a field we do not edit, or that carries no value.
   * The settings are hers; a suggestion list is not a licence to write anywhere.
   */
  function sanitise(list) {
    return (Array.isArray(list) ? list : []).filter(function (s) {
      if (!s || EDITABLE.indexOf(s.field) === -1) return false;
      if (s.value == null || s.value === '') return false;
      if (s.field === 'minSalary' && !isFinite(Number(s.value))) return false;
      return true;
    }).map(function (s) {
      return {
        field: s.field,
        action: s.action === 'replace' ? 'replace' : 'add',
        value: s.field === 'minSalary' ? Number(s.value) : String(s.value).trim(),
        why: String(s.why || '').trim()
      };
    });
  }

  /** Works out what a setting becomes if a suggestion is accepted. */
  function applySuggestion(cfg, s) {
    var next = Object.assign({}, cfg);
    if (s.field === 'minSalary') { next.minSalary = Number(s.value); return next; }

    var current = String(cfg[s.field] || '').trim();
    if (s.action === 'replace' || !current) { next[s.field] = String(s.value); return next; }

    // Semicolon lists append; free text appends as another clause.
    var isList = s.field === 'titles' || s.field === 'hardNos';
    var sep = isList ? '; ' : '; ';
    var existing = current.split(';').map(function (v) { return v.trim().toLowerCase(); });
    if (existing.indexOf(String(s.value).trim().toLowerCase()) !== -1) return next;
    next[s.field] = current.replace(/;\s*$/, '') + sep + String(s.value).trim();
    return next;
  }

  async function refineFrom(apiKey, url, cfg, fetchImpl) {
    if (!apiKey) throw new Error('Add an Anthropic key in Settings first.');
    if (!url || !/^https?:\/\//i.test(String(url).trim())) {
      throw new Error('Paste the full web address of the job, starting with https://');
    }

    var doFetch = fetchImpl || globalThis.fetch;
    var res;
    try {
      res = await doFetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          tools: [FETCH_TOOL],
          messages: [{ role: 'user', content: buildPrompt(String(url).trim(), cfg || {}) }]
        })
      });
    } catch (err) {
      throw new Error('Could not reach Anthropic: ' + redact(err.message, apiKey));
    }

    if (!res.ok) {
      var e = new Error(describeError(res.status));
      e.status = res.status;
      throw e;
    }

    var data = await res.json();

    // A server tool failing does not fail the request, so check for it directly.
    if (fetchFailed(data)) {
      throw new Error('That page could not be read — some job sites block it. ' +
        'Try the employer\'s own listing, or paste the description into the résumé box instead.');
    }

    var out = parseResult(extractText(data));
    if (out.readable === false) {
      throw new Error(out.problem || 'That page could not be read.');
    }
    return out;
  }

  return {
    API_URL: API_URL,
    MODEL: MODEL,
    FETCH_TOOL: FETCH_TOOL,
    EDITABLE: EDITABLE,
    redact: redact,
    describeError: describeError,
    buildPrompt: buildPrompt,
    extractText: extractText,
    fetchFailed: fetchFailed,
    parseResult: parseResult,
    sanitise: sanitise,
    applySuggestion: applySuggestion,
    refineFrom: refineFrom
  };
});
