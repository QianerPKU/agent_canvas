export type BranchReviewStartResult = "started" | "deferred";

export type BranchReviewJobState = "queued" | "active";

export type BranchReviewLeaseResult<T> =
  | { status: "completed"; value: T }
  | { status: "invalidated" };

export interface BranchReviewJob {
  id: string;
  owner: string;
  branch: string;
  order: number;
  /**
   * Persistent, queue-wide FIFO position. This is the authoritative ordering key.
   *
   * Managers that share a queue should reserve this value when a review stage is created and
   * persist it with their flow snapshot. Unlike wall-clock-derived `order`, it cannot move when a
   * deferred stage eventually starts or when the system clock moves backwards. Jobs without a
   * sequence remain supported for backwards compatibility and receive one when they are stored.
   */
  sequence?: number;
  /** Receives a migrated sequence when a legacy restored job did not persist one. */
  onSequenceAssigned?: (sequence: number) => void;
  state?: BranchReviewJobState;
  start: () => BranchReviewStartResult | Promise<BranchReviewStartResult>;
}

interface StoredBranchReviewJob extends BranchReviewJob {
  state: BranchReviewJobState;
  sequence: number;
  legacySequence: boolean;
  deferred: boolean;
  startPending: boolean;
  inFlightLeases: number;
  completionRequested: boolean;
}

interface StartAttempt {
  id: string;
  done: Promise<BranchReviewJobState>;
}

/**
 * Serializes review starts per branch while allowing unrelated branches to run in parallel.
 *
 * A job owns its branch from immediately before `start` is called until `complete` releases it.
 * Returning `deferred` from `start` puts the job back at the head of its branch queue without
 * automatically retrying it, so later jobs cannot skip a temporarily unready older review.
 */
export class BranchReviewQueue {
  private readonly jobs = new Map<string, StoredBranchReviewJob>();
  private readonly activeByBranch = new Map<string, StoredBranchReviewJob>();
  private readonly scheduledBranches = new Set<string>();
  private sequence = 0;
  private authoritativeSequenceFloor = 0;
  private generation = 0;

  /** Reserves the next queue-wide sequence for a job whose ordering must survive persistence. */
  reserveSequence(): number {
    this.freezeLegacySequences();
    if (this.sequence >= Number.MAX_SAFE_INTEGER) {
      throw new Error("branch review sequence exhausted");
    }
    const sequence = ++this.sequence;
    this.authoritativeSequenceFloor = Math.max(this.authoritativeSequenceFloor, sequence);
    return sequence;
  }

  /** Advances the sequence floor while persisted jobs are being restored but not yet activated. */
  observeSequence(sequence: number): void {
    this.assertSequence(sequence, "restored branch review job");
    this.sequence = Math.max(this.sequence, sequence);
    this.authoritativeSequenceFloor = Math.max(this.authoritativeSequenceFloor, sequence);
  }

  async enqueue(job: BranchReviewJob): Promise<BranchReviewJobState> {
    this.assertJob(job);
    if (this.jobs.has(job.id)) throw new Error(`duplicate branch review job: ${job.id}`);

    const stored = this.store(job, "queued");
    const attempt = this.tryStartBranch(stored.branch);
    if (attempt?.id === stored.id) return await attempt.done;
    return stored.state;
  }

  async retry(id: string): Promise<BranchReviewJobState> {
    const job = this.jobs.get(id);
    if (!job) return "queued";
    if (job.state === "active") return "active";

    const head = this.firstQueuedJob(job.branch);
    if (head?.id !== id) return "queued";
    job.deferred = false;

    const attempt = this.tryStartBranch(job.branch);
    if (attempt?.id === id) return await attempt.done;
    return job.state;
  }

  async retryBranch(branch: string): Promise<BranchReviewJobState | undefined> {
    const head = this.firstQueuedJob(branch);
    if (!head) return undefined;
    return await this.retry(head.id);
  }

  async runWhileReserved<T>(
    id: string,
    work: () => T | Promise<T>,
  ): Promise<BranchReviewLeaseResult<T>> {
    const job = this.jobs.get(id);
    if (!job || job.state !== "active" || job.completionRequested) {
      return { status: "invalidated" };
    }

    job.inFlightLeases += 1;
    let value: T | undefined;
    let failure: unknown;
    let failed = false;
    try {
      value = await work();
    } catch (error) {
      failed = true;
      failure = error;
    }

    const invalidated = this.jobs.get(id) !== job || job.completionRequested;
    this.releaseLease(job);
    if (invalidated) return { status: "invalidated" };
    if (failed) throw failure;
    return { status: "completed", value: value as T };
  }

  complete(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;

    job.completionRequested = true;
    if (job.state === "active" && (job.startPending || job.inFlightLeases > 0)) {
      return;
    }
    this.finalize(job);
  }

  release(id: string): void {
    this.complete(id);
  }

  stateOf(id: string): BranchReviewJobState | undefined {
    return this.jobs.get(id)?.state;
  }

  clear(): void {
    this.generation += 1;
    this.scheduledBranches.clear();
    for (const job of [...this.jobs.values()]) this.retire(job);
    this.sequence = 0;
    this.authoritativeSequenceFloor = 0;
  }

