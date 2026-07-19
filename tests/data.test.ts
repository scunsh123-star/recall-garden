import { describe, expect, it } from "vitest";
import { AiQuestion } from "../src/ai";
import {
  UnknownSchemaVersionError,
  archiveCard,
  assignReviewId,
  buildReviewRecord,
  createEmptyData,
  migrateData,
  reconcileSources,
  restoreArchivedCard,
  summarizeData,
  updateSourcePath
} from "../src/data";

function question(reviewId: string, sourcePath: string): AiQuestion {
  return {
    id: `ai-${reviewId}`,
    reviewId,
    sourcePath,
    type: "fill",
    prompt: "测试 ____",
    answer: "答案",
    acceptedAnswers: [],
    explanation: "",
    createdAt: "2026-07-13T00:00:00.000Z",
    provider: "deepseek",
    model: "test-model",
    attempts: 0,
    correctCount: 0,
    lastAnsweredAt: ""
  };
}

describe("Schema v5迁移", () => {
  it("从v2迁移时保留154个ID、21张记录、41次评分和4道AI题", () => {
    const sourceIds: Record<string, string> = {};
    const records: Record<string, Record<string, unknown>> = {};
    const questions: Record<string, AiQuestion[]> = {};
    for (let index = 0; index < 154; index += 1) {
      const id = `rg-${index}`;
      const path = `cards/card-${index}.md`;
      sourceIds[path] = id;
      if (index < 21) {
        records[id] = {
          reviewId: id,
          sourcePath: path,
          stage: 1,
          introducedAt: "2026-07-13T00:00:00.000Z",
          lastReviewedAt: "2026-07-13T00:00:00.000Z",
          nextReviewAt: "2026-07-14T00:00:00.000Z",
          lastRating: 3,
          reviewCount: index < 20 ? 2 : 1,
          errorCount: 0
        };
      }
      if (index < 4) questions[id] = [question(id, path)];
    }

    const migrated = migrateData({ version: 2, settings: {}, sourceIds, records, questions });
    expect(migrated.version).toBe(5);
    expect(migrated.settings.schedulerAlgorithm).toBe("fsrs-6");
    expect(migrated.settings.desiredRetention).toBe(0.9);
    expect(migrated.settings.pauseNewCards).toBe(false);
    expect(migrated.settings.trackAnswerTime).toBe(true);
    expect(migrated.settings.examName).toBe("2026 年 12 月考试");
    expect(migrated.settings.examStartDate).toBe("2026-12-19");
    expect(migrated.settings.examEndDate).toBe("2026-12-20");
    expect(Object.values(migrated.records).every((record) => record.history.length === 0)).toBe(true);
    expect(summarizeData(migrated)).toEqual({
      stableIds: 154,
      activeCards: 154,
      reviewedCards: 21,
      totalRatings: 41,
      aiQuestions: 4,
      archivedCards: 0
    });
  });

  it("拒绝未知未来版本，避免旧插件覆盖", () => {
    expect(() => migrateData({ version: 99 })).toThrow(UnknownSchemaVersionError);
  });

  it("保留自定义考试倒计时设置", () => {
    const migrated = migrateData({
      version: 5,
      settings: {
        examName: "理论综合考试",
        examStartDate: "2027-01-03",
        examEndDate: "2027-01-04"
      }
    });
    expect(migrated.settings).toMatchObject({
      examName: "理论综合考试",
      examStartDate: "2027-01-03",
      examEndDate: "2027-01-04"
    });
  });

  it("从v3迁移归档记录时补空历史，不丢归档内容", () => {
    const migrated = migrateData({
      version: 3,
      archived: {
        "rg-a": {
          reviewId: "rg-a",
          sourcePath: "cards/a.md",
          archivedAt: "2026-07-13T00:00:00.000Z",
          reason: "deleted",
          record: {
            reviewId: "rg-a",
            sourcePath: "cards/a.md",
            stage: 1,
            introducedAt: "",
            lastReviewedAt: "",
            nextReviewAt: "",
            lastRating: 3,
            reviewCount: 2,
            errorCount: 0
          },
          questions: []
        }
      }
    });
    expect(migrated.archived["rg-a"].record).toMatchObject({ reviewCount: 2, history: [] });
  });

  it("从v4迁移时保持旧到期时间，并把FSRS设置限制在安全范围", () => {
    const migrated = migrateData({
      version: 4,
      settings: { desiredRetention: 2, maximumIntervalDays: 100_000 },
      sourceIds: { "cards/a.md": "rg-a" },
      records: {
        "rg-a": {
          reviewId: "rg-a",
          sourcePath: "cards/a.md",
          stage: 5,
          introducedAt: "2026-06-01T00:00:00.000Z",
          lastReviewedAt: "2026-07-01T00:00:00.000Z",
          nextReviewAt: "2026-07-16T00:00:00.000Z",
          lastRating: 3,
          reviewCount: 9,
          errorCount: 2,
          history: []
        }
      }
    });
    expect(migrated.records["rg-a"].nextReviewAt).toBe("2026-07-16T00:00:00.000Z");
    expect(migrated.records["rg-a"].fsrs).toBeNull();
    expect(migrated.settings.desiredRetention).toBe(0.97);
    expect(migrated.settings.maximumIntervalDays).toBe(36_500);
  });

  it("评分时记录揭示层级、完整揭示状态和可选用时", () => {
    const first = buildReviewRecord(undefined, "rg-a", "cards/a.md", 3, {
      revealLevel: 1,
      durationSeconds: 47
    }, new Date("2026-07-14T00:00:00.000Z"));
    expect(first.history[0]).toEqual({
      reviewedAt: "2026-07-14T00:00:00.000Z",
      rating: 3,
      revealLevel: 1,
      fullyRevealed: false,
      durationSeconds: 47,
      scheduledDays: expect.any(Number),
      stability: expect.any(Number),
      difficulty: expect.any(Number)
    });
    expect(first.fsrs).toMatchObject({ reps: 1, stability: expect.any(Number) });

    const second = buildReviewRecord(first, "rg-a", "cards/a.md", 4, {
      revealLevel: 2,
      durationSeconds: null
    }, new Date("2026-07-15T00:00:00.000Z"));
    expect(second.history).toHaveLength(2);
    expect(second.history[1]).toMatchObject({ fullyRevealed: true, durationSeconds: null });
  });
});

