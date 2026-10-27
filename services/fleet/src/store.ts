// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// What the fleet remembers: one record per cloud computer, one per runner, the
// size each account picked, and a ledger of metered awake time. Infrastructure
// facts only — no credentials and nothing from inside a session.
import { Pool } from "pg";

/** One cloud computer per account. */
export interface CloudComputerRecord {
  accountId: string;
  nodeId: string;
  app: string;
  machineId?: string;
  volumeId?: string;
  /** The disk's size. Only ever grows. Absent on records from before disk
   * sizes were kept: those disks are the fleet's default size. */
  diskGb?: number;
  region: string;
  size: string;
  image?: string;
  /** Last observed: launching | awake | asleep | gone. */
  state: string;
  /** When the current awake period began (for metering). */
  awakeSince?: string;
  awakeSeconds: number;
  /** The metering run for the current awake period, if any. */
  openRun?: string;
  /** What started the current awake period (an acquire purpose or a wake
   * reason). An early start (SPECULATIVE_STARTS) is metered only from
   * `meteredFrom`, its first real use. Absent on older records: metered from
   * `awakeSince`, as before. */
  startedFor?: string;
  /** First real use in an early-started awake period. */
  meteredFrom?: string;
  /** The last stop was an unused early start running out of grace: a client's
   * automatic reconnect doesn't start it again, only presence or use does. */
  stoppedUnused?: boolean;
  lastWokeAt?: string;
  /** When the account was told this idle machine will be deleted. */
  deletionWarnedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** One machine for one piece of work, beside the account's computer. Normally
 * disposable: when it stops, its machine and disk are deleted and the session
 * lives on in Core's snapshot. A session's runner (`sleeps`) is kept instead. */
export interface RunnerRecord {
  accountId: string;
  /** Core's id for the work this runner does (a session or work item). */
  runnerId: string;
  /** Unset until Core has enrolled the runner's node. */
  nodeId?: string;
  app: string;
  machineId?: string;
  volumeId?: string;
  region: string;
  size: string;
  /** The image it was created or last woken with. */
  image?: string;
  /** A session's runner: it sleeps when idle and wakes for follow-ups, instead
   * of being deleted once it stops. */
  sleeps?: boolean;
  /** launching | waking | awake | asleep. */
  state: string;
  awakeSince?: string;
  /** When reconcile first saw it asleep: the idle-deletion clock. */
  asleepSince?: string;
  /** The account was told this sleeping runner will be deleted. */
  deletionWarnedAt?: string;
  /** The runner's metering run, open until it is settled. */
  openRun?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FleetStore {
  init(): Promise<void>;
  get(accountId: string): Promise<CloudComputerRecord | undefined>;
  put(record: CloudComputerRecord): Promise<void>;
  delete(accountId: string): Promise<void>;
  list(): Promise<CloudComputerRecord[]>;
  /** The size the account picked. Kept apart from the record so it outlives the machine. */
  sizePreference(accountId: string): Promise<string | undefined>;
  setSizePreference(accountId: string, size: string): Promise<void>;
  getRunner(accountId: string, runnerId: string): Promise<RunnerRecord | undefined>;
  putRunner(record: RunnerRecord): Promise<void>;
  deleteRunner(accountId: string, runnerId: string): Promise<void>;
  /** Every runner, or one account's. */
  listRunners(accountId?: string): Promise<RunnerRecord[]>;
  /** Run `fn` holding the account's lock, so two requests never create two machines. */
  withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T>;
  /** Close a metering run. `machineSeconds` are Standard seconds: awake time
   * times the size's weight. Re-settling the same run keeps the longer of the
   * two, so a retried launch can never meter an awake period twice. */
  settle(accountId: string, runId: string, at: string, machineSeconds: number): Promise<void>;
  /** A launch that never produced a running machine. Recorded, metered at zero. */
  fail(accountId: string, runId: string, at: string): Promise<void>;
  /** Metered seconds settled at or after `since`. An awake period is counted
   * when it ends, so a machine that is up right now is not in this total; one
   * awake stretch is bounded by the fleet's awake cap. */
  usedSeconds(accountId: string, since: string): Promise<number>;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS fleet_machines (
    account_id     TEXT PRIMARY KEY,
    record         JSONB NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS fleet_runners (
    account_id     TEXT NOT NULL,
    runner_id      TEXT NOT NULL,
    record         JSONB NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, runner_id)
  );
  CREATE TABLE IF NOT EXISTS fleet_preferences (
    account_id     TEXT PRIMARY KEY,
    size           TEXT NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS fleet_runs (
    account_id      TEXT NOT NULL,
    run_id          TEXT NOT NULL,
    state           TEXT NOT NULL,
    machine_seconds BIGINT NOT NULL DEFAULT 0,
    settled_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, run_id)
  );
  CREATE INDEX IF NOT EXISTS fleet_runs_usage ON fleet_runs(account_id, settled_at);
`;

export class PostgresFleetStore implements FleetStore {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  async init(): Promise<void> {
    await this.pool.query(SCHEMA);
  }

  async get(accountId: string): Promise<CloudComputerRecord | undefined> {
    const { rows } = await this.pool.query(`SELECT record FROM fleet_machines WHERE account_id = $1`, [accountId]);
    return rows[0]?.record as CloudComputerRecord | undefined;
  }

  async put(record: CloudComputerRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO fleet_machines (account_id, record, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (account_id) DO UPDATE SET record = EXCLUDED.record, updated_at = now()`,
      [record.accountId, record],
    );
  }

