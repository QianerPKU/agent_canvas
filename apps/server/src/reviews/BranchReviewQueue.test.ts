import { describe, expect, it } from "vitest";
import {
  BranchReviewQueue,
  type BranchReviewJob,
  type BranchReviewStartResult,
} from "./BranchReviewQueue.js";

describe("BranchReviewQueue", () => {
  it("starts one same-branch job at a time in FIFO order", async () => {
    const queue = new BranchReviewQueue();
    const firstStart = deferred<BranchReviewStartResult>();
    const starts: string[] = [];

    const first = queue.enqueue(
      job("first", "main", 1, () => {
        starts.push("first");
        return firstStart.promise;
      }),
    );
    const second = queue.enqueue(
      job("second", "main", 2, () => {
        starts.push("second");
        return "started";
      }),
    );

    expect(starts).toEqual(["first"]);
    expect(queue.stateOf("first")).toBe("active");
    await expect(second).resolves.toBe("queued");

    firstStart.resolve("started");
    await expect(first).resolves.toBe("active");
    queue.complete("first");
    await flushMicrotasks();

    expect(starts).toEqual(["first", "second"]);
    expect(queue.stateOf("second")).toBe("active");
  });

  it("starts different branches in parallel", async () => {
    const queue = new BranchReviewQueue();
    const mainStart = deferred<BranchReviewStartResult>();
    const releaseStart = deferred<BranchReviewStartResult>();
    const starts: string[] = [];

    const main = queue.enqueue(
      job("main-review", "main", 1, () => {
        starts.push("main");
        return mainStart.promise;
      }),
    );
    const release = queue.enqueue(
      job("release-review", "release", 2, () => {
        starts.push("release");
        return releaseStart.promise;
      }),
    );

    expect(starts).toEqual(["main", "release"]);
    expect(queue.stateOf("main-review")).toBe("active");
    expect(queue.stateOf("release-review")).toBe("active");

    mainStart.resolve("started");
    releaseStart.resolve("started");
    await expect(Promise.all([main, release])).resolves.toEqual(["active", "active"]);
  });

  it("does not release a completed reservation until its pending start settles", async () => {
    const queue = new BranchReviewQueue();
    const firstStart = deferred<BranchReviewStartResult>();
    const starts: string[] = [];

    const first = queue.enqueue(
      job("first", "main", 1, () => {
        starts.push("first");
        return firstStart.promise;
      }),
    );
    await expect(
      queue.enqueue(
        job("second", "main", 2, () => {
          starts.push("second");
          return "started";
        }),
      ),
    ).resolves.toBe("queued");

    queue.complete("first");
    await flushMicrotasks();
    expect(queue.stateOf("first")).toBe("active");
    expect(starts).toEqual(["first"]);

    firstStart.resolve("started");
    await expect(first).resolves.toBe("active");
    await flushMicrotasks();

    expect(queue.stateOf("first")).toBeUndefined();
    expect(queue.stateOf("second")).toBe("active");
    expect(starts).toEqual(["first", "second"]);
  });

  it("invalidates an in-flight lease and holds the branch until its work settles", async () => {
    const queue = new BranchReviewQueue();
    const delivery = deferred<void>();
    const starts: string[] = [];

    await queue.enqueue(job("first", "main", 1, () => "started"));
    const leased = queue.runWhileReserved("first", async () => {
      starts.push("delivery");
      await delivery.promise;
    });
    await expect(
      queue.enqueue(
        job("second", "main", 2, () => {
          starts.push("second");
          return "started";
        }),
      ),
    ).resolves.toBe("queued");

    queue.complete("first");
    await flushMicrotasks();
    expect(starts).toEqual(["delivery"]);

    delivery.resolve(undefined);
    await expect(leased).resolves.toEqual({ status: "invalidated" });
    await flushMicrotasks();

    expect(starts).toEqual(["delivery", "second"]);
    expect(queue.stateOf("second")).toBe("active");
  });

  it("keeps a cleared branch reserved until its retired delivery lease settles", async () => {
    const queue = new BranchReviewQueue();
    const delivery = deferred<void>();
    const starts: string[] = [];

    await queue.enqueue(job("old-project", "main", 1, () => "started"));
    const leased = queue.runWhileReserved("old-project", async () => {
      starts.push("old-delivery");
      await delivery.promise;
    });
    queue.clear();

    await expect(
      queue.enqueue(
        job("new-project", "main", 1, () => {
          starts.push("new-review");
          return "started";
        }),
      ),
    ).resolves.toBe("queued");
    await flushMicrotasks();
    expect(starts).toEqual(["old-delivery"]);

    delivery.resolve(undefined);
    await expect(leased).resolves.toEqual({ status: "invalidated" });
    await flushMicrotasks();

    expect(starts).toEqual(["old-delivery", "new-review"]);
    expect(queue.stateOf("new-project")).toBe("active");
  });

  it("lets a replacement reuse an id only after the retired start settles", async () => {
    const queue = new BranchReviewQueue();
    const oldStart = deferred<BranchReviewStartResult>();
    const starts: string[] = [];

    const oldEnqueue = queue.enqueue(
      job("same-id", "main", 1, () => {
        starts.push("old-start");
        return oldStart.promise;
      }),
    );
    const restored = queue.replaceOwner("test", [
      job("same-id", "main", 1, () => {
        starts.push("new-start");
        return "started";
      }),
    ]);

    expect(restored.get("same-id")).toBe("queued");
    await flushMicrotasks();
    expect(starts).toEqual(["old-start"]);

    oldStart.resolve("started");
    await expect(oldEnqueue).resolves.toBe("active");
    await flushMicrotasks();

    expect(starts).toEqual(["old-start", "new-start"]);
    expect(queue.stateOf("same-id")).toBe("active");
  });

  it("keeps a deferred head queued and prevents later jobs from skipping it", async () => {
    const queue = new BranchReviewQueue();
    let ready = false;
    let firstAttempts = 0;
    let secondStarts = 0;

    await expect(
      queue.enqueue(
        job("first", "main", 1, () => {
          firstAttempts += 1;
          return ready ? "started" : "deferred";
        }),
      ),
    ).resolves.toBe("queued");

    await expect(
      queue.enqueue(
        job("second", "main", 2, () => {
          secondStarts += 1;
          return "started";
        }),
      ),
    ).resolves.toBe("queued");
    expect(firstAttempts).toBe(1);
    expect(secondStarts).toBe(0);
    expect(queue.stateOf("first")).toBe("queued");

    ready = true;
    await expect(queue.retry("first")).resolves.toBe("active");
    expect(firstAttempts).toBe(2);
    expect(secondStarts).toBe(0);

    queue.release("first");
    await flushMicrotasks();
    expect(secondStarts).toBe(1);
    expect(queue.stateOf("second")).toBe("active");
  });

  it("claims before calling start and tolerates re-entrant enqueue and retry", async () => {
    const queue = new BranchReviewQueue();
    const starts: string[] = [];

    const firstState = await queue.enqueue(
      job("first", "main", 1, async (): Promise<BranchReviewStartResult> => {
        starts.push("first");
        expect(queue.stateOf("first")).toBe("active");
        await expect(
          queue.enqueue(
            job("second", "main", 2, () => {
              starts.push("second");
              return "started";
            }),
          ),
        ).resolves.toBe("queued");
        await expect(queue.retry("second")).resolves.toBe("queued");
        return "started";
      }),
    );

    expect(firstState).toBe("active");
    expect(starts).toEqual(["first"]);
    queue.complete("first");
    queue.complete("first");
    queue.release("first");
    await flushMicrotasks();

    expect(starts).toEqual(["first", "second"]);
  });

  it("coalesces concurrent retries so a deferred job starts only once", async () => {
    const queue = new BranchReviewQueue();
    const retryStart = deferred<BranchReviewStartResult>();
    let attempts = 0;

    await queue.enqueue(
      job("review", "main", 1, () => {
        attempts += 1;
        return attempts === 1 ? "deferred" : retryStart.promise;
      }),
    );

    const firstRetry = queue.retry("review");
    const concurrentRetry = queue.retry("review");
    expect(attempts).toBe(2);
    await expect(concurrentRetry).resolves.toBe("active");

    retryStart.resolve("started");
    await expect(firstRetry).resolves.toBe("active");
    expect(attempts).toBe(2);
  });

  it("restores owners atomically and drains free branches in a microtask", async () => {
    const queue = new BranchReviewQueue();
    const starts: string[] = [];

    queue.replaceOwner("pull_request", [
      job("pr-active", "main", 1, () => {
        starts.push("restored-active");
        return "started";
      }, "active", "pull_request"),
      job("pr-release", "release", 2, () => {
        starts.push("release");
        return "started";
      }, "queued", "pull_request"),
    ]);
    queue.replaceOwner("sync", [
      job("sync-main", "main", 3, () => {
        starts.push("sync-main");
        return "started";
      }, "queued", "sync"),
    ]);

    expect(starts).toEqual([]);
    expect(queue.stateOf("pr-active")).toBe("active");
    expect(queue.stateOf("sync-main")).toBe("queued");
    await flushMicrotasks();

    expect(starts).toEqual(["release"]);
    expect(queue.stateOf("pr-release")).toBe("active");
    expect(queue.stateOf("sync-main")).toBe("queued");

    queue.replaceOwner("pull_request", []);
    await flushMicrotasks();
    expect(starts).toEqual(["release", "sync-main"]);
    expect(queue.stateOf("sync-main")).toBe("active");
  });

  it("lets a later owner restore an active reservation before queued restore drain runs", async () => {
    const queue = new BranchReviewQueue();
    let queuedStarts = 0;

    queue.replaceOwner("pull_request", [
      job("pr-queued", "main", 1, () => {
        queuedStarts += 1;
        return "started";
      }, "queued", "pull_request"),
    ]);
    queue.replaceOwner("sync", [
      job("sync-active", "main", 2, () => "started", "active", "sync"),
    ]);
    await flushMicrotasks();

    expect(queuedStarts).toBe(0);
    expect(queue.stateOf("sync-active")).toBe("active");
    expect(queue.stateOf("pr-queued")).toBe("queued");
  });

  it("clears all reservations and invalidates already scheduled restore drains", async () => {
    const queue = new BranchReviewQueue();
    let starts = 0;

    queue.replaceOwner("pull_request", [
      job("queued", "main", 1, () => {
        starts += 1;
        return "started";
      }, "queued", "pull_request"),
      job("active", "release", 2, () => "started", "active", "pull_request"),
    ]);
    queue.clear();
    await flushMicrotasks();

    expect(starts).toBe(0);
    expect(queue.stateOf("queued")).toBeUndefined();
    expect(queue.stateOf("active")).toBeUndefined();
    expect(queue.release("active")).toBeUndefined();
  });

  it("requeues a job whose start throws and leaves later jobs blocked", async () => {
    const queue = new BranchReviewQueue();
    const failure = new Error("not ready");
    let laterStarts = 0;

    await expect(
      queue.enqueue(job("failing", "main", 1, () => { throw failure; })),
    ).rejects.toBe(failure);
    await expect(
      queue.enqueue(
        job("later", "main", 2, () => {
          laterStarts += 1;
          return "started";
        }),
      ),
    ).resolves.toBe("queued");

    expect(queue.stateOf("failing")).toBe("queued");
    expect(laterStarts).toBe(0);
  });
});

function job(
  id: string,
  branch: string,
  order: number,
  start: BranchReviewJob["start"],
  state?: BranchReviewJob["state"],
  owner = "test",
): BranchReviewJob {
  return { id, owner, branch, order, state, start };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
