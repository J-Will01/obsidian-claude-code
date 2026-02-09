import { ToolCall } from "../types";

type NormalizedToolResult = {
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  isError?: boolean;
  raw?: unknown;
};

function stringifyResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function normalizeToolResult(toolName: string, raw: unknown): NormalizedToolResult {
  if (raw == null) {
    return {};
  }

  if (typeof raw === "string") {
    return { output: raw };
  }

  if (typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const stdout = typeof record.stdout === "string" ? record.stdout : undefined;
    const stderr = typeof record.stderr === "string" ? record.stderr : undefined;
    const exitCode =
      typeof record.exit_code === "number"
        ? record.exit_code
        : typeof record.exitCode === "number"
          ? record.exitCode
          : undefined;
    const durationMs =
      typeof record.duration_ms === "number"
        ? record.duration_ms
        : typeof record.durationMs === "number"
          ? record.durationMs
          : undefined;

    if (toolName.toLowerCase() === "bash" || toolName.toLowerCase() === "shell") {
      return {
        stdout,
        stderr,
        exitCode,
        durationMs,
        output: record.output ? stringifyResult(record.output) : undefined,
        raw,
      };
    }

    if (record.output !== undefined) {
      return {
        output: stringifyResult(record.output),
        durationMs,
        raw,
      };
    }

    return {
      output: stringifyResult(record),
      durationMs,
      raw,
    };
  }

  return { output: String(raw) };
}

export function applyNormalizedToolResult(toolCall: ToolCall, result: NormalizedToolResult) {
  toolCall.output = result.output ?? toolCall.output;
  toolCall.stdout = result.stdout ?? toolCall.stdout;
  toolCall.stderr = result.stderr ?? toolCall.stderr;
  toolCall.exitCode = result.exitCode ?? toolCall.exitCode;
  toolCall.durationMs = result.durationMs ?? toolCall.durationMs;
  if (result.raw !== undefined) {
    toolCall.raw = result.raw;
  }
}