  /**
   * Atomically replaces all jobs belonging to one manager/owner.
   *
   * Restored active jobs reserve their branch without calling `start` again. If restored state
   * contains more than one active job for a branch, the first job by order remains active and the
   * rest are demoted to queued. Queued jobs on free branches are started in a following microtask,
   * after all owners have had a chance to restore their reservations.
   */
  replaceOwner(owner: string, jobs: BranchReviewJob[]): Map<string, BranchReviewJobState> {
    if (!owner.trim()) throw new Error("missing branch review owner");
    const replacementIds = new Set<string>();
    for (const job of jobs) {
      this.assertJob(job);
      if (replacementIds.has(job.id)) {
        throw new Error(`duplicate branch review job: ${job.id}`);
      }
      replacementIds.add(job.id);
      if (job.owner !== owner) {
        throw new Error(`branch review job ${job.id} does not belong to owner ${owner}`);
      }
      const existing = this.jobs.get(job.id);
      if (existing && existing.owner !== owner) {
        throw new Error(`duplicate branch review job: ${job.id}`);
      }
    }

    const affectedBranches = new Set<string>();
    for (const current of [...this.jobs.values()]) {
      if (current.owner !== owner) continue;
      affectedBranches.add(current.branch);
      this.retire(current);
    }

    const restored = jobs.map((job) => this.store(job, job.state ?? "queued", true));
    this.normalizeLegacySequences();
    restored.sort(compareJobs);
    for (const job of restored) affectedBranches.add(job.branch);

    // Rebuild active reservations deterministically. Existing owners keep live reservations;
    // conflicting restored jobs remain queued and retain their FIFO position.
    for (const job of restored) {
      if (job.state !== "active") continue;
      if (this.activeByBranch.has(job.branch)) {
        job.state = "queued";
      } else {
        this.activeByBranch.set(job.branch, job);
      }
    }

    for (const branch of affectedBranches) this.scheduleDrain(branch);
    return new Map(restored.map((job) => [job.id, job.state]));
  }

  private tryStartBranch(branch: string): StartAttempt | undefined {
    if (this.activeByBranch.has(branch)) return undefined;
    const job = this.nextQueuedJob(branch);
    if (!job) return undefined;

    // Claim synchronously before invoking user code. Concurrent and re-entrant drains therefore
    // observe the branch as busy and cannot start this or another job twice.
    job.state = "active";
    job.startPending = true;
    this.activeByBranch.set(branch, job);

    let started: BranchReviewStartResult | Promise<BranchReviewStartResult>;
    try {
      started = job.start();
    } catch (error) {
      this.settleStart(job, "deferred");
      const done = Promise.reject<BranchReviewJobState>(error);
      void done.catch(() => undefined);
      return { id: job.id, done };
    }

    const done = Promise.resolve(started).then(
      (result): BranchReviewJobState => {
        if (result !== "started" && result !== "deferred") {
          this.settleStart(job, "deferred");
          throw new Error(`invalid branch review start result for ${job.id}: ${String(result)}`);
        }
        return this.settleStart(job, result);
      },
      (error): never => {
        this.settleStart(job, "deferred");
        throw error;
      },
    );
    // A drain scheduled by complete/replaceOwner has no direct caller. Attach a handler now so a
    // rejected start never becomes an unhandled rejection; enqueue/retry still observe rejection.
    void done.catch(() => undefined);
    return { id: job.id, done };
  }

  private settleStart(
    job: StoredBranchReviewJob,
    result: BranchReviewStartResult,
  ): BranchReviewJobState {
    job.startPending = false;
    if (job.completionRequested) {
      if (job.inFlightLeases === 0) this.finalize(job);
      return result === "started" ? "active" : "queued";
    }
    if (this.jobs.get(job.id) !== job) {
      this.finalize(job);
      return result === "started" ? "active" : "queued";
    }
    if (result === "deferred") {
      job.state = "queued";
      job.deferred = true;
      if (this.activeByBranch.get(job.branch) === job) {
        this.activeByBranch.delete(job.branch);
      }
      // Deliberately do not drain here. This deferred head must continue blocking later jobs until
      // an explicit retry, completion, replacement, or a later enqueue asks the branch to drain.
      return "queued";
    }
    return "active";
  }

  private releaseLease(job: StoredBranchReviewJob): void {
    job.inFlightLeases = Math.max(0, job.inFlightLeases - 1);
    if (job.completionRequested && !job.startPending && job.inFlightLeases === 0) {
      this.finalize(job);
    }
  }

  private finalize(job: StoredBranchReviewJob): void {
    if (this.jobs.get(job.id) === job) this.jobs.delete(job.id);
    if (this.activeByBranch.get(job.branch) === job) {
      this.activeByBranch.delete(job.branch);
    }
    this.scheduleDrain(job.branch);
  }

  private retire(job: StoredBranchReviewJob): void {
    if (this.jobs.get(job.id) === job) this.jobs.delete(job.id);
    job.completionRequested = true;
    if (job.state === "active" && (job.startPending || job.inFlightLeases > 0)) return;
    this.finalize(job);
  }