  async delete(accountId: string): Promise<void> {
    await this.pool.query(`DELETE FROM fleet_machines WHERE account_id = $1`, [accountId]);
  }

  async list(): Promise<CloudComputerRecord[]> {
    const { rows } = await this.pool.query(`SELECT record FROM fleet_machines`);
    return rows.map((row) => row.record as CloudComputerRecord);
  }

  async sizePreference(accountId: string): Promise<string | undefined> {
    const { rows } = await this.pool.query(`SELECT size FROM fleet_preferences WHERE account_id = $1`, [accountId]);
    return rows[0]?.size as string | undefined;
  }

  async setSizePreference(accountId: string, size: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO fleet_preferences (account_id, size, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (account_id) DO UPDATE SET size = EXCLUDED.size, updated_at = now()`,
      [accountId, size],
    );
  }

  async getRunner(accountId: string, runnerId: string): Promise<RunnerRecord | undefined> {
    const { rows } = await this.pool.query(`SELECT record FROM fleet_runners WHERE account_id = $1 AND runner_id = $2`, [accountId, runnerId]);
    return rows[0]?.record as RunnerRecord | undefined;
  }

  async putRunner(record: RunnerRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO fleet_runners (account_id, runner_id, record, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (account_id, runner_id) DO UPDATE SET record = EXCLUDED.record, updated_at = now()`,
      [record.accountId, record.runnerId, record],
    );
  }

  async deleteRunner(accountId: string, runnerId: string): Promise<void> {
    await this.pool.query(`DELETE FROM fleet_runners WHERE account_id = $1 AND runner_id = $2`, [accountId, runnerId]);
  }

  async listRunners(accountId?: string): Promise<RunnerRecord[]> {
    const { rows } = accountId
      ? await this.pool.query(`SELECT record FROM fleet_runners WHERE account_id = $1`, [accountId])
      : await this.pool.query(`SELECT record FROM fleet_runners`);
    return rows.map((row) => row.record as RunnerRecord);
  }

