// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Imported first by server.ts, so the node's environment is clean before any
// module reads it or launches an agent (see runtime/inherited-session-env.ts).
import { scrubInheritedSessionEnv } from "./runtime/inherited-session-env.js";

scrubInheritedSessionEnv();
