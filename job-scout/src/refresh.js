#!/usr/bin/env node
/**
 * Workflow entry point. Reads config.json and jobs.json, searches, merges,
 * writes jobs.json back only when something new turned up.
 *
 * Exits non-zero on a missing secret, a non-200 response, or unparseable JSON.
 * Writes `added=<n>` to $GITHUB_OUTPUT so the workflow can skip the commit step.
 */

var fs = require('fs');
var path = require('path');
var { parseResponse } = require('./parse');
var { mergeJobs, existingUrls } = require('./merge');
var { searchJobs } = require('./search');

var ROOT = path.join(__dirname, '..');
var CONFIG_PATH = path.join(ROOT, 'config.json');
var JOBS_PATH = path.join(ROOT, 'jobs.json');

function readJson(file, fallback) {
  if (!fs.existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw new Error('Missing required file: ' + path.relative(ROOT, file));
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error('Could not parse ' + path.relative(ROOT, file) + ': ' + err.message);
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function setOutput(key, value) {
  var file = process.env.GITHUB_OUTPUT;
  if (file) fs.appendFileSync(file, key + '=' + value + '\n');
}

async function main() {
  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Add it under Settings > Secrets and variables > Actions.');
  }

  var cfg = readJson(CONFIG_PATH);
  var jobs = readJson(JOBS_PATH, []);
  var seen = existingUrls(jobs);

  console.log('Searching with ' + seen.length + ' listing(s) already on the board.');

  var data = await searchJobs(apiKey, cfg, seen);
  var found = parseResponse(data);
  console.log('Model returned ' + found.length + ' listing(s).');

  var result = mergeJobs(jobs, found, today());
  console.log(result.added + ' new, ' + result.skipped + ' already seen or unusable.');

  setOutput('added', result.added);

  if (result.added === 0) {
    console.log('Nothing new — leaving jobs.json untouched.');
    return;
  }

  fs.writeFileSync(JOBS_PATH, JSON.stringify(result.jobs, null, 2) + '\n');
  console.log('Wrote ' + result.jobs.length + ' listing(s) to jobs.json.');
}

main().catch(function (err) {
  console.error('Refresh failed: ' + err.message);
  process.exit(1);
});