  async settle(accountId: string, runId: string, at: string, machineSeconds: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO fleet_runs (account_id, run_id, state, machine_seconds, settled_at)
       VALUES ($1, $2, 'settled', $3, $4)
       ON CONFLICT (account_id, run_id) DO UPDATE
         SET state = 'settled',
             machine_seconds = GREATEST(fleet_runs.machine_seconds, EXCLUDED.machine_seconds),
             settled_at = EXCLUDED.settled_at`,
      [accountId, runId, Math.max(0, Math.round(machineSeconds)), at],
    );
  }

  async fail(accountId: string, runId: string, at: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO fleet_runs (account_id, run_id, state, machine_seconds, settled_at)
       VALUES ($1, $2, 'failed', 0, $3) ON CONFLICT (account_id, run_id) DO NOTHING`,
      [accountId, runId, at],
    );
  }

  async usedSeconds(accountId: string, since: string): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(SUM(machine_seconds), 0)::bigint AS used FROM fleet_runs
       WHERE account_id = $1 AND settled_at >= $2`,
      [accountId, since],
    );
    return Number(rows[0]?.used ?? 0);
  }

  /** A waiter must not hold a pooled connection: the holder's own queries need
   * one, and waiters blocked in pg_advisory_lock on every connection deadlocked
   * the pool. So wait with try-lock, giving the connection back between tries. */
  async withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const key = `bivy-fleet:${accountId}`;
    let delay = 25;
    for (;;) {
      const client = await this.pool.connect();
      let locked = false;
      try {
        locked = (await client.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [key])).rows[0]?.locked === true;
        if (locked) {
          try { return await fn(); }
          finally { await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [key]); }
        }
      } finally {
        client.release();
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(500, delay * 2);
    }
  }

  async close(): Promise<void> { await this.pool.end(); }
}

/** For tests and a single-process deployment that keeps no history. */
export class MemoryFleetStore implements FleetStore {
  readonly records = new Map<string, CloudComputerRecord>();
  readonly sizes = new Map<string, string>();
  readonly runners = new Map<string, RunnerRecord>();
  readonly runs = new Map<string, { state: string; machineSeconds: number; settledAt: string }>();
  private readonly locks = new Map<string, Promise<unknown>>();

  async init(): Promise<void> {}
  async get(accountId: string) { const r = this.records.get(accountId); return r ? { ...r } : undefined; }
  async put(record: CloudComputerRecord) { this.records.set(record.accountId, { ...record }); }
  async delete(accountId: string) { this.records.delete(accountId); }
  async list() { return [...this.records.values()].map((r) => ({ ...r })); }
  async sizePreference(accountId: string) { return this.sizes.get(accountId); }
  async setSizePreference(accountId: string, size: string) { this.sizes.set(accountId, size); }
  async getRunner(accountId: string, runnerId: string) { const r = this.runners.get(`${accountId}/${runnerId}`); return r ? { ...r } : undefined; }
  async putRunner(record: RunnerRecord) { this.runners.set(`${record.accountId}/${record.runnerId}`, { ...record }); }
  async deleteRunner(accountId: string, runnerId: string) { this.runners.delete(`${accountId}/${runnerId}`); }
  async listRunners(accountId?: string) { return [...this.runners.values()].filter((r) => !accountId || r.accountId === accountId).map((r) => ({ ...r })); }

  async settle(accountId: string, runId: string, at: string, machineSeconds: number) {
    const key = `${accountId}/${runId}`;
    const seconds = Math.max(0, Math.round(machineSeconds));
    const existing = this.runs.get(key);
    this.runs.set(key, { state: "settled", machineSeconds: Math.max(existing?.machineSeconds ?? 0, seconds), settledAt: at });
  }

  async fail(accountId: string, runId: string, at: string) {
    const key = `${accountId}/${runId}`;
    if (!this.runs.has(key)) this.runs.set(key, { state: "failed", machineSeconds: 0, settledAt: at });
  }

  async usedSeconds(accountId: string, since: string) {
    const from = Date.parse(since);
    let used = 0;
    for (const [key, run] of this.runs) {
      if (key.startsWith(`${accountId}/`) && Date.parse(run.settledAt) >= from) used += run.machineSeconds;
    }
    return used;
  }

  async withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(accountId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.locks.set(accountId, next);
    return next;
  }
}
