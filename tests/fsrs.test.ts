import { describe, expect, it } from "vitest";
import {
  DEFAULT_FSRS_OPTIONS,
  getFsrsRetrievability,
  previewFsrsSchedule,
  scheduleFsrsReview,
  seedFsrsStateFromLegacy
} from "../src/fsrs-scheduler";

describe("FSRS-6 调度", () => {
  const now = new Date("2026-07-14T00:00:00.000Z");
  const deterministic = { ...DEFAULT_FSRS_OPTIONS, enableFuzzing: false };

  it("新卡评分后写入可序列化的记忆状态", () => {
    const result = scheduleFsrsReview(null, 3, now, deterministic);
    expect(result.state.reps).toBe(1);
    expect(result.state.stability).toBeGreaterThan(0);
    expect(result.state.difficulty).toBeGreaterThan(0);
    expect(Date.parse(result.dueAt)).toBeGreaterThan(now.getTime());
    expect(result.intervalMinutes).toBeGreaterThan(0);
  });

  it("成熟卡再次答对后稳定度和复习间隔增长", () => {
    const first = scheduleFsrsReview(null, 3, now, deterministic);
    const secondAt = new Date(first.dueAt);
    const second = scheduleFsrsReview(first.state, 3, secondAt, deterministic);
    const thirdAt = new Date(second.dueAt);
    const third = scheduleFsrsReview(second.state, 3, thirdAt, deterministic);
    expect(third.state.stability).toBeGreaterThan(second.state.stability);
    expect(third.intervalMinutes).toBeGreaterThan(second.intervalMinutes);
  });

  it("答错进入短时重学并累计遗忘次数", () => {
    const learned = scheduleFsrsReview(null, 4, now, deterministic);
    const reviewedAt = new Date(learned.dueAt);
    const forgotten = scheduleFsrsReview(learned.state, 1, reviewedAt, deterministic);
    expect(forgotten.state.lapses).toBeGreaterThanOrEqual(learned.state.lapses + 1);
    expect(forgotten.intervalMinutes).toBeLessThanOrEqual(15);
  });

  it("较高目标记忆率不会给出更长的复习间隔", () => {
    const learned = scheduleFsrsReview(null, 4, now, deterministic);
    const reviewedAt = new Date(learned.dueAt);
    const lowRetention = scheduleFsrsReview(learned.state, 3, reviewedAt, {
      ...deterministic,
      desiredRetention: 0.85
    });
    const highRetention = scheduleFsrsReview(learned.state, 3, reviewedAt, {
      ...deterministic,
      desiredRetention: 0.95
    });
    expect(highRetention.intervalMinutes).toBeLessThanOrEqual(lowRetention.intervalMinutes);
  });

  it("四级评分预览不修改原记忆状态", () => {
    const learned = scheduleFsrsReview(null, 3, now, deterministic);
    const snapshot = JSON.stringify(learned.state);
    const preview = previewFsrsSchedule(learned.state, new Date(learned.dueAt), deterministic);
    expect(Object.keys(preview)).toEqual(["1", "2", "3", "4"]);
    expect(preview[1].intervalMinutes).toBeLessThan(preview[3].intervalMinutes);
    expect(JSON.stringify(learned.state)).toBe(snapshot);
  });

  it("旧阶段卡可生成近似初始状态，不清零历史成熟度", () => {
    const seeded = seedFsrsStateFromLegacy({
      stage: 5,
      reviewCount: 9,
      errorCount: 2,
      lastReviewedAt: "2026-07-01T00:00:00.000Z",
      nextReviewAt: "2026-07-16T00:00:00.000Z"
    }, now);
    expect(seeded.reps).toBe(9);
    expect(seeded.lapses).toBe(2);
    expect(seeded.stability).toBeGreaterThanOrEqual(15);
    expect(seeded.lastReview).toBe("2026-07-01T00:00:00.000Z");
  });

  it("可从当前FSRS状态提取0到1之间的实时可提取率", () => {
    const learned = scheduleFsrsReview(null, 3, now, deterministic);
    const retrievability = getFsrsRetrievability(learned.state, new Date(learned.dueAt), deterministic);
    expect(retrievability).toBeGreaterThan(0);
    expect(retrievability).toBeLessThanOrEqual(1);
    expect(getFsrsRetrievability(null, now, deterministic)).toBeNull();
  });
});
