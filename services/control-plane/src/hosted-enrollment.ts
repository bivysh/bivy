// SPDX-License-Identifier: AGPL-3.0-only
import { decryptSecret, encryptSecret, type SecretEnvelope } from "./hosted-crypto.js";
import type { HostedMachineAttempt } from "./store.js";

/** Attempt-scoped bootstrap identity. Persist encrypted before provider effects;
 * a lost create response must not rotate the bearer on the adopted guest. */
export function hostedEnrollment(
  accountId: string,
  current: () => HostedMachineAttempt | undefined,
  save: (attempt: HostedMachineAttempt) => Promise<void>,
  retry = false,
) {
  const envelope = current()?.desired.enrollmentTokenEnc as SecretEnvelope | undefined;
  if (retry && !envelope && current()?.desired.bootstrapIdentityVersion !== 1) throw new Error("Legacy launch lacks saved enrollment; cleanup is required before a new launch");
  const token = envelope ? decryptSecret(accountId, envelope) : undefined;
  return {
    token,
    async persist(nodeId: string, value: string): Promise<void> {
      const attempt = current();
      if (!attempt || attempt.accountId !== accountId || attempt.nodeId !== nodeId) throw new Error("Enrollment has no matching durable attempt");
      const existing = attempt.desired.enrollmentTokenEnc as SecretEnvelope | undefined;
      if (existing) {
        if (decryptSecret(accountId, existing) !== value) throw new Error("Attempt enrollment identity changed");
        return;
      }
      await save({ ...attempt, desired: { ...attempt.desired, enrollmentTokenEnc: encryptSecret(accountId, value) } });
    },
  };
}
