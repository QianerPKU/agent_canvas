import { describe, it, expect } from "vitest";
import { AsyncMessageQueue } from "./AsyncMessageQueue.js";

describe("AsyncMessageQueue", () => {
  it("先 push 后迭代：按序取出", async () => {
    const q = new AsyncMessageQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    const got: number[] = [];
    for await (const n of q) got.push(n);
    expect(got).toEqual([1, 2]);
  });

  it("先等待后 push：唤醒等待者", async () => {
    const q = new AsyncMessageQueue<string>();
    const it = q[Symbol.asyncIterator]();
    const pending = it.next();
    q.push("hello");
    expect(await pending).toEqual({ value: "hello", done: false });
  });

  it("close 后 push 被忽略", async () => {
    const q = new AsyncMessageQueue<number>();
    q.close();
    q.push(99);
    const it = q[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: undefined, done: true });
    expect(q.isClosed).toBe(true);
  });

  it("缓冲未取完即 close：剩余仍可取出，之后结束", async () => {
    const q = new AsyncMessageQueue<number>();
    q.push(1);
    q.close();
    const it = q[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: 1, done: false });
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });
});
