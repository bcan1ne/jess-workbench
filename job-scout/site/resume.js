/**
 * Résumé tailoring, in the browser.
 *
 * This is the one path that does NOT go through Actions, and deliberately so.
 * The repository is public, so a résumé committed to it — or passed as a
 * workflow input, or printed in a run log — would be world-readable. There is
 * nothing to accumulate here either: she wants a document to download and send,
 * not a history. So the résumé stays in localStorage, the call goes straight to
 * Anthropic, and neither the résumé nor the tailored output ever touches the
 * repository.
 *
 * The cost is an Anthropic key in the browser, which is why the key field warns
 * about it and why every error path is scrubbed.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JobScoutResume = api;
})(typeof self !== 'undefined' ? self : this, function () {

  var API_URL = 'https://api.anthropic.com/v1/messages';
  var MODEL = 'claude-opus-5';
  var MAX_TOKENS = 8000;

  function redact(text, apiKey) {
    var out = String(text == null ? '' : text);
    if (apiKey) out = out.split(apiKey).join('[redacted]');
    return out.replace(/sk-ant-[A-Za-z0-9_\-]+/g, '[redacted]');
  }

  function describeError(status) {
    if (status === 401) return 'The Anthropic key was rejected. Check it in Settings.';
    if (status === 403) return 'That Anthropic key is not allowed to make this request.';
    if (status === 400) return 'Anthropic rejected the request. The résumé may be too long.';
    if (status === 429) return 'Rate limited by Anthropic. Wait a moment and try again.';
    if (status >= 500) return 'Anthropic returned ' + status + '. Try again shortly.';
    return 'Anthropic returned ' + status + '.';
  }

  function jobBrief(job) {
    return [
      'Title: ' + (job.title || ''),
      'Company: ' + (job.company || ''),
      'Location: ' + (job.location || ''),
      'Work setup: ' + (job.setup || ''),
      'Posted salary: ' + (job.salary || 'not posted'),
      'Industry: ' + (job.industry || ''),
      'Why it was matched: ' + (job.why || ''),
      'Known gaps and watch-outs: ' + (job.watchOuts || 'none noted'),
      'Listing URL: ' + (job.url || '')
    ].join('\n');
  }

  function buildPrompt(resume, job) {
    return 'Tailor this résumé for one specific job posting.\n\n' +
      '=== CURRENT RÉSUMÉ ===\n' + resume + '\n\n' +
      '=== TARGET ROLE ===\n' + jobBrief(job) + '\n\n' +
      'RULES:\n' +
      '- Never invent employers, titles, dates, degrees, certifications, metrics, or ' +
        'responsibilities. Every claim must trace to something already in the résumé.\n' +
      '- Reorder, reword, and re-emphasise what is there. Promote the experience this ' +
        'posting cares about; compress what it does not.\n' +
      '- Mirror the posting\'s vocabulary only where the underlying experience genuinely ' +
        'matches. Do not keyword-stuff.\n' +
      '- Address the watch-outs above where the résumé has real evidence to offer. Where it ' +
        'does not, leave the gap alone rather than papering over it.\n' +
      '- Keep it to one page of content unless the original is clearly longer.\n\n' +
      'Return the tailored résumé in Markdown, then a final section titled ' +
      '"## What changed and why" with a short bulleted list of the edits you made and the ' +
      'reasoning. Nothing else — no preamble.';
  }

  /** Joins the text blocks; a response can carry more than one. */
  function extractText(data) {
    return (data.content || [])
      .filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; })
      .join('\n');
  }

  /** Splits the model's answer into the résumé and the rationale. */
  function splitResult(text) {
    var t = String(text == null ? '' : text).trim();
    var m = t.match(/\n#{1,3}\s*What changed and why\s*\n/i);
    if (!m) return { resume: t, notes: '' };
    return {
      resume: t.slice(0, m.index).trim(),
      notes: t.slice(m.index + m[0].length).trim()
    };
  }

  async function tailor(apiKey, resume, job, fetchImpl) {
    if (!apiKey) throw new Error('Add an Anthropic key in Settings first.');
    if (!resume || !resume.trim()) throw new Error('Add a résumé in Settings first.');

    var doFetch = fetchImpl || globalThis.fetch;
    var res;
    try {
      res = await doFetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          // Browser calls are refused without this; the name is Anthropic's own
          // warning that the key is exposed to anything running in the page.
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          messages: [{ role: 'user', content: buildPrompt(resume, job) }]
        })
      });
    } catch (err) {
      throw new Error('Could not reach Anthropic: ' + redact(err.message, apiKey));
    }

    if (!res.ok) {
      var err2 = new Error(describeError(res.status));
      err2.status = res.status;
      throw err2;
    }

    var data = await res.json();
    var text = extractText(data);
    if (!text.trim()) throw new Error('Anthropic returned an empty response. Try again.');
    return splitResult(text);
  }

  return {
    API_URL: API_URL,
    MODEL: MODEL,
    redact: redact,
    describeError: describeError,
    jobBrief: jobBrief,
    buildPrompt: buildPrompt,
    extractText: extractText,
    splitResult: splitResult,
    tailor: tailor
  };
});
