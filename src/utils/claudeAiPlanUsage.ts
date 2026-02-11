import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { logger } from "./Logger";
import { ClaudeAiPlanUsageSnapshot } from "../types";

type KeytarModule = {
  getPassword: (service: string, account: string) => Promise<string | null>;
};

let keytarModule: KeytarModule | null = null;

function loadKeytar(): KeytarModule | null {
  if (keytarModule) return keytarModule;
  try {
    const loaded = require("keytar") as KeytarModule;
    keytarModule = loaded;
    return keytarModule;
  } catch {
    return null;
  }
}

type ClaudeCodeCredentials = {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
};

const SECURITY_SERVICE = "Claude Code-credentials";
const execFileAsync = promisify(execFile);

async function readClaudeCodeCredentialsJson(): Promise<string | null> {
  // Prefer keytar if present (no shelling out).
  const keytar = loadKeytar();
  const username = os.userInfo().username;
  if (keytar) {
    try {
      const pwd = await keytar.getPassword(SECURITY_SERVICE, username);
      if (pwd) return pwd;
    } catch (e) {
      logger.debug("claudeAiPlanUsage", "Keytar read failed", { error: String(e) });
    }
  }

  // Fallback: macOS security tool. Avoid using a shell; execFile keeps args un-interpreted.
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", SECURITY_SERVICE, "-w"],
      { timeout: 5000, maxBuffer: 1024 * 1024 }
    );
    const trimmed = String(stdout ?? "").trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (e) {
    logger.debug("claudeAiPlanUsage", "security keychain read failed", { error: String(e) });
    return null;
  }
}

async function readClaudeAiAccessToken(): Promise<string | null> {
  const jsonText = await readClaudeCodeCredentialsJson();
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as ClaudeCodeCredentials;
    const accessToken = parsed?.claudeAiOauth?.accessToken;
    if (typeof accessToken === "string" && accessToken.length > 0) {
      return accessToken;
    }
    return null;
  } catch (e) {
    logger.debug("claudeAiPlanUsage", "Failed to parse Claude Code credentials JSON", { error: String(e) });
    return null;
  }
}

export function parseClaudeAiUsageResponse(json: any, fetchedAt: number): ClaudeAiPlanUsageSnapshot | null {
  const fiveHour = json?.five_hour;
  if (!fiveHour) return null;

  const utilization = Number(fiveHour?.utilization);
  if (!Number.isFinite(utilization)) return null;

  const sevenDay = json?.seven_day;
  const sevenDayUtil = sevenDay ? Number(sevenDay?.utilization) : undefined;

  return {
    fetchedAt,
    fiveHourUtilizationPercent: utilization,
    fiveHourResetsAt: typeof fiveHour?.resets_at === "string" ? fiveHour.resets_at : undefined,
    sevenDayUtilizationPercent: Number.isFinite(sevenDayUtil) ? sevenDayUtil : undefined,
    sevenDayResetsAt: typeof sevenDay?.resets_at === "string" ? sevenDay.resets_at : undefined,
    extraUsageEnabled: typeof json?.extra_usage?.enabled === "boolean" ? json.extra_usage.enabled : undefined,
  };
}

export async function fetchClaudeAiPlanUsage(opts?: {
  accessToken?: string;
}): Promise<ClaudeAiPlanUsageSnapshot | null> {
  const fetchedAt = Date.now();
  const accessToken = (opts?.accessToken && opts.accessToken.trim()) || (await readClaudeAiAccessToken());
  if (!accessToken) return null;

  const url = "https://api.anthropic.com/api/oauth/usage";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "claude-code/2.1.25",
  };

  // Prefer Obsidian's requestUrl to avoid CORS issues in the renderer fetch().
  // Keep this optional so unit tests can run in plain Node.
  try {
    const obsidian = require("obsidian") as any;
    if (typeof obsidian?.requestUrl === "function") {
      const resp = await obsidian.requestUrl({
        url,
        method: "GET",
        headers,
      });
      if (!resp || typeof resp.status !== "number") {
        throw new Error("Claude usage fetch failed: invalid response");
      }
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`Claude usage fetch failed: HTTP ${resp.status}`);
      }
      const json = resp.json ?? (resp.text ? JSON.parse(resp.text) : null);
      const parsed = parseClaudeAiUsageResponse(json, fetchedAt);
      return parsed;
    }
  } catch (e) {
    // Fall through to fetch() below.
    logger.debug("claudeAiPlanUsage", "requestUrl path failed; falling back to fetch()", { error: String(e) });
  }

  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) throw new Error(`Claude usage fetch failed: HTTP ${res.status}`);
  return parseClaudeAiUsageResponse(await res.json(), fetchedAt);
}
