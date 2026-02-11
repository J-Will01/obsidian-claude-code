import { ConversationHistoryEntry, Conversation, MessageContext } from "../types";

const DEFAULT_SYSTEM_AND_TOOLS_TOKENS = 22000;
const CHARS_PER_TOKEN = 4;

export interface ContextUsageEstimate {
  usedTokens: number;
  percentUsed: number;
  contextWindow: number;
  source: "latestTurn" | "estimated";
  breakdown: {
    latestInputTokens: number;
    latestCacheReadInputTokens: number;
    latestCacheCreationInputTokens: number;
    estimatedHistoryTokens: number;
    estimatedPinnedTokens: number;
    estimatedSystemAndToolsTokens: number;
    freeTokens: number;
  };
}

function sanitizeTokenCount(value?: number): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

export function estimateTokensFromChars(charCount: number): number {
  if (!Number.isFinite(charCount) || charCount <= 0) return 0;
  return Math.ceil(charCount / CHARS_PER_TOKEN);
}

function estimateHistoryTokens(history: ConversationHistoryEntry[]): number {
  if (!Array.isArray(history) || history.length === 0) return 0;
  const json = JSON.stringify(history || []);
  return estimateTokensFromChars(json.length);
}

function estimatePinnedTokens(pinnedContext: MessageContext[]): number {
  if (!Array.isArray(pinnedContext) || pinnedContext.length === 0) return 0;
  const totalChars = pinnedContext.reduce((sum, context) => {
    const label = context?.label ?? "";
    const path = context?.path ?? "";
    const content = context?.content ?? "";
    // Include a small per-item framing overhead used when we build pinned blocks.
    return sum + label.length + path.length + content.length + 64;
  }, 0);
  return estimateTokensFromChars(totalChars);
}

export function computeContextUsageEstimate(options: {
  contextWindow: number;
  metadata?: Conversation["metadata"];
  history?: ConversationHistoryEntry[];
  pinnedContext?: MessageContext[];
}): ContextUsageEstimate {
  const contextWindow = Math.max(1, sanitizeTokenCount(options.contextWindow));
  const metadata = options.metadata;

  const latestInputTokens = sanitizeTokenCount(metadata?.latestInputTokens);
  const latestCacheReadInputTokens = sanitizeTokenCount(metadata?.latestCacheReadInputTokens);
  const latestCacheCreationInputTokens = sanitizeTokenCount(metadata?.latestCacheCreationInputTokens);
  const latestContextTokens = sanitizeTokenCount(metadata?.latestContextTokens);

  const estimatedHistoryTokens = estimateHistoryTokens(options.history ?? []);
  const estimatedPinnedTokens = estimatePinnedTokens(options.pinnedContext ?? []);
  const hasConversationState =
    estimatedHistoryTokens > 0 ||
    estimatedPinnedTokens > 0 ||
    sanitizeTokenCount(metadata?.totalTokens) > 0 ||
    sanitizeTokenCount(metadata?.inputTokens) > 0 ||
    sanitizeTokenCount(metadata?.outputTokens) > 0;
  const estimatedSystemAndToolsTokens = hasConversationState ? DEFAULT_SYSTEM_AND_TOOLS_TOKENS : 0;

  const hasLatestTurnSnapshot = latestContextTokens > 0;
  const inferredLatestInputTokens =
    hasLatestTurnSnapshot && latestInputTokens === 0 && latestCacheReadInputTokens === 0 && latestCacheCreationInputTokens === 0
      ? latestContextTokens
      : latestInputTokens;

  const usedTokensRaw = hasLatestTurnSnapshot
    ? latestContextTokens
    : estimatedSystemAndToolsTokens + estimatedHistoryTokens + estimatedPinnedTokens;
  const usedTokens = Math.min(contextWindow, Math.round(usedTokensRaw));
  const percentUsed = Math.min(100, (usedTokens / contextWindow) * 100);

  return {
    usedTokens,
    percentUsed,
    contextWindow,
    source: hasLatestTurnSnapshot ? "latestTurn" : "estimated",
    breakdown: {
      latestInputTokens: inferredLatestInputTokens,
      latestCacheReadInputTokens,
      latestCacheCreationInputTokens,
      estimatedHistoryTokens,
      estimatedPinnedTokens,
      estimatedSystemAndToolsTokens,
      freeTokens: Math.max(0, contextWindow - usedTokens),
    },
  };
}
