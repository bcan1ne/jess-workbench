#!/usr/bin/env node
/**
 * Stages the publishable site.
 *
 * The dashboard lives in site/ and the data it reads lives one level up, so
 * something has to put them in the same directory. This does, for both the
 * Pages deploy and `npm run preview`.
 *
 *   node job-scout/build.js            build into job-scout/_site
 *   node job-scout/build.js --serve    build, then serve it on :8080
 */

var fs = require('fs');
var path = require('path');
var http = require('http');

var ROOT = __dirname;
var SITE = path.join(ROOT, 'site');
var OUT = path.join(ROOT, '_site');
var DATA = ['config.json', 'companies.json', 'jobs.json', 'locals.json', 'statuses.json'];

var TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.cpSync(SITE, OUT, { recursive: true });

  DATA.forEach(function (f) {
    var src = path.join(ROOT, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(OUT, f));
    } else if (f === 'statuses.json') {
      fs.writeFileSync(path.join(OUT, f), '{}\n');
    } else {
      throw new Error('Missing required data file: ' + f);
    }
  });

  console.log('Built ' + path.relative(process.cwd(), OUT));
}

function serve(port) {
  http.createServer(function (req, res) {
    var rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') rel = '/index.html';
    var file = path.join(OUT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(OUT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(port, function () {
    console.log('Preview at http://localhost:' + port);
  });
}

build();
if (process.argv.includes('--serve')) serve(Number(process.env.PORT) || 8080);
