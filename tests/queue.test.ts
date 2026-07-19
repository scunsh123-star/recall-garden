import { describe, expect, it } from "vitest";
import { ReviewRecord } from "../src/data";
import {
  QueueCardMetadata,
  buildDueForecast,
  buildPrioritizedQueue,
  frequencyRank,
  normalizeExamYears,
  normalizeReviewPriority
} from "../src/queue";

interface TestCard extends QueueCardMetadata {
  title: string;
}

function card(reviewId: string, overrides: Partial<TestCard> = {}): TestCard {
  return {
    reviewId,
    title: reviewId,
    examYears: [],
    frequency: "",
    status: "待背诵",
    reviewPriority: null,
    ...overrides
  };
}

function record(reviewId: string, nextReviewAt: string, overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    reviewId,
    sourcePath: `${reviewId}.md`,
    stage: 2,
    introducedAt: "2026-07-10T00:00:00.000Z",
    lastReviewedAt: "2026-07-13T00:00:00.000Z",
    nextReviewAt,
    lastRating: 3,
    reviewCount: 3,
    errorCount: 0,
    history: [],
    fsrs: null,
    ...overrides
  };
}

describe("YAML复习元数据", () => {
  it("规范化真题年份与S/A/B/C人工优先级", () => {
    expect(normalizeExamYears([2024, "2026", "无", 2024])).toEqual([2024, 2026]);
    expect(normalizeExamYears(undefined)).toEqual([]);
    expect(normalizeReviewPriority("s")).toBe("S");
    expect(normalizeReviewPriority("X")).toBeNull();
  });

  it("兼容真实库中的混合频次文本，而不把低频迁移素材误判为高频卡", () => {
    expect(frequencyRank("高频（生物圈/土壤圈）；中频（综述）")).toBe(3);
    expect(frequencyRank("中高频")).toBe(2);
    expect(frequencyRank("中频")).toBe(1);
    expect(frequencyRank("低频但高频迁移素材")).toBe(0);
  });
});

describe("风险优先队列", () => {
  const now = new Date("2026-07-14T12:00:00+08:00");

  it("依次排列逾期旧卡、答错卡、真题卡、高频卡、普通到期卡和新卡", () => {
    const cards = [
      card("new"),
      card("due"),
      card("frequency", { frequency: "中高频" }),
      card("exam", { examYears: [2024] }),
      card("wrong"),
      card("overdue")
    ];
    const records: Record<string, ReviewRecord> = {
      overdue: record("overdue", "2026-07-13T14:00:00+08:00"),
      wrong: record("wrong", "2026-07-14T10:00:00+08:00", { lastRating: 1, errorCount: 2 }),
      exam: record("exam", "2026-07-14T10:00:00+08:00"),
      frequency: record("frequency", "2026-07-14T10:00:00+08:00"),
      due: record("due", "2026-07-14T10:00:00+08:00")
    };

    const queue = buildPrioritizedQueue(cards, records, {
      now,
      dailyNewCards: 10,
      dailyReviewLimit: 20,
      pauseNewCards: false
    });
    expect(queue.map((item) => item.card.reviewId)).toEqual(["overdue", "wrong", "exam", "frequency", "due", "new"]);
    expect(queue.map((item) => item.reason)).toEqual(["overdue", "wrong", "exam", "high-frequency", "due", "new"]);
  });

  it("同一风险层内S优先于A，并让人工优先级保持可解释", () => {
    const cards = [
      card("exam-a", { examYears: [2024], reviewPriority: "A" }),
      card("exam-s", { examYears: [2024], reviewPriority: "S" })
    ];
    const records = {
      "exam-a": record("exam-a", "2026-07-14T10:00:00+08:00"),
      "exam-s": record("exam-s", "2026-07-14T11:00:00+08:00")
    };
    expect(buildPrioritizedQueue(cards, records, {
      now,
      dailyNewCards: 0,
      dailyReviewLimit: 20,
      pauseNewCards: false
    }).map((item) => item.card.reviewId)).toEqual(["exam-s", "exam-a"]);
  });

  it("暂停新卡后只保留到期复习债务", () => {
    const cards = [card("due"), card("new", { examYears: [2024], reviewPriority: "S" })];
    const records = { due: record("due", "2026-07-14T10:00:00+08:00") };
    expect(buildPrioritizedQueue(cards, records, {
      now,
      dailyNewCards: 22,
      dailyReviewLimit: 100,
      pauseNewCards: true
    }).map((item) => item.card.reviewId)).toEqual(["due"]);
  });
});

describe("七天容量预测", () => {
  it("把逾期债务并入今天、只统计活动卡，并提示22张新卡的回流风险", () => {
    const now = new Date("2026-07-14T12:00:00+08:00");
    const records = {
      overdue: record("overdue", "2026-07-12T10:00:00+08:00"),
      tomorrow: record("tomorrow", "2026-07-15T10:00:00+08:00"),
      archived: record("archived", "2026-07-16T10:00:00+08:00"),
      introduced: record("introduced", "2026-07-22T10:00:00+08:00", {
        introducedAt: "2026-07-14T09:00:00+08:00"
      })
    };
    const forecast = buildDueForecast(records, new Set(["overdue", "tomorrow", "introduced"]), {
      now,
      days: 7,
      dailyNewCards: 22,
      dailyReviewLimit: 100,
      pauseNewCards: false
    });
    expect(forecast.days).toHaveLength(7);
    expect(forecast.days.map((day) => day.scheduledDue)).toEqual([1, 1, 0, 0, 0, 0, 0]);
    expect(forecast.days[0].plannedNewCards).toBe(21);
    expect(forecast.days.slice(1).every((day) => day.plannedNewCards === 22)).toBe(true);
    expect(forecast.risk).toBe("high");
    expect(forecast.warning).toContain("22");
  });
});
