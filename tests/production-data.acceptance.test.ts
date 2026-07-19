import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migrateData, summarizeData } from "../src/data";

const dataPath = process.env.RECALL_GARDEN_ACCEPTANCE_DATA;

describe.skipIf(!dataPath)("生产数据只读迁移验收", () => {
  it("迁移到v5后逐项保留现有数据，且不低于确认基线", () => {
    const raw = JSON.parse(readFileSync(dataPath!, "utf8")) as {
      sourceIds: Record<string, string>;
      records: Record<string, unknown>;
      questions: Record<string, unknown>;
    };
    const migrated = migrateData(raw);
    expect(migrated.sourceIds).toEqual(raw.sourceIds);
    const expectedRecords = Object.fromEntries(Object.entries(raw.records).map(([reviewId, record]) => {
      const value = record as Record<string, unknown>;
      return [reviewId, {
        ...value,
        history: Array.isArray(value.history) ? value.history : [],
        fsrs: value.fsrs ?? null
      }];
    }));
    expect(migrated.records).toEqual(expectedRecords);
    expect(migrated.questions).toEqual(raw.questions);
    expect(migrated.version).toBe(5);

    const summary = summarizeData(migrated);
    expect(summary.stableIds).toBeGreaterThanOrEqual(154);
    expect(summary.reviewedCards).toBeGreaterThanOrEqual(21);
    expect(summary.totalRatings).toBeGreaterThanOrEqual(41);
    expect(summary.aiQuestions).toBeGreaterThanOrEqual(4);
  });
});
