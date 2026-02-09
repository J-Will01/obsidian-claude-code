import { describe, it, expect } from "vitest";
import { normalizeToolResult } from "@/utils/ToolResultNormalizer";

describe("normalizeToolResult", () => {
  it("normalizes bash-like results", () => {
    const result = normalizeToolResult("Bash", {
      stdout: "ok",
      stderr: "",
      exit_code: 0,
      duration_ms: 120,
    });

    expect(result.stdout).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBe(120);
  });

  it("stringifies non-string outputs", () => {
    const result = normalizeToolResult("Read", { output: { hello: "world" } });
    expect(result.output).toContain("hello");
  });
});
