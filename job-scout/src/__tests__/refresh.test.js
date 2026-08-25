var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var REPO = path.join(__dirname, '..', '..');

/**
 * Runs the real entry point against a stubbed fetch, in a throwaway copy, so
 * what gets committed on a failed run is asserted rather than assumed.
 */
function runRefresh(stubBody, companies) {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-'));
  fs.cpSync(REPO, path.join(tmp, 'job-scout'), { recursive: true });
  fs.rmSync(path.join(tmp, 'job-scout', '_site'), { recursive: true, force: true });
  fs.writeFileSync(path.join(tmp, 'job-scout', 'companies.json'),
    JSON.stringify(companies, null, 2));
  fs.writeFileSync(path.join(tmp, 'job-scout', 'boards.json'), '{}\n');

  fs.writeFileSync(path.join(tmp, 'run.js'), stubBody + '\nrequire(' +
    JSON.stringify(path.join(tmp, 'job-scout', 'src', 'refresh.js')) + ');\n');

  var out = path.join(tmp, 'gh_out');
  fs.writeFileSync(out, '');
  var r = cp.spawnSync(process.execPath, [path.join(tmp, 'run.js')], {
    encoding: 'utf8',
    env: Object.assign({}, process.env,
      { ANTHROPIC_API_KEY: 'sk-ant-notreal', GITHUB_OUTPUT: out })
  });
  var health = JSON.parse(fs.readFileSync(path.join(tmp, 'job-scout', 'boards.json'), 'utf8'));
  fs.rmSync(tmp, { recursive: true, force: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, health: health };
}

var GREENHOUSE_OK = `
globalThis.fetch = function (url) {
  if (url.indexOf('boards-api.greenhouse.io') !== -1) {
    if (url.indexOf('goneco') !== -1) {
      return Promise.resolve({ ok: false, status: 404,
        json: function () { return Promise.resolve({}); } });
    }
    return Promise.resolve({ ok: true, status: 200, json: function () {
      return Promise.resolve({ jobs: [] });
    } });
  }
  // Anthropic refuses the key, exactly as the live runs did.
  return Promise.resolve({ ok: false, status: 401,
    text: function () { return Promise.resolve('{"error":"invalid x-api-key"}'); },
    json: function () { return Promise.resolve({}); } });
};
`;

var WATCH = [
  { name: 'Live Co', ats: 'greenhouse', board: 'liveco' },
  { name: 'Gone Co', ats: 'greenhouse', board: 'goneco' }
];

test('a run that dies at the Anthropic call still records why, and the board ' +
     'results it had already gathered', function () {
  var r = runRefresh(GREENHOUSE_OK, WATCH);

  assert.strictEqual(r.status, 1, 'a rejected key must fail the run');
  assert.match(r.stderr, /401/);

  // The reason is committed, so the dashboard can say it instead of "failure".
  assert.strictEqual(r.health.lastRun.ok, false);
  assert.match(r.health.lastRun.reason, /rejected \(401\)/);

  // Recording the outcome must not wipe the board results from the same run.
  assert.strictEqual(r.health.boards['greenhouse:liveco'].ok, true);
  assert.strictEqual(r.health.boards['greenhouse:goneco'].ok, false);
  assert.match(r.health.boards['greenhouse:goneco'].reason, /404/);
});

test('the key never reaches the committed health file, whatever the error said', function () {
  var leaky = `
globalThis.fetch = function () {
  return Promise.resolve({ ok: false, status: 401,
    text: function () { return Promise.resolve('rejected key sk-ant-notreal'); },
    json: function () { return Promise.resolve({}); } });
};
`;
  var r = runRefresh(leaky, WATCH);
  var text = JSON.stringify(r.health);
  assert.ok(text.indexOf('sk-ant-notreal') === -1, 'the key must not be committed');
  assert.ok(r.stderr.indexOf('sk-ant-notreal') === -1, 'nor logged');
});
