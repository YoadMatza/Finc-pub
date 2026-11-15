/**
 * The host-run guard (security research P1-13). Before any CLI command: when the owner file next to the database was
 * written by another host (the Docker worker) and that owner is either fresh or its control port answers, refuse.
 * The port check needs no clock: WSL2's clock can lag the Windows clock by minutes after sleep, which makes a live
 * worker's heartbeat look stale from the host. Launcher runs inside the container share the worker's hostname and pass.
 */
import { type DbOwner, DbOwnedError, OWNER_STALE_MS } from '@finc/core';

export type GuardVerdict = { allow: true } | { allow: false; message: string };

export async function guardHostRun(owner: DbOwner | null, hostname: string, ageMs: number, workerUp: () => Promise<boolean>): Promise<GuardVerdict> {
  if (!owner || owner.host === hostname) return { allow: true };
  if ((!owner.released && ageMs < OWNER_STALE_MS) || (await workerUp())) return { allow: false, message: new DbOwnedError(owner, ageMs).message };
  return { allow: true };
}

/**
 * The worker's own start-up probe: does another host's worker still answer on the control port? Only asked when the
 * owner file names another host, so a worker never probes itself (its port is not listening yet anyway). A fresh
 * foreign owner is left to claimDb, which waits for it to go stale; this catches the one whose heartbeat only looks
 * stale (a lagging clock) while it is alive.
 */
export async function otherWorkerAnswers(owner: DbOwner | null, hostname: string, workerUp: () => Promise<boolean>): Promise<boolean> {
  if (!owner || owner.host === hostname) return false;
  return workerUp();
}
