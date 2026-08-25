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
var { fetchAll, prefilter, hydrate } = require('./sources');
var { batches, scoreBatch, keepKnownUrls } = require('./score');
var { boardKey } = require('../site/boards');

var ROOT = path.join(__dirname, '..');
var CONFIG_PATH = path.join(ROOT, 'config.json');
var JOBS_PATH = path.join(ROOT, 'jobs.json');
var COMPANIES_PATH = path.join(ROOT, 'companies.json');
var BOARDS_PATH = path.join(ROOT, 'boards.json');

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

/**
 * Records how each watched board answered, so the dashboard can show a row as
 * broken instead of silently contributing nothing week after week.
 *
 * Written the moment polling finishes, before anything that can fail — the run
 * that first revealed sixteen dead boards was itself a failed run, and health
 * she cannot see is health she cannot act on.
 */
function writeBoardHealth(results) {
  var boards = {};
  (results || []).forEach(function (r) {
    var key = boardKey(r.company);
    if (!key) return;
    boards[key] = {
      name: r.company.name || r.company.board,
      ok: r.ok,
      postings: r.count,
      reason: r.reason || ''
    };
  });
  fs.writeFileSync(BOARDS_PATH,
    JSON.stringify({ checked: today(), boards: boards }, null, 2) + '\n');
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

  console.log('Board has ' + seen.length + ' listing(s).');

  var found = [];

  // 1. Watch the known-good employers. Deterministic, and every url is theirs.
  var companies = readJson(COMPANIES_PATH, []);
  if (companies.length) {
    console.log('\nPolling ' + companies.length + ' company board(s):');
    var polled = await fetchAll(companies, null, console.log);
    console.log(polled.postings.length + ' posting(s) total, ' +
      polled.failures.length + ' board(s) unreachable.');
    writeBoardHealth(polled.results);

    var gate = prefilter(polled.postings, cfg, seen);
    console.log(gate.kept.length + ' past the title filter, ' + gate.dropped + ' dropped.');

    // Some boards list titles without descriptions. Fetch those now, after the
    // filter, so a big board costs a few requests rather than one per opening.
    var needing = gate.kept.filter(function (p) { return p.detail && !p.description; }).length;
    if (needing) console.log('Reading ' + needing + ' full description(s)…');
    var ready = await hydrate(gate.kept, null, console.log);
    if (ready.length !== gate.kept.length) {
      console.log((gate.kept.length - ready.length) + ' dropped — description unreadable.');
    }

    for (var group of batches(ready)) {
      var scoredRaw = parseResponse(await scoreBatch(apiKey, cfg, group));
      var scored = keepKnownUrls(scoredRaw, group);
      if (scored.length !== scoredRaw.length) {
        console.log('Dropped ' + (scoredRaw.length - scored.length) +
          ' scored listing(s) whose url was not one we supplied.');
      }
      found = found.concat(scored);
    }
    console.log(found.length + ' scored from company boards.');
  }

  // 2. Search the open web for employers not on the list.
  console.log('\nSearching the web for new employers…');
  var searched = parseResponse(await searchJobs(apiKey, cfg, seen.concat(
    found.map(function (j) { return j.url; }))));
  console.log(searched.length + ' listing(s) from search.');
  found = found.concat(searched);

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
