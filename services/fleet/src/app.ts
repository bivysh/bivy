// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// The fleet's HTTP surface: the compute questions the control plane asks, on a
// private network behind one shared bearer token. Nothing here is reachable
// from the public internet in any supported deployment.
import express, { type NextFunction, type Request, type Response } from "express";
import type { CloudComputers } from "./computers.js";
import type { Runners } from "./runners.js";
import type { Admission } from "./policy.js";
import type { FleetStore } from "./store.js";
import type { ComputePurpose, FleetConfig } from "./settings.js";

export interface AppDeps {
  config: FleetConfig;
  store: FleetStore;
  admission: Admission;
  /** Absent while the fleet's configuration withholds launches. */
  computers?: CloudComputers;
  runners?: Runners;
  token: string;
}

class RequestInputError extends Error {}

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.get("/healthz", (_req, res) => void res.json({ ok: true }));
  app.get("/readyz", asyncRoute(async (_req, res) => {
    // Ready means the fleet can answer; whether it may launch is reported as
    // `problems`, so a misconfigured image never looks like an outage.
    await deps.store.list();
    res.json({ ok: true, offered: deps.config.offered, problems: deps.config.problems });
  }));

  app.use("/v1", bearerAuth(deps.token));

  app.post("/v1/compute/profile", asyncRoute(async (req, res) => {
    const purpose = req.body?.purpose;
    if (purpose !== "interactive" && purpose !== "auth-runner") return void res.status(400).json({ error: "Unknown compute purpose" });
    const runtimeId = typeof req.body?.runtimeId === "string" ? req.body.runtimeId : undefined;
    res.json({ profile: deps.config.profile(purpose as ComputePurpose, runtimeId) });
  }));

  app.post("/v1/compute/acquire", asyncRoute(async (req, res) => {
    if (!deps.computers) return void res.status(404).json({ error: "This fleet is not running cloud computers" });
    const result = await deps.computers.acquire({
      accountId: accountOf(req),
      purpose: requiredString(req.body?.purpose, "purpose"),
      requestId: requiredString(req.body?.requestId, "requestId"),
      ...(typeof req.body?.sessionId === "string" ? { sessionId: req.body.sessionId } : {}),
    });
    res.json(result.allowed ? { allowed: true, nodeId: result.nodeId, state: result.state } : result.decision);
  }));

  app.post("/v1/compute/wake", asyncRoute(async (req, res) => {
    if (!deps.computers) return void res.status(404).json({ error: "This fleet is not running cloud computers" });
    res.json(await deps.computers.wake(accountOf(req), requiredString(req.body?.nodeId, "nodeId"), optionalString(req.body?.reason) ?? "connect"));
  }));

  // Core: the computer did real work this boot (first agent turn or terminal).
  app.post("/v1/compute/used", asyncRoute(async (req, res) => {
    if (!deps.computers) return void res.json({});
    await deps.computers.used(accountOf(req), requiredString(req.body?.nodeId, "nodeId"), optionalString(req.body?.at) ?? new Date().toISOString());
    res.json({});
  }));

  app.post("/v1/compute/machines", asyncRoute(async (req, res) => {
    const accountId = accountOf(req);
    res.json({ machines: [
      ...(deps.computers ? await deps.computers.machines(accountId) : []),
      ...(deps.runners ? await deps.runners.machines(accountId) : []),
    ] });
  }));

  app.post("/v1/compute/sizes", asyncRoute(async (req, res) => {
    if (!deps.computers) return void res.status(404).json({ error: "This fleet is not running cloud computers" });
    res.json(await deps.computers.sizes(accountOf(req)));
  }));

  app.post("/v1/compute/size", asyncRoute(async (req, res) => {
    if (!deps.computers) return void res.status(404).json({ error: "This fleet is not running cloud computers" });
    const result = await deps.computers.setSize(accountOf(req), requiredString(req.body?.size, "size"));
    if (!result.ok) return void res.status(result.code === "unknown_size" ? 400 : 403).json({ error: result.reason, code: result.code });
    res.json(result);
  }));

  app.post("/v1/compute/disk", asyncRoute(async (req, res) => {
    if (!deps.computers) return void res.status(404).json({ error: "This fleet is not running cloud computers" });
    res.json({ disk: await deps.computers.disk(accountOf(req)) ?? null });
  }));

  app.post("/v1/compute/disk/grow", asyncRoute(async (req, res) => {
    if (!deps.computers) return void res.status(404).json({ error: "This fleet is not running cloud computers" });
    const sizeGb = Number(req.body?.sizeGb);
    if (!Number.isInteger(sizeGb)) throw new RequestInputError("sizeGb must be a whole number of GB");
    const result = await deps.computers.growDisk(accountOf(req), sizeGb);
    if (!result.ok) return void res.status(result.code === "invalid_size" ? 400 : result.code === "no_computer" ? 409 : 403).json({ error: result.reason, code: result.code });
    res.json(result);
  }));

  app.post("/v1/compute/release", asyncRoute(async (req, res) => {
    if (!deps.computers) return void res.json({ released: false });
    res.json({ released: await deps.computers.release(accountOf(req), requiredString(req.body?.nodeId, "nodeId")) });
  }));

  app.post("/v1/compute/runners/launch", asyncRoute(async (req, res) => {
    if (!deps.runners) return void res.status(404).json({ error: "This fleet is not running runners" });
    const result = await deps.runners.launch({
      accountId: accountOf(req),
      runnerId: requiredString(req.body?.runnerId, "runnerId"),
      requestId: requiredString(req.body?.requestId, "requestId"),
      ...(typeof req.body?.sessionId === "string" ? { sessionId: req.body.sessionId } : {}),
      ...(req.body?.sleeps === true ? { sleeps: true } : {}),
    });
    res.json(result.allowed ? { allowed: true, nodeId: result.nodeId, state: result.state } : result.decision);
  }));

  app.post("/v1/compute/runners/wake", asyncRoute(async (req, res) => {
    if (!deps.runners) return void res.status(404).json({ error: "This fleet is not running runners" });
    const result = await deps.runners.wake(accountOf(req), requiredString(req.body?.nodeId, "nodeId"));
    res.json(result.allowed ? { allowed: true, state: result.state } : result.decision);
  }));

  app.post("/v1/compute/runners/release", asyncRoute(async (req, res) => {
    if (!deps.runners) return void res.json({ released: false });
    res.json({ released: await deps.runners.release(accountOf(req), requiredString(req.body?.nodeId, "nodeId")) });
  }));

  // Metered machine time, so a deployment can show a meter or invoice from it.
  // `since` defaults to the start of this calendar month, UTC.
  app.post("/v1/compute/usage", asyncRoute(async (req, res) => {
    const accountId = accountOf(req);
    const now = new Date();
    const since = optionalString(req.body?.since) ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    if (Number.isNaN(Date.parse(since))) throw new RequestInputError("since must be an ISO timestamp");
    const left = await deps.admission.secondsLeft?.(accountId);
    res.json({ since, seconds: await deps.store.usedSeconds(accountId, since), ...(left === undefined ? {} : { secondsLeft: left }) });
  }));

  // Account lifecycle. A new account's computer starts now, so it is up by the
  // time its owner has signed in to their agent.
  app.post("/v1/events", asyncRoute(async (req, res) => {
    const accountId = accountOf(req);
    const event = req.body?.event;
    if (deps.computers && event?.type === "account.signed-in" && isNewAccount(event.accountCreatedAt, event.at)) {
      // The id goes in as an argument, not into the format string: console
      // reads `%s` in the first argument and would shift the rest.
      void deps.computers.acquireAtSignup(accountId)
        .catch((error) => console.warn("[fleet] sign-up start failed for", accountId, error instanceof Error ? error.message : error));
    }
    res.json({ ok: true });
  }));

  app.use(errorHandler);
  return app;
}

/** The sign-in that created the account, give or take clock skew between
 * services. A later sign-in must not restart a computer the owner released. */
const NEW_ACCOUNT_MS = 60_000;

function isNewAccount(createdAt: unknown, at: unknown): boolean {
  const created = Date.parse(typeof createdAt === "string" ? createdAt : "");
  const signedIn = Date.parse(typeof at === "string" ? at : "");
  if (!Number.isFinite(created) || !Number.isFinite(signedIn)) return false;
  return signedIn - created <= NEW_ACCOUNT_MS;
}

function bearerAuth(expected: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!expected || token !== expected) return void res.status(401).json({ error: "Unauthorized" });
    next();
  };
}

function accountOf(req: Request): string {
  return requiredString(req.body?.subject?.accountId, "subject.accountId");
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new RequestInputError(`${name} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };
}

function errorHandler(error: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(error);
  if (error instanceof RequestInputError) return void res.status(400).json({ error: error.message });
  console.error("[fleet] request failed:", error instanceof Error ? error.stack ?? error.message : error);
  res.status(500).json({ error: "The fleet could not complete this request" });
}