describe("归档、恢复和路径同步", () => {
  it("删除卡片后把记录与AI题移入归档，不留下活动幽灵记录", () => {
    const data = createEmptyData();
    data.sourceIds["cards/a.md"] = "rg-a";
    data.records["rg-a"] = {
      reviewId: "rg-a",
      sourcePath: "cards/a.md",
      stage: 2,
      introducedAt: "2026-07-13T00:00:00.000Z",
      lastReviewedAt: "2026-07-13T00:00:00.000Z",
      nextReviewAt: "2026-07-14T00:00:00.000Z",
      lastRating: 3,
      reviewCount: 4,
      errorCount: 1,
      history: [],
      fsrs: null
    };
    data.questions["rg-a"] = [question("rg-a", "cards/a.md")];

    archiveCard(data, "cards/a.md", "deleted", "2026-07-13T01:00:00.000Z");
    expect(data.sourceIds).toEqual({});
    expect(data.records).toEqual({});
    expect(data.questions).toEqual({});
    expect(data.archived["rg-a"]).toMatchObject({
      reviewId: "rg-a",
      sourcePath: "cards/a.md",
      reason: "deleted",
      record: { reviewCount: 4 },
      questions: [{ id: "ai-rg-a" }]
    });
    expect(summarizeData(data)).toMatchObject({
      stableIds: 1,
      activeCards: 0,
      reviewedCards: 1,
      totalRatings: 4,
      aiQuestions: 1,
      archivedCards: 1
    });
  });

  it("同路径卡片重新出现时恢复原ID、记录和AI题", () => {
    const data = createEmptyData();
    data.sourceIds["cards/a.md"] = "rg-a";
    data.questions["rg-a"] = [question("rg-a", "cards/a.md")];
    archiveCard(data, "cards/a.md", "deleted");

    expect(assignReviewId(data, "cards/a.md", () => "new-id")).toBe("rg-a");
    expect(data.sourceIds["cards/a.md"]).toBe("rg-a");
    expect(data.questions["rg-a"]).toHaveLength(1);
    expect(data.archived).toEqual({});
  });

  it("重命名同步sourceIds、ReviewRecord和所有AI题路径", () => {
    const data = createEmptyData();
    data.sourceIds["cards/old.md"] = "rg-a";
    data.records["rg-a"] = {
      reviewId: "rg-a",
      sourcePath: "cards/old.md",
      stage: 0,
      introducedAt: "",
      lastReviewedAt: "",
      nextReviewAt: "",
      lastRating: 3,
      reviewCount: 1,
      errorCount: 0,
      history: [],
      fsrs: null
    };
    data.questions["rg-a"] = [question("rg-a", "cards/old.md"), question("rg-a", "cards/old.md")];

    expect(updateSourcePath(data, "cards/old.md", "cards/new.md")).toBe("rg-a");
    expect(data.sourceIds).toEqual({ "cards/new.md": "rg-a" });
    expect(data.records["rg-a"].sourcePath).toBe("cards/new.md");
    expect(data.questions["rg-a"].every((item) => item.sourcePath === "cards/new.md")).toBe(true);
  });

  it("扫描对账区分删除与移出扫描范围", () => {
    const data = createEmptyData();
    data.sourceIds["cards/deleted.md"] = "rg-deleted";
    data.sourceIds["other/moved.md"] = "rg-moved";
    const archived = reconcileSources(
      data,
      new Set<string>(),
      new Set(["other/moved.md"]),
      "2026-07-13T01:00:00.000Z"
    );
    expect(archived).toHaveLength(2);
    expect(data.archived["rg-deleted"].reason).toBe("deleted");
    expect(data.archived["rg-moved"].reason).toBe("out-of-scope");
  });

  it("可以显式恢复归档卡到新路径", () => {
    const data = createEmptyData();
    data.sourceIds["cards/a.md"] = "rg-a";
    archiveCard(data, "cards/a.md", "deleted");
    expect(restoreArchivedCard(data, "rg-a", "cards/restored.md")).toBe(true);
    expect(data.sourceIds["cards/restored.md"]).toBe("rg-a");
  });

  it("归档卡重命名也同步历史与AI题路径", () => {
    const data = createEmptyData();
    data.sourceIds["cards/old.md"] = "rg-a";
    data.records["rg-a"] = {
      reviewId: "rg-a",
      sourcePath: "cards/old.md",
      stage: 1,
      introducedAt: "",
      lastReviewedAt: "",
      nextReviewAt: "",
      lastRating: 2,
      reviewCount: 2,
      errorCount: 1,
      history: [],
      fsrs: null
    };
    data.questions["rg-a"] = [question("rg-a", "cards/old.md")];
    archiveCard(data, "cards/old.md", "out-of-scope");

    expect(updateSourcePath(data, "cards/old.md", "cards/new.md")).toBe("rg-a");
    expect(data.archived["rg-a"].sourcePath).toBe("cards/new.md");
    expect(data.archived["rg-a"].record?.sourcePath).toBe("cards/new.md");
    expect(data.archived["rg-a"].questions[0].sourcePath).toBe("cards/new.md");
  });
});
