// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Check a release archive's GitHub build attestation before it is installed.
 *
 * The SHA256SUMS / manifest.json digests come from the same release as the
 * archive, so on their own they only catch a corrupt download: anyone able to
 * upload release assets could replace both. The attestation is different. It
 * is a Sigstore bundle whose short-lived certificate GitHub issues only to the
 * release workflow's own OIDC identity, so a valid one proves this exact file
 * was built by `release.yml` in the Bivy repository from a release tag or
 * `main` (staging).
 *
 * Verification uses the Sigstore client npm ships for package provenance,
 * which is part of the Node runtime every archive carries; nothing extra is
 * installed. It runs in the version already installed, which the user trusts,
 * against the archive about to replace it.
 */
import { X509Certificate } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

/** The only signer whose attestations an archive install accepts. */
export const RELEASE_SIGNER = {
  workflow: ".github/workflows/release.yml",
  issuer: "https://token.actions.githubusercontent.com",
};

/** "owner/repo" for a GitHub releases URL; undefined for any other source. */
export function releaseRepo(releasesUrl) {
  return /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/?$/.exec(releasesUrl)?.[1];
}

/** The refs a release of `version` may be built from: its tag, or `main` for staging. */
export function signerIdentities(repo, version) {
  const base = `https://github.com/${repo}/${RELEASE_SIGNER.workflow}@`;
  return [`${base}refs/tags/v${version}`, `${base}refs/heads/main`];
}

/** The workflow identity in a bundle's signing certificate. */
function bundleIdentity(bundle) {
  const material = bundle?.verificationMaterial ?? {};
  const raw = material.certificate?.rawBytes ?? material.x509CertificateChain?.certificates?.[0]?.rawBytes;
  if (!raw) return undefined;
  return /URI:([^,\s]+)/.exec(new X509Certificate(Buffer.from(raw, "base64")).subjectAltName ?? "")?.[1];
}

/** Whether the bundle's in-toto statement names this file with this digest. */
function bundleCovers(bundle, file, sha256) {
  try {
    const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8"));
    return statement.subject?.some((subject) => subject.name === file && subject.digest?.sha256 === sha256) === true;
  } catch {
    return false;
  }
}

/** npm's bundled Sigstore client, from the Node runtime running this CLI. */
export function loadSigstore(execPath = process.execPath) {
  const candidates = [
    path.join(path.dirname(execPath), "..", "lib", "node_modules", "npm", "node_modules", "sigstore"),
    "sigstore",
  ];
  const require = createRequire(import.meta.url);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try the next location.
    }
  }
  throw new Error("This Bivy has no Sigstore client to check the release attestation with.");
}

/**
 * Throw unless GitHub holds an attestation for `sha256` that names `file`, was
 * signed by the release workflow of `repo` for `version`, and verifies against
 * Sigstore's public-good roots.
 */
export async function verifyReleaseAttestation({ repo, version, file, sha256, fetchImpl = fetch, sigstore }) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/attestations/sha256:${sha256}`, {
    headers: { accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) throw new Error(`${file} has no build attestation in ${repo}; refusing to install it.`);
  if (!res.ok) throw new Error(`Could not read ${file}'s build attestation (${res.status} from GitHub).`);
  const bundles = ((await res.json())?.attestations ?? []).map((attestation) => attestation?.bundle).filter(Boolean);
  const identities = new Set(signerIdentities(repo, version));
  const candidates = bundles.filter((bundle) => identities.has(bundleIdentity(bundle)) && bundleCovers(bundle, file, sha256));
  if (!candidates.length) throw new Error(`${file}'s attestations were not made by ${repo}'s release workflow for ${version}; refusing to install it.`);
  const client = sigstore ?? loadSigstore();
  let lastError;
  for (const bundle of candidates) {
    try {
      await client.verify(bundle, { certificateIssuer: RELEASE_SIGNER.issuer, certificateIdentityURI: bundleIdentity(bundle) });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${file}'s build attestation did not verify: ${lastError?.message ?? "unknown error"}`);
}
