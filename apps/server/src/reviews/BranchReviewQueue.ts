export type BranchReviewStartResult = "started" | "deferred";

export type BranchReviewJobState = "queued" | "active";

export interface BranchReviewJob {
  id: string;
  owner: string;
  branch: string;
  order: number;
  state?: BranchReviewJobState;
  start: () => BranchReviewStartResult | Promise<BranchReviewStartResult>;
}

interface StoredBranchReviewJob extends BranchReviewJob {
  state: BranchReviewJobState;
  sequence: number;
  deferred: boolean;
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
  private readonly activeByBranch = new Map<string, string>();
  private readonly scheduledBranches = new Set<string>();
  private sequence = 0;
  private generation = 0;

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

  complete(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;

    this.jobs.delete(id);
    if (this.activeByBranch.get(job.branch) === id) {
      this.activeByBranch.delete(job.branch);
    }
    this.scheduleDrain(job.branch);
  }

  release(id: string): void {
    this.complete(id);
  }

  stateOf(id: string): BranchReviewJobState | undefined {
    return this.jobs.get(id)?.state;
  }

  clear(): void {
    this.generation += 1;
    this.jobs.clear();
    this.activeByBranch.clear();
    this.scheduledBranches.clear();
    this.sequence = 0;
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
      this.jobs.delete(current.id);
      if (this.activeByBranch.get(current.branch) === current.id) {
        this.activeByBranch.delete(current.branch);
      }
    }

    const restored = jobs
      .map((job) => this.store(job, job.state ?? "queued"))
      .sort(compareJobs);
    for (const job of restored) affectedBranches.add(job.branch);

    // Rebuild active reservations deterministically. Existing owners keep live reservations;
    // conflicting restored jobs remain queued and retain their FIFO position.
    for (const job of restored) {
      if (job.state !== "active") continue;
      if (this.activeByBranch.has(job.branch)) {
        job.state = "queued";
      } else {
        this.activeByBranch.set(job.branch, job.id);
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
    this.activeByBranch.set(branch, job.id);

    let started: BranchReviewStartResult | Promise<BranchReviewStartResult>;
    try {
      started = job.start();
    } catch (error) {
      this.deferAfterStartFailure(job);
      const done = Promise.reject<BranchReviewJobState>(error);
      void done.catch(() => undefined);
      return { id: job.id, done };
    }

    const done = Promise.resolve(started).then(
      (result): BranchReviewJobState => {
        if (result !== "started" && result !== "deferred") {
          this.deferAfterStartFailure(job);
          throw new Error(`invalid branch review start result for ${job.id}: ${String(result)}`);
        }
        const current = this.jobs.get(job.id);
        if (current !== job) return result === "started" ? "active" : "queued";
        if (result === "deferred") {
          this.deferAfterStartFailure(job);
          return "queued";
        }
        return "active";
      },
      (error): never => {
        this.deferAfterStartFailure(job);
        throw error;
      },
    );
    // A drain scheduled by complete/replaceOwner has no direct caller. Attach a handler now so a
    // rejected start never becomes an unhandled rejection; enqueue/retry still observe rejection.
    void done.catch(() => undefined);
    return { id: job.id, done };
  }

  private deferAfterStartFailure(job: StoredBranchReviewJob): void {
    if (this.jobs.get(job.id) !== job) return;
    job.state = "queued";
    job.deferred = true;
    if (this.activeByBranch.get(job.branch) === job.id) {
      this.activeByBranch.delete(job.branch);
    }
    // Deliberately do not drain here. This deferred head must continue blocking later jobs until
    // an explicit retry, completion, replacement, or a later enqueue asks the branch to drain.
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

  private store(job: BranchReviewJob, state: BranchReviewJobState): StoredBranchReviewJob {
    const stored: StoredBranchReviewJob = {
      ...job,
      state,
      sequence: ++this.sequence,
      deferred: false,
    };
    this.jobs.set(stored.id, stored);
    return stored;
  }

  private assertJob(job: BranchReviewJob): void {
    if (!job.id.trim()) throw new Error("missing branch review job id");
    if (!job.owner.trim()) throw new Error(`missing branch review owner for ${job.id}`);
    if (!job.branch.trim()) throw new Error(`missing branch for review job ${job.id}`);
    if (!Number.isFinite(job.order)) throw new Error(`invalid order for review job ${job.id}`);
    if (typeof job.start !== "function") throw new Error(`missing start callback for ${job.id}`);
  }
}

function compareJobs(a: StoredBranchReviewJob, b: StoredBranchReviewJob): number {
  return a.order - b.order || a.sequence - b.sequence;
}
