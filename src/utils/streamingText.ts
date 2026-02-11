function computeOverlap(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  for (let size = max; size > 0; size--) {
    if (left.slice(-size) === right.slice(0, size)) {
      return size;
    }
  }
  return 0;
}

export function mergeStreamingText(previous: string, incoming: string): string {
  if (!previous) return incoming || "";
  if (!incoming) return previous;
  if (incoming === previous) return previous;

  // If either side already contains the other, keep the richer side.
  if (incoming.includes(previous)) return incoming;
  if (previous.includes(incoming)) return previous;

  // If incoming looks cumulative, prefer it.
  if (incoming.startsWith(previous)) return incoming;
  if (previous.startsWith(incoming)) return previous;

  // Merge at string overlap boundaries when possible.
  const overlap = computeOverlap(previous, incoming);
  if (overlap > 0) {
    return previous + incoming.slice(overlap);
  }

  const separator = /\s$/.test(previous) || /^\s/.test(incoming) ? "" : "\n\n";
  return `${previous}${separator}${incoming}`;
}
