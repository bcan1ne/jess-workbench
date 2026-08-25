/**
 * Parsing the Anthropic response.
 *
 * Two things make this fragile, and both are handled here rather than at the
 * call site: the content array mixes block types when the web_search tool runs,
 * and the model sometimes wraps the array in markdown fences despite being told
 * not to.
 */

/** Joins every text block in a Messages API response. */
function extractText(data) {
  return (data.content || [])
    .filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; })
    .join('\n');
}

/**
 * Pulls the JSON array out of the model's text.
 * Throws with a stable message so the workflow can fail loudly.
 */
function parseJobs(text) {
  var cleaned = String(text == null ? '' : text)
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();

  var start = cleaned.indexOf('[');
  var end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON array found in the response.');
  }

  var jobs;
  try {
    jobs = JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    throw new Error('Response was not parseable JSON: ' + err.message);
  }
  if (!Array.isArray(jobs)) {
    throw new Error('Response JSON was not an array.');
  }
  return jobs;
}

/** Convenience: response body in, job array out. */
function parseResponse(data) {
  return parseJobs(extractText(data));
}

module.exports = { extractText: extractText, parseJobs: parseJobs, parseResponse: parseResponse };
