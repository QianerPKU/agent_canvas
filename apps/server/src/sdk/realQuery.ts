import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "./types.js";

/**
 * 把真实 SDK 的 `query` 适配成本地 `QueryFn`。
 * 仅在服务运行时引入；单测改用注入的假实现，故不会触达真实模型/鉴权。
 */
export const realQuery: QueryFn = (args) =>
  adaptQuery(
    sdkQuery(
      args as unknown as Parameters<typeof sdkQuery>[0],
    ),
  );

function adaptQuery(handle: ReturnType<typeof sdkQuery>): ReturnType<QueryFn> {
  return {
    [Symbol.asyncIterator]: () => handle,
    interrupt: () => handle.interrupt(),
    terminate: async () => {
      await handle.interrupt().catch(() => undefined);
      await handle.return(undefined).catch(() => undefined);
    },
  };
}
