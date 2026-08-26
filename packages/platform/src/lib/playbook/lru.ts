import type { PlaybookEntry } from "./types.js";

export function evictToMax(entries: PlaybookEntry[], maxEntries: number): PlaybookEntry[] {
  const max = Math.max(0, Math.floor(maxEntries));
  if (entries.length <= max) {
    return entries;
  }
  const ranked = entries.map((entry, index) => ({ entry, index }));
  ranked.sort((a, b) => {
    if (a.entry.lru_at < b.entry.lru_at) {
      return -1;
    }
    if (a.entry.lru_at > b.entry.lru_at) {
      return 1;
    }
    return a.index - b.index;
  });
  const dropCount = entries.length - max;
  const drop = new Set(ranked.slice(0, dropCount).map((row) => row.entry.key));
  return entries.filter((entry) => !drop.has(entry.key));
}
