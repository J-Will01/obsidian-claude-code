import { describe, expect, it } from "vitest";
import { mergeStreamingText } from "../../../src/utils/streamingText";

describe("mergeStreamingText", () => {
  it("should keep previous text when incoming is empty", () => {
    expect(mergeStreamingText("Initial response", "")).toBe("Initial response");
  });

  it("should append non-overlapping text with spacing", () => {
    expect(mergeStreamingText("Initial response", "Follow-up after tool call"))
      .toBe("Initial response\n\nFollow-up after tool call");
  });

  it("should merge overlapping suffix/prefix boundaries", () => {
    expect(mergeStreamingText("Hello world", "world and beyond")).toBe("Hello world and beyond");
  });

  it("should prefer richer cumulative incoming text", () => {
    expect(mergeStreamingText("Hello", "Hello world")).toBe("Hello world");
  });

  it("should keep richer previous text if incoming regresses", () => {
    expect(mergeStreamingText("Hello world", "Hello")).toBe("Hello world");
  });
});
