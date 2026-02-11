import { describe, it, expect } from "vitest";
import { computeContextUsageEstimate, estimateTokensFromChars } from "../../../src/utils/contextUsage";

describe("contextUsage", () => {
  it("should prefer latest turn context tokens when available", () => {
    const estimate = computeContextUsageEstimate({
      contextWindow: 200000,
      metadata: {
        totalTokens: 160000,
        totalCostUsd: 0,
        latestContextTokens: 28000,
        latestInputTokens: 5000,
        latestCacheReadInputTokens: 22000,
        latestCacheCreationInputTokens: 1000,
      },
      history: [{ role: "user", content: "hello" }],
      pinnedContext: [],
    });

    expect(estimate.source).toBe("latestTurn");
    expect(estimate.usedTokens).toBe(28000);
    expect(estimate.percentUsed).toBeCloseTo(14);
  });

  it("should fall back to estimated usage when latest turn snapshot is missing", () => {
    const estimate = computeContextUsageEstimate({
      contextWindow: 200000,
      metadata: {
        totalTokens: 100000,
        totalCostUsd: 0,
      },
      history: [
        { role: "user", content: "x".repeat(2000) },
        { role: "assistant", content: "y".repeat(1000) },
      ],
      pinnedContext: [
        {
          type: "file",
          label: "File: note.md",
          path: "note.md",
          content: "z".repeat(1000),
        },
      ],
    });

    expect(estimate.source).toBe("estimated");
    expect(estimate.usedTokens).toBeGreaterThan(22000);
    expect(estimate.breakdown.estimatedHistoryTokens).toBeGreaterThan(0);
    expect(estimate.breakdown.estimatedPinnedTokens).toBeGreaterThan(0);
  });

  it("should clamp usage to the model context window", () => {
    const estimate = computeContextUsageEstimate({
      contextWindow: 1000,
      metadata: {
        totalTokens: 0,
        totalCostUsd: 0,
        latestContextTokens: 2000,
      },
    });

    expect(estimate.usedTokens).toBe(1000);
    expect(estimate.percentUsed).toBe(100);
    expect(estimate.breakdown.freeTokens).toBe(0);
  });

  it("should estimate tokens from character count", () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(9)).toBe(3);
  });

  it("should report zero usage for an empty conversation", () => {
    const estimate = computeContextUsageEstimate({
      contextWindow: 200000,
      metadata: {
        totalTokens: 0,
        totalCostUsd: 0,
      },
      history: [],
      pinnedContext: [],
    });

    expect(estimate.usedTokens).toBe(0);
    expect(estimate.percentUsed).toBe(0);
  });
});
