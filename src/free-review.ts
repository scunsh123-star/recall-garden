import type { ReviewRecord } from "./data";

export type FreeReviewMode = "today" | "weak" | "all";

export interface FreeReviewCard {
  reviewId: string;
}

export function buildFreeReviewQueue<T extends FreeReviewCard>(
  cards: readonly T[],
  records: Readonly<Record<string, ReviewRecord>>,
  mode: FreeReviewMode,
  now = new Date()
): T[] {
  if (mode === "all") return [...cards];

  if (mode === "today") {
    return cards
      .filter((card) => {
        const reviewedAt = records[card.reviewId]?.lastReviewedAt;
        return reviewedAt !== undefined && isSameLocalDate(new Date(reviewedAt), now);
      })
      .sort((left, right) => reviewedTime(records, left) - reviewedTime(records, right));
  }

  return cards
    .filter((card) => {
      const record = records[card.reviewId];
      return record !== undefined && (record.lastRating <= 2 || record.errorCount > 0);
    })
    .sort((left, right) => compareWeakCards(records[left.reviewId], records[right.reviewId]));
}

function isSameLocalDate(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function reviewedTime<T extends FreeReviewCard>(
  records: Readonly<Record<string, ReviewRecord>>,
  card: T
): number {
  return Date.parse(records[card.reviewId]?.lastReviewedAt ?? "") || 0;
}

function compareWeakCards(left: ReviewRecord, right: ReviewRecord): number {
  if (left.lastRating !== right.lastRating) return left.lastRating - right.lastRating;
  const leftErrorRate = left.reviewCount === 0 ? 0 : left.errorCount / left.reviewCount;
  const rightErrorRate = right.reviewCount === 0 ? 0 : right.errorCount / right.reviewCount;
  if (leftErrorRate !== rightErrorRate) return rightErrorRate - leftErrorRate;
  return Date.parse(left.lastReviewedAt) - Date.parse(right.lastReviewedAt);
}
