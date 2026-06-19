/**
 * 一个可动态 push、可关闭的异步消息队列，实现 AsyncIterable。
 *
 * 用途：作为 Agent SDK 流式输入（streaming input）的 prompt 源。
 * 启动时先 push 首条用户消息；运行中可继续 push（即"中途追加指令/干预"）；
 * stop 时 close()，迭代随之结束。
 */
export class AsyncMessageQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  /** 入队一条消息；已关闭则忽略。 */
  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  /** 关闭队列：已缓冲的消息仍会被取走，之后迭代结束。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    let waiter: ((r: IteratorResult<T>) => void) | undefined;
    while ((waiter = this.waiters.shift())) {
      waiter({ value: undefined as unknown as T, done: true });
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const buffered = this.buffer.shift();
        if (buffered !== undefined) {
          return Promise.resolve({ value: buffered, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: undefined as unknown as T, done: true });
      },
    };
  }
}
