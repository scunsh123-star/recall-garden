export interface SessionQueueCard {
  reviewId: string;
  queueReason: unknown;
}

export type StoredSessionMode = "scheduled" | "today" | "weak" | "all";

export interface StoredSessionQueueEntry {
  reviewId: string;
  queueReason: unknown;
}

export interface StoredReviewSession {
  version: 1;
  savedAt: string;
  mode: StoredSessionMode;
  queue: StoredSessionQueueEntry[];
  revealStep: 0 | 1 | 2;
  reviewActions: number;
  activeQuestionId: string | null;
  scrollTop: number;
}

export function reconcileSessionQueue<T extends SessionQueueCard>(
  queue: readonly T[],
  scannedCards: readonly T[]
): T[] {
  const scannedById = new Map(scannedCards.map((card) => [card.reviewId, card]));
  return queue.flatMap((current) => {
    const scanned = scannedById.get(current.reviewId);
    return scanned ? [{ ...scanned, queueReason: current.queueReason }] : [];
  });
}

export function sessionQueuesEqual<T extends SessionQueueCard>(
  left: readonly T[],
  right: readonly T[]
): boolean {
  return left.length === right.length && left.every((card, index) =>
    JSON.stringify(card) === JSON.stringify(right[index])
  );
}

export function restoreStoredSessionQueue<T extends SessionQueueCard>(
  storedQueue: readonly StoredSessionQueueEntry[],
  scannedCards: readonly T[]
): T[] {
  const scannedById = new Map(scannedCards.map((card) => [card.reviewId, card]));
  return storedQueue.flatMap((entry) => {
    const card = scannedById.get(entry.reviewId);
    return card ? [{ ...card, queueReason: entry.queueReason }] : [];
  });
}

export function resolveSessionScrollTop(
  lastKnownScrollTop: number,
  currentScrollTop: number,
  viewIsAttached: boolean
): number {
  const lastKnown = Number.isFinite(lastKnownScrollTop) ? Math.max(0, lastKnownScrollTop) : 0;
  const current = Number.isFinite(currentScrollTop) ? Math.max(0, currentScrollTop) : 0;
  return viewIsAttached ? current : lastKnown;
}

export function parseStoredReviewSession(value: unknown): StoredReviewSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<StoredReviewSession>;
  if (item.version !== 1 || typeof item.savedAt !== "string") return null;
  if (!item.mode || !["scheduled", "today", "weak", "all"].includes(item.mode)) return null;
  if (!Array.isArray(item.queue) || !item.queue.every((entry) =>
    entry && typeof entry === "object" && typeof entry.reviewId === "string"
  )) return null;
  if (item.revealStep !== 0 && item.revealStep !== 1 && item.revealStep !== 2) return null;
  if (!Number.isFinite(item.reviewActions) || (item.reviewActions ?? -1) < 0) return null;
  if (item.activeQuestionId !== null && typeof item.activeQuestionId !== "string") return null;
  if (!Number.isFinite(item.scrollTop) || (item.scrollTop ?? -1) < 0) return null;
  return {
    version: 1,
    savedAt: item.savedAt,
    mode: item.mode,
    queue: item.queue.map((entry) => ({ reviewId: entry.reviewId, queueReason: entry.queueReason })),
    revealStep: item.revealStep,
    reviewActions: Math.floor(item.reviewActions!),
    activeQuestionId: item.activeQuestionId,
    scrollTop: item.scrollTop!
  };
}
