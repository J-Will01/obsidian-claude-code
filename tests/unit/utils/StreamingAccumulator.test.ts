import { describe, it, expect } from "vitest";
import { StreamingAccumulator } from "@/utils/StreamingAccumulator";

describe("StreamingAccumulator", () => {
  it("accumulates text deltas", () => {
    const accumulator = new StreamingAccumulator(0);
    const messageId = "msg-1";

    const update1 = accumulator.updateFromStreamEvent(messageId, {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Hello" },
    }, 1000);
    const update2 = accumulator.updateFromStreamEvent(messageId, {
      type: "content_block_delta",
      delta: { type: "text_delta", text: " world" },
    }, 1100);

    expect(update1?.content).toBe("Hello");
    expect(update2?.content).toBe("Hello world");
  });

  it("throttles updates", () => {
    const accumulator = new StreamingAccumulator(100);
    const messageId = "msg-2";

    const update1 = accumulator.updateFromStreamEvent(messageId, {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Hi" },
    }, 1000);
    const update2 = accumulator.updateFromStreamEvent(messageId, {
      type: "content_block_delta",
      delta: { type: "text_delta", text: " there" },
    }, 1050);
    const update3 = accumulator.updateFromStreamEvent(messageId, {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "!" },
    }, 1200);

    expect(update1).not.toBeNull();
    expect(update2).toBeNull();
    expect(update3?.content).toBe("Hi there!");
  });

  it("finalizes content", () => {
    const accumulator = new StreamingAccumulator(0);
    const messageId = "msg-3";
    accumulator.updateFromStreamEvent(messageId, {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Draft" },
    }, 1000);

    const final = accumulator.finalize(messageId, "Final", [], 1500);
    expect(final.content).toBe("Final");
    expect(final.isStreaming).toBe(false);
  });
});
