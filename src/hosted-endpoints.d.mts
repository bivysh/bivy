// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
export declare const DEFAULT_HOSTED_DOMAIN: string;

export interface HostedEndpoints {
  domain: string;
  controlPlane: string;
  relay: string;
  clientBaseUrl: string;
}

export declare function hostedEndpoints(
  env?: Record<string, string | undefined>,
): HostedEndpoints;
