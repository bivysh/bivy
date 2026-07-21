# Release signing

Bivy's one-line installer verifies the release tarball in two layers:

1. `sha256` in `bivy-latest.json` must match the downloaded tarball.
2. The manifest must carry an Ed25519 signature over the canonical JSON body (the manifest without the `signature` field).

`install.sh` now fails closed when no verification key is configured. Internal tests may set `BIVY_ALLOW_UNSIGNED_MANIFEST=1`; fully unverified internal artifacts may set `BIVY_ALLOW_UNVERIFIED_INSTALL=1`.

## Production key handling

- Generate an Ed25519 signing keypair offline.
- Store the private key only in the private ops/release environment.
- Keep the public key in the public installer.
- Rotate by shipping an installer that trusts both old and new public keys, then remove the old key after the cutover window.

## Build pipeline

`npm run build:release` supports:

- `BIVY_RELEASE_SIGNING_KEY_PEM` or `BIVY_RELEASE_SIGNING_KEY_FILE` — signs `site/downloads/bivy-latest.json`.
- `BIVY_RELEASE_VERIFY_KEY_PEM` or `BIVY_RELEASE_VERIFY_KEY_FILE` — embeds the public verification key into `site/install.sh`.

The private release pipeline should provide both. If it signs without a public verification key, the build prints a warning because the served installer would refuse production installs.

## Manual verification

```bash
BIVY_RELEASE_SIGNING_KEY_FILE=/secure/bivy-release-ed25519.pem \
BIVY_RELEASE_VERIFY_KEY_FILE=/secure/bivy-release-ed25519.pub.pem \
  npm run build:release

bash site/install.sh # against the generated artifact/manifest, or deploy and curl it
```

Before publishing a release, verify:

- manifest has `sha256`;
- manifest has `signature.alg === "Ed25519"`;
- `site/install.sh` contains the public key;
- install fails if the tarball is modified;
- install fails if the manifest signature is removed or changed.
