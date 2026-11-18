import { progressTrack, trackText } from "./progress";
import { pollDelay } from "./policy";
import type { Watch } from "./watcher";

const timestamp = (epochMs?: number) => (epochMs === undefined ? "never" : new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, "Z"));

// The PR title and its approval/up-to-date status are kept even when only the tail is shown.
const isHeader = (line: string, index: number) => index === 0 || /^(summary|approved|up to date with \S+):/.test(line);

function snapshotLines(snapshot: string, tail?: number): string[] {
  const lines = snapshot.split("\n");
  const header = lines.filter(isHeader);
  const rest = lines.filter((line, index) => !isHeader(line, index));
  if (tail === undefined || rest.length <= tail) return lines;
  const omitted = rest.length - tail;
  return [...header, `  (${omitted} earlier lines omitted)`, ...rest.slice(-tail)];
}

// A watch that hasn't been checked for twice its poll interval has lost its poll loop.
function staleness(watch: Watch, now?: number): string {
  if (now === undefined || watch.lastCheckedAt === undefined || !watch.lastFacts) return "";
  const interval = pollDelay(watch.lastFacts, watch.lastCheckedAt, watch.awaiting !== undefined);
  const age = now - watch.lastCheckedAt;
  return age > 2 * interval ? ` (STALE: last checked ${Math.round(age / 60_000)} min ago)` : "";
}

export function formatWatch(watch: Watch, tail?: number, now?: number): string {
  return [
    `${watch.id} (session ${watch.sessionID}, provider ${watch.pinned.providerID})`,
    `last checked ${timestamp(watch.lastCheckedAt)}, last change ${timestamp(watch.lastSnapshot ? watch.lastChangeAt : undefined)}${staleness(watch, now)}`,
    // The same track the pill shows, for agents and clients without the desktop app.
    ...(watch.lastFacts ? [`track: ${trackText(progressTrack(watch.lastFacts, now ?? Date.now()))}`] : []),
    ...(watch.lastSnapshot ? snapshotLines(watch.lastSnapshot, tail) : ["(not checked yet)"]),
  ].join("\n");
}
