/**
 * Writing the Anthropic key into the repository from the dashboard.
 *
 * There are two Anthropic keys in this system and there is no way around that:
 * the page calls Anthropic directly for tailoring and lookups, and the workflow
 * calls it from the runner. A GitHub secret is write-only — not even a token
 * with full access can read one back — which is exactly what keeps the runner's
 * key out of the browser, and also why the page cannot simply borrow it.
 *
 * So the key goes the other way. She types it once, and this pushes the same
 * value into the repository secret, sealed so it is unreadable in transit and
 * unreadable to GitHub's own logs. One key, entered once, and nothing gets
 * slower or more public in the process.
 *
 * The sealing is libsodium's crypto_box_seal, which is what GitHub accepts:
 * an ephemeral X25519 keypair, a nonce derived from both public keys, and
 * XSalsa20-Poly1305. tweetnacl does the box; blake2b does the nonce.
 *
 * A UMD shim, so the Node tests exercise the same code the browser runs.
 */
(function (root, factory) {
  var api = factory(
    typeof require === 'function' ? require('./vendor/nacl.js') : root.nacl,
    typeof require === 'function' ? require('./vendor/blake2b.js') : root.blakejs
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JobScoutSecrets = api;
})(typeof self !== 'undefined' ? self : this, function (nacl, blakejs) {

  var API = 'https://api.github.com';

  function fromB64(b64) {
    var bin = atob(String(b64 || '').replace(/\s/g, ''));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function toB64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  /**
   * libsodium crypto_box_seal.
   *
   * The ciphertext is the ephemeral public key followed by the box. The nonce
   * is not transmitted — the recipient recomputes it from the two public keys,
   * which is why it has to be derived exactly this way and not chosen at
   * random. Getting that wrong still produces ciphertext; it just produces
   * ciphertext GitHub cannot open.
   */
  function seal(messageBytes, recipientPublicKey) {
    if (recipientPublicKey.length !== 32) {
      throw new Error('GitHub returned a public key of the wrong size.');
    }
    var eph = nacl.box.keyPair();

    var nonceInput = new Uint8Array(64);
    nonceInput.set(eph.publicKey, 0);
    nonceInput.set(recipientPublicKey, 32);
    var nonce = blakejs.blake2b(nonceInput, null, 24);

    var boxed = nacl.box(messageBytes, nonce, recipientPublicKey, eph.secretKey);

    var out = new Uint8Array(32 + boxed.length);
    out.set(eph.publicKey, 0);
    out.set(boxed, 32);
    return out;
  }

  /** Seals a string for a base64 public key, and returns base64 ciphertext. */
  function sealSecret(publicKeyB64, value) {
    return toB64(seal(new TextEncoder().encode(String(value)), fromB64(publicKeyB64)));
  }

  function describeError(status) {
    if (status === 401) return 'The GitHub token was rejected. Check it in Settings.';
    if (status === 403 || status === 404) {
      return 'That token cannot manage secrets. It needs the Secrets permission ' +
             'set to Read and write on this repository.';
    }
    if (status === 422) return 'GitHub would not accept the secret.';
    return 'GitHub returned ' + status + '.';
  }

  function ghFetch(token, path, init, fetchImpl) {
    var doFetch = fetchImpl || globalThis.fetch;
    var opts = Object.assign({ cache: 'no-store' }, init || {});
    opts.headers = Object.assign({
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': 'Bearer ' + token
    }, opts.headers || {});

    return doFetch(API + path, opts).then(function (res) {
      if (res.status === 204 || res.status === 201) return null;
      if (!res.ok) {
        var err = new Error(describeError(res.status));
        err.status = res.status;
        throw err;
      }
      return res.json();
    });
  }

  /**
   * Writes one Actions secret. The plaintext never leaves this function — only
   * the sealed bytes go over the wire, so the value is not in a request body
   * anything could log.
   */
  function putSecret(token, slug, name, value, fetchImpl) {
    if (!value) return Promise.reject(new Error('There is no key to send.'));

    return ghFetch(token, '/repos/' + slug + '/actions/secrets/public-key', null, fetchImpl)
      .then(function (pk) {
        if (!pk || !pk.key || !pk.key_id) {
          throw new Error('GitHub did not return a key to encrypt with.');
        }
        return ghFetch(token, '/repos/' + slug + '/actions/secrets/' + name, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            encrypted_value: sealSecret(pk.key, value),
            key_id: pk.key_id
          })
        }, fetchImpl);
      });
  }

  return {
    seal: seal,
    sealSecret: sealSecret,
    putSecret: putSecret,
    describeError: describeError,
    toB64: toB64,
    fromB64: fromB64
  };
});
