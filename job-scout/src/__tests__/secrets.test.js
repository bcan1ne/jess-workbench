var test = require('node:test');
var assert = require('node:assert');
var S = require('../../site/secrets.js');
var nacl = require('../../site/vendor/nacl.js');
var blakejs = require('../../site/vendor/blake2b.js');

/*
 * The sealed box was cross-checked against libsodium itself during
 * development: a libsodium keypair, sealed here, opened by
 * crypto_box_seal_open. That check needs a dependency this repo does not
 * carry, so what stays here pins the two things that could silently drift and
 * would produce ciphertext GitHub cannot open — the BLAKE2b compression
 * function, and the seal's wire format.
 */

test('blake2b matches the RFC 7693 vector — the nonce derivation rests on it',
  function () {
    assert.strictEqual(
      blakejs.blake2bHex(new TextEncoder().encode('abc'), null, 64),
      'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1' +
      '7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923');
  });

test('a sealed secret opens with the recipient key, in libsodium\'s format',
  function () {
    var recipient = nacl.box.keyPair();
    var message = 'sk-ant-api03-not-a-real-key';

    var sealed = S.fromB64(S.sealSecret(
      Buffer.from(recipient.publicKey).toString('base64'), message));

    // Ephemeral public key first, then the box. The nonce is not transmitted.
    assert.strictEqual(sealed.length, 32 + message.length + 16);
    var eph = sealed.slice(0, 32);
    var boxed = sealed.slice(32);

    // The recipient recomputes the nonce from both public keys — this exact
    // derivation is what makes the ciphertext openable at all.
    var nonceInput = new Uint8Array(64);
    nonceInput.set(eph, 0);
    nonceInput.set(recipient.publicKey, 32);
    var nonce = blakejs.blake2b(nonceInput, null, 24);

    var opened = nacl.box.open(boxed, nonce, eph, recipient.secretKey);
    assert.ok(opened, 'the box must open');
    assert.strictEqual(new TextDecoder().decode(opened), message);
  });

test('every sealing is different — a reused ephemeral key would leak', function () {
  var pk = Buffer.from(nacl.box.keyPair().publicKey).toString('base64');
  assert.notStrictEqual(S.sealSecret(pk, 'same value'), S.sealSecret(pk, 'same value'));
});

test('a public key of the wrong size is refused, not sealed into junk', function () {
  assert.throws(function () { S.sealSecret(Buffer.from([1, 2, 3]).toString('base64'), 'x'); },
    /wrong size/);
});

test('the plaintext never appears in the request body', async function () {
  var seen = [];
  await S.putSecret('github_pat_x', 'o/r', 'ANTHROPIC_API_KEY', 'sk-ant-secret-value',
    function (url, opts) {
      seen.push({ url: url, body: opts && opts.body });
      if (url.indexOf('public-key') !== -1) {
        return Promise.resolve({
          ok: true, status: 200, json: function () {
            return Promise.resolve({
              key_id: '568250167242549743',
              key: Buffer.from(nacl.box.keyPair().publicKey).toString('base64')
            });
          }
        });
      }
      return Promise.resolve({ ok: true, status: 204, json: function () {
        return Promise.resolve(null); } });
    });

  var put = seen[1];
  assert.match(put.url, /\/actions\/secrets\/ANTHROPIC_API_KEY$/);
  assert.ok(put.body.indexOf('sk-ant-secret-value') === -1,
    'the key must not be sent in the clear');
  assert.match(put.body, /"key_id":"568250167242549743"/);
});

test('a token without the Secrets permission is explained, not just a number',
  function () {
    assert.match(S.describeError(403), /Secrets permission/);
    assert.match(S.describeError(404), /Secrets permission/);
    assert.match(S.describeError(401), /token was rejected/);
  });
