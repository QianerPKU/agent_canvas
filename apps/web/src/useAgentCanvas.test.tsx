// @vitest-environment jsdom
import { StrictMode, type PropsWithChildren } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgentCanvas } from "./useAgentCanvas.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  onopen: WebSocket["onopen"] = null;
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;
  onmessage: WebSocket["onmessage"] = null;
  close = vi.fn();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
}

function StrictWrapper({ children }: PropsWithChildren) {
  return <StrictMode>{children}</StrictMode>;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe("useAgentCanvas", () => {
  it("React StrictMode 下只建立一个 WebSocket", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { unmount } = renderHook(() => useAgentCanvas(), {
      wrapper: StrictWrapper,
    });

    expect(FakeWebSocket.instances).toHaveLength(0);
    act(() => vi.runOnlyPendingTimers());
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.url).toBe("ws://localhost:3000/ws");

    unmount();
    expect(FakeWebSocket.instances[0]!.close).toHaveBeenCalledOnce();
  });
});
