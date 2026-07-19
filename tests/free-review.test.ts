import { describe, expect, it } from "vitest";
import type { ReviewRecord } from "../src/data";
import { buildFreeReviewQueue } from "../src/free-review";

interface TestCard {
  reviewId: string;
  title: string;
}

function card(reviewId: string): TestCard {
  return { reviewId, title: reviewId };
}

function record(reviewId: string, overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    reviewId,
    sourcePath: `${reviewId}.md`,
    stage: 2,
    introducedAt: "2026-07-10T08:00:00.000Z",
    lastReviewedAt: "2026-07-13T08:00:00.000Z",
    nextReviewAt: "2026-07-20T08:00:00.000Z",
    lastRating: 3,
    reviewCount: 3,
    errorCount: 0,
    history: [],
    fsrs: null,
    ...overrides
  };
}

describe("自由复习队列", () => {
  const now = new Date("2026-07-14T12:00:00.000Z");
  const cards = [card("new"), card("today-late"), card("weak"), card("today-early")];
  const records: Record<string, ReviewRecord> = {
    "today-late": record("today-late", { lastReviewedAt: "2026-07-14T10:00:00.000Z" }),
    weak: record("weak", { lastRating: 2, errorCount: 2 }),
    "today-early": record("today-early", { lastReviewedAt: "2026-07-14T08:00:00.000Z" })
  };

  it("今日已复习只收录本地日期为今天的卡，并按作答先后排列", () => {
    expect(buildFreeReviewQueue(cards, records, "today", now).map((item) => item.reviewId))
      .toEqual(["today-early", "today-late"]);
  });

  it("薄弱卡排除新卡，并优先重来、困难及错误率更高的卡", () => {
    const weakRecords: Record<string, ReviewRecord> = {
      again: record("again", { lastRating: 1, errorCount: 1, reviewCount: 4 }),
      "hard-low": record("hard-low", { lastRating: 2, errorCount: 1, reviewCount: 5 }),
      "hard-high": record("hard-high", { lastRating: 2, errorCount: 3, reviewCount: 5 }),
      good: record("good", { lastRating: 3, errorCount: 0 })
    };
    const weakCards = [card("new"), card("hard-low"), card("good"), card("again"), card("hard-high")];

    expect(buildFreeReviewQueue(weakCards, weakRecords, "weak", now).map((item) => item.reviewId))
      .toEqual(["again", "hard-high", "hard-low"]);
  });

  it("全部卡保留扫描顺序，构建队列不会修改任何调度记录", () => {
    const before = JSON.stringify(records);

    expect(buildFreeReviewQueue(cards, records, "all", now)).toEqual(cards);
    expect(JSON.stringify(records)).toBe(before);
  });
});
