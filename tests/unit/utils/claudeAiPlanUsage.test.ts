import { describe, it, expect } from "vitest";
import { parseClaudeAiUsageResponse } from "../../../src/utils/claudeAiPlanUsage";

describe("claudeAiPlanUsage", () => {
  it("should parse five_hour and seven_day usage snapshots", () => {
    const json = {
      five_hour: { utilization: 46.0, resets_at: "2026-02-11T00:00:00.251383+00:00" },
      seven_day: { utilization: 19.0, resets_at: "2026-02-16T18:00:00.251406+00:00" },
      extra_usage: { enabled: true },
    };

    const snapshot = parseClaudeAiUsageResponse(json, 123);
    expect(snapshot).toEqual({
      fetchedAt: 123,
      fiveHourUtilizationPercent: 46,
      fiveHourResetsAt: "2026-02-11T00:00:00.251383+00:00",
      sevenDayUtilizationPercent: 19,
      sevenDayResetsAt: "2026-02-16T18:00:00.251406+00:00",
      extraUsageEnabled: true,
    });
  });

  it("should return null for invalid responses", () => {
    expect(parseClaudeAiUsageResponse({}, 1)).toBeNull();
    expect(parseClaudeAiUsageResponse({ five_hour: { utilization: "nope" } }, 1)).toBeNull();
  });
});