  private nextQueuedJob(branch: string): StoredBranchReviewJob | undefined {
    const next = this.firstQueuedJob(branch);
    return next?.deferred ? undefined : next;
  }

  private firstQueuedJob(branch: string): StoredBranchReviewJob | undefined {
    let next: StoredBranchReviewJob | undefined;
    for (const job of this.jobs.values()) {
      if (job.branch !== branch || job.state !== "queued") continue;
      if (!next || compareJobs(job, next) < 0) next = job;
    }
    return next;
  }

  private scheduleDrain(branch: string): void {
    if (this.scheduledBranches.has(branch)) return;
    this.scheduledBranches.add(branch);
    const generation = this.generation;
    queueMicrotask(() => {
      if (generation !== this.generation) return;
      this.scheduledBranches.delete(branch);
      const attempt = this.tryStartBranch(branch);
      if (attempt) void attempt.done.catch(() => undefined);
    });
  }

  private store(
    job: BranchReviewJob,
    state: BranchReviewJobState,
    restoring = false,
  ): StoredBranchReviewJob {
    const legacySequence = restoring && job.sequence === undefined;
    const sequence = job.sequence ?? (legacySequence ? 1 : this.reserveSequence());
    if (!legacySequence) this.observeSequence(sequence);
    const stored: StoredBranchReviewJob = {
      ...job,
      state,
      sequence,
      legacySequence,
      deferred: false,
      startPending: false,
      inFlightLeases: 0,
      completionRequested: false,
    };
    this.jobs.set(stored.id, stored);
    return stored;
  }

  private normalizeLegacySequences(): void {
    const legacyJobs = [...this.jobs.values()]
      .filter((job) => job.legacySequence)
      .sort(compareLegacyJobs);
    if (Number.MAX_SAFE_INTEGER - this.authoritativeSequenceFloor < legacyJobs.length) {
      throw new Error("branch review sequence exhausted");
    }
    let sequence = this.authoritativeSequenceFloor;
    for (const job of legacyJobs) {
      sequence += 1;
      job.sequence = sequence;
      job.onSequenceAssigned?.(sequence);
    }
    this.sequence = Math.max(this.sequence, sequence);
  }

  private freezeLegacySequences(): void {
    for (const job of this.jobs.values()) {
      if (!job.legacySequence) continue;
      job.legacySequence = false;
      this.authoritativeSequenceFloor = Math.max(
        this.authoritativeSequenceFloor,
        job.sequence,
      );
    }
  }

  private assertJob(job: BranchReviewJob): void {
    if (!job.id.trim()) throw new Error("missing branch review job id");
    if (!job.owner.trim()) throw new Error(`missing branch review owner for ${job.id}`);
    if (!job.branch.trim()) throw new Error(`missing branch for review job ${job.id}`);
    if (!Number.isFinite(job.order)) throw new Error(`invalid order for review job ${job.id}`);
    if (job.sequence !== undefined) this.assertSequence(job.sequence, `review job ${job.id}`);
    if (job.onSequenceAssigned !== undefined && typeof job.onSequenceAssigned !== "function") {
      throw new Error(`invalid sequence callback for review job ${job.id}`);
    }
    if (typeof job.start !== "function") throw new Error(`missing start callback for ${job.id}`);
  }

  private assertSequence(sequence: number, description: string): void {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      throw new Error(`invalid sequence for ${description}`);
    }
  }
}

function compareJobs(a: StoredBranchReviewJob, b: StoredBranchReviewJob): number {
  return a.sequence - b.sequence || a.order - b.order || compareJobIds(a.id, b.id);
}

function compareLegacyJobs(a: StoredBranchReviewJob, b: StoredBranchReviewJob): number {
  return a.order - b.order || compareJobIds(a.id, b.id);
}

function compareJobIds(a: string, b: string): number {
  const parsedA = parseGeneratedJobId(a);
  const parsedB = parseGeneratedJobId(b);
  if (parsedA && parsedB && parsedA.prefix === parsedB.prefix) {
    const numeric = compareDecimalStrings(parsedA.numericId, parsedB.numericId);
    if (numeric !== 0) return numeric;
    const suffix = compareStrings(parsedA.suffix, parsedB.suffix);
    if (suffix !== 0) return suffix;
  }
  return compareStrings(a, b);
}

function parseGeneratedJobId(
  id: string,
): { prefix: string; numericId: string; suffix: string } | undefined {
  const match = /^(pull_request:pr_flow_|sync:sync_flow_)(\d+)(:.*)?$/u.exec(id);
  if (!match) return undefined;
  return { prefix: match[1]!, numericId: match[2]!, suffix: match[3] ?? "" };
}

function compareDecimalStrings(a: string, b: string): number {
  const normalizedA = a.replace(/^0+(?=\d)/u, "");
  const normalizedB = b.replace(/^0+(?=\d)/u, "");
  return (
    normalizedA.length - normalizedB.length ||
    compareStrings(normalizedA, normalizedB) ||
    compareStrings(a, b)
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
