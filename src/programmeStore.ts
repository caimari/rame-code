/**
 * The host's record of programmes (see `programmeRecord.ts`), kept in the
 * same storage as Missions so it survives a reload. Every change goes
 * through `update`, one at a time, re-reading the stored state first.
 */

import type { ProgrammePhaseLease, ProgrammeRecord } from './programmeRecord.js';

export const PROGRAMME_STATE_KEY = 'rame.programmes.v1';
const MAX_STORED_PROGRAMMES = 20;
export const PROGRAMME_LEASE_MS = 15_000;

export type ProgrammeResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ProgrammeBackend {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
  exclusive?<T>(work: () => Promise<T>): Promise<T>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A stored programme; `null` when damaged (it is then ignored, never repaired by guessing). */
function parseProgramme(raw: unknown): ProgrammeRecord | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !/^prg_[a-z0-9]{24}$/.test(raw.id) || typeof raw.scopeId !== 'string' || typeof raw.root !== 'string') {
    return null;
  }
  if (!Array.isArray(raw.phases) || !isRecord(raw.check) || !['active', 'completed', 'stopped'].includes(String(raw.status)) || !Number.isInteger(raw.revision)) {
    return null;
  }
  const record = structuredClone(raw) as unknown as ProgrammeRecord;
  record.lease = validLease(raw.lease) ? structuredClone(raw.lease) : null;
  record.nextFence = Number.isSafeInteger(raw.nextFence) && (raw.nextFence as number) >= 0 ? raw.nextFence as number : record.lease?.fence ?? 0;
  return record;
}

function validLease(raw: unknown): raw is ProgrammePhaseLease {
  return isRecord(raw) && Number.isInteger(raw.phaseIndex) && (raw.phaseIndex as number) >= 0 && typeof raw.owner === 'string' && raw.owner.length >= 8 && raw.owner.length <= 128 && Number.isSafeInteger(raw.fence) && (raw.fence as number) > 0 && typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt);
}

