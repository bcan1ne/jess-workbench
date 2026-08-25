var test = require('node:test');
var assert = require('node:assert');
var { extractText, parseJobs, parseResponse } = require('../parse');

var JOB = {
  fit: 8, company: 'Maven Clinic', title: 'Client Success Manager',
  url: 'https://job-boards.greenhouse.io/mavenclinic/jobs/1', salary: 'Not posted',
  salaryMin: null, setup: 'Remote', location: 'Remote - USA', lat: null, lon: null,
  industry: 'Virtual maternity', why: 'Domain match.', watchOuts: 'No salary posted.',
  posted: '2 days ago'
};

test('extractText joins only text blocks, skipping tool-use blocks', function () {
  var data = { content: [
    { type: 'server_tool_use', id: 'x', name: 'web_search', input: { query: 'jobs' } },
    { type: 'web_search_tool_result', tool_use_id: 'x', content: [{ type: 'web_search_result', url: 'https://e.com' }] },
    { type: 'text', text: 'Here are the roles:' },
    { type: 'text', text: '[]' }
  ] };
  assert.strictEqual(extractText(data), 'Here are the roles:\n[]');
});

test('extractText survives a missing content array', function () {
  assert.strictEqual(extractText({}), '');
});

test('extractText does not index into content[0]', function () {
  // The regression this guards: content[0] is a tool-use block, not the answer.
  var data = { content: [
    { type: 'server_tool_use', id: 'x', name: 'web_search', input: {} },
    { type: 'text', text: '[{"url":"https://a.com"}]' }
  ] };
  assert.deepStrictEqual(parseJobs(extractText(data)), [{ url: 'https://a.com' }]);
});

test('parseJobs reads a bare array', function () {
  assert.deepStrictEqual(parseJobs(JSON.stringify([JOB])), [JOB]);
});

test('parseJobs strips markdown fences', function () {
  var text = '```json\n' + JSON.stringify([JOB]) + '\n```';
  assert.deepStrictEqual(parseJobs(text), [JOB]);
});

test('parseJobs strips bare fences with no language tag', function () {
  var text = '```\n[{"fit":9}]\n```';
  assert.deepStrictEqual(parseJobs(text), [{ fit: 9 }]);
});

test('parseJobs ignores prose wrapped around the array', function () {
  var text = 'I found three roles.\n\n[{"fit":7}]\n\nLet me know if you want more.';
  assert.deepStrictEqual(parseJobs(text), [{ fit: 7 }]);
});

test('parseJobs handles an empty array', function () {
  assert.deepStrictEqual(parseJobs('[]'), []);
});

test('parseJobs preserves nulls for remote lat/lon', function () {
  var jobs = parseJobs('[{"lat":null,"lon":null}]');
  assert.strictEqual(jobs[0].lat, null);
  assert.strictEqual(jobs[0].lon, null);
});

test('parseJobs throws when there is no array at all', function () {
  assert.throws(function () { parseJobs('I could not find any roles.'); },
    /No JSON array found/);
});

test('parseJobs throws on malformed JSON rather than returning junk', function () {
  assert.throws(function () { parseJobs('[{"fit": 8,}]'); },
    /not parseable JSON/);
});

test('parseJobs throws on a JSON object instead of an array', function () {
  assert.throws(function () { parseJobs('nope [1,2] {"jobs": []}'); },
    /not parseable JSON|No JSON array/);
});

test('parseJobs throws on empty input', function () {
  assert.throws(function () { parseJobs(''); }, /No JSON array found/);
  assert.throws(function () { parseJobs(null); }, /No JSON array found/);
});

test('parseResponse goes from raw body to job array', function () {
  var data = { content: [{ type: 'text', text: '```json\n[{"fit":10}]\n```' }] };
  assert.deepStrictEqual(parseResponse(data), [{ fit: 10 }]);
});