export class ProgrammeStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly backend: ProgrammeBackend) {}

  list(): ProgrammeRecord[] {
    const raw = this.backend.get(PROGRAMME_STATE_KEY) as { programmes?: unknown } | undefined;
    return (Array.isArray(raw?.programmes) ? raw.programmes : []).map(parseProgramme).filter((entry): entry is ProgrammeRecord => entry !== null);
  }

  get(id: string): ProgrammeRecord | null {
    return this.list().find((entry) => entry.id === id) ?? null;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = () => this.backend.exclusive ? this.backend.exclusive(work) : work();
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async save(programmes: ProgrammeRecord[]): Promise<void> {
    await this.backend.update(PROGRAMME_STATE_KEY, { version: 1, programmes });
  }

  create(record: ProgrammeRecord): Promise<ProgrammeResult<ProgrammeRecord>> {
    return this.serial(async () => {
      const kept = [...this.list(), structuredClone(record)];
      while (kept.length > MAX_STORED_PROGRAMMES) {
        const oldest = kept.findIndex((entry) => entry.status !== 'active');
        if (oldest < 0) {
          return { ok: false, error: `At most ${MAX_STORED_PROGRAMMES} programmes are kept; finish or stop one first.` };
        }
        kept.splice(oldest, 1);
      }
      await this.save(kept);
      return { ok: true, value: structuredClone(record) };
    });
  }

  update(id: string, mutate: (draft: ProgrammeRecord) => ProgrammeResult<ProgrammeRecord>, expectedRevision?: number): Promise<ProgrammeResult<ProgrammeRecord>> {
    return this.serial(async () => {
      const all = this.list();
      const index = all.findIndex((entry) => entry.id === id);
      if (index < 0) {
        return { ok: false, error: 'RAME Code has no record of this programme.' };
      }
      if (expectedRevision !== undefined && (all[index] as ProgrammeRecord).revision !== expectedRevision) {
        return { ok: false, error: 'This programme changed in another VS Code window; review it before acting again.' };
      }
      const result = mutate(structuredClone(all[index] as ProgrammeRecord));
      if (!result.ok) {
        return result;
      }
      result.value.revision += 1;
      result.value.updatedAt = Date.now();
      all[index] = result.value;
      await this.save(all);
      return { ok: true, value: structuredClone(result.value) };
    });
  }

  /** Acquire or renew the one phase-wide lease under the machine-wide lock. */
  acquirePhase(id: string, phaseIndex: number, owner: string, now = Date.now(), ttlMs = PROGRAMME_LEASE_MS): Promise<ProgrammeResult<{ programme: ProgrammeRecord; lease: ProgrammePhaseLease }>> {
    return this.serial(async () => {
      const all = this.list();
      const index = all.findIndex((entry) => entry.id === id);
      if (index < 0) return { ok: false, error: 'RAME Code has no record of this programme.' };
      const draft = structuredClone(all[index] as ProgrammeRecord);
      const held = draft.lease;
      if (held !== null && held.expiresAt > now && (held.owner !== owner || held.phaseIndex !== phaseIndex)) {
        return { ok: false, error: `Phase ${held.phaseIndex + 1} is being directed by another live RAME Code window until ${new Date(held.expiresAt).toISOString()}.` };
      }
      const lease = held !== null && held.owner === owner && held.phaseIndex === phaseIndex && held.expiresAt > now
        ? { ...held, expiresAt: now + ttlMs }
        : { phaseIndex, owner, fence: draft.nextFence + 1, expiresAt: now + ttlMs };
      draft.nextFence = Math.max(draft.nextFence, lease.fence);
      draft.lease = lease;
      draft.revision += 1;
      draft.updatedAt = now;
      all[index] = draft;
      await this.save(all);
      return { ok: true, value: { programme: structuredClone(draft), lease: structuredClone(lease) } };
    });
  }

  renewPhase(id: string, lease: ProgrammePhaseLease, now = Date.now(), ttlMs = PROGRAMME_LEASE_MS): Promise<ProgrammeResult<ProgrammePhaseLease>> {
    return this.serial(async () => {
      const all = this.list();
      const index = all.findIndex((entry) => entry.id === id);
      if (index < 0) return { ok: false, error: 'RAME Code has no record of this programme.' };
      const draft = structuredClone(all[index] as ProgrammeRecord);
      if (!sameLease(draft.lease, lease) || (draft.lease?.expiresAt ?? 0) <= now) {
        return { ok: false, error: 'This window no longer owns the Programme phase; its late result was rejected.' };
      }
      const renewed = { ...draft.lease, expiresAt: now + ttlMs } as ProgrammePhaseLease;
      draft.lease = renewed;
      draft.revision += 1;
      draft.updatedAt = now;
      all[index] = draft;
      await this.save(all);
      return { ok: true, value: structuredClone(renewed) };
    });
  }

  updateLeased(id: string, lease: ProgrammePhaseLease, mutate: (draft: ProgrammeRecord) => ProgrammeResult<ProgrammeRecord>, now = Date.now()): Promise<ProgrammeResult<ProgrammeRecord>> {
    return this.serial(async () => {
      const all = this.list();
      const index = all.findIndex((entry) => entry.id === id);
      if (index < 0) return { ok: false, error: 'RAME Code has no record of this programme.' };
      const current = all[index] as ProgrammeRecord;
      if (!sameLease(current.lease, lease) || (current.lease?.expiresAt ?? 0) <= now) {
        return { ok: false, error: 'This window no longer owns the Programme phase; its late result was rejected.' };
      }
      const result = mutate(structuredClone(current));
      if (!result.ok) return result;
      result.value.lease = structuredClone(current.lease);
      result.value.nextFence = Math.max(result.value.nextFence, current.nextFence);
      result.value.revision += 1;
      result.value.updatedAt = now;
      all[index] = result.value;
      await this.save(all);
      return { ok: true, value: structuredClone(result.value) };
    });
  }

  releasePhase(id: string, lease: ProgrammePhaseLease, now = Date.now()): Promise<ProgrammeResult<ProgrammeRecord>> {
    return this.serial(async () => {
      const all = this.list();
      const index = all.findIndex((entry) => entry.id === id);
      if (index < 0) return { ok: false, error: 'RAME Code has no record of this programme.' };
      const draft = structuredClone(all[index] as ProgrammeRecord);
      if (!sameLease(draft.lease, lease)) {
        return { ok: false, error: 'This window no longer owns the Programme phase; its old lease cannot release the current owner.' };
      }
      draft.lease = null;
      draft.revision += 1;
      draft.updatedAt = now;
      all[index] = draft;
      await this.save(all);
      return { ok: true, value: structuredClone(draft) };
    });
  }
}

const sameLease = (current: ProgrammePhaseLease | null, expected: ProgrammePhaseLease): boolean => current !== null && current.owner === expected.owner && current.phaseIndex === expected.phaseIndex && current.fence === expected.fence;
