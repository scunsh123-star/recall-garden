import { describe, expect, it } from "vitest";
import type { ReviewRecord } from "../src/data";
import {
  buildDiagnosticReport,
  inspectCardHealth,
  type DiagnosticCard,
  type DiagnosticSnapshot
} from "../src/diagnostics";

const now = new Date("2026-07-14T12:00:00+08:00");

function card(reviewId: string, overrides: Partial<DiagnosticCard> = {}): DiagnosticCard {
  return {
    reviewId,
    sourcePath: `cards/${reviewId}.md`,
    title: reviewId,
    subject: "Biology",
    module: "Cell Biology",
    frequency: "高频",
    examYears: [2024],
    retrievability: 0.82,
    ...overrides
  };
}

function record(reviewId: string, overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    reviewId,
    sourcePath: `cards/${reviewId}.md`,
    stage: 3,
    introducedAt: "2026-07-10T08:00:00+08:00",
    lastReviewedAt: "2026-07-14T10:00:00+08:00",
    nextReviewAt: "2026-07-15T08:00:00+08:00",
    lastRating: 2,
    reviewCount: 3,
    errorCount: 1,
    history: [
      { reviewedAt: "2026-07-14T10:00:00+08:00", rating: 1, revealLevel: 2, fullyRevealed: true, durationSeconds: 120 },
      { reviewedAt: "2026-07-12T10:00:00+08:00", rating: 2, revealLevel: 1, fullyRevealed: false, durationSeconds: 40 },
      { reviewedAt: "2026-06-01T10:00:00+08:00", rating: 3, revealLevel: 0, fullyRevealed: false, durationSeconds: 20 }
    ],
    fsrs: {
      due: "2026-07-15T08:00:00+08:00",
      stability: 5,
      difficulty: 7,
      elapsedDays: 1,
      scheduledDays: 2,
      learningSteps: 0,
      reps: 10,
      lapses: 2,
      state: 2,
      lastReview: "2026-07-14T10:00:00+08:00"
    },
    ...overrides
  };
}

describe("可行动诊断", () => {
  it("统计今日、7天、30天行为率、FSRS可提取率和超时卡", () => {
    const report = buildDiagnosticReport([card("weak")], { weak: record("weak") }, [], now);

    expect(report.windows).toMatchObject({ today: 1, days7: 2, days30: 2 });
    expect(report.rates).toMatchObject({ again: 0.5, hard: 0.5, fullReveal: 0.5, forgetting: 0.2 });
    expect(report.averageDurationSeconds).toBe(80);
    expect(report.timeoutCards.map((item) => item.reviewId)).toEqual(["weak"]);
    expect(report.retrievability.find((bucket) => bucket.key === "70-85")?.count).toBe(1);
  });

  it("按科目、模块、频次和真题年份聚合薄弱卡，且返回可直接生成队列的reviewId", () => {
    const report = buildDiagnosticReport([
      card("weak"),
      card("good", { module: "Genetics", frequency: "低频", examYears: [] })
    ], {
      weak: record("weak"),
      good: record("good", { lastRating: 4, errorCount: 0, history: [], fsrs: null })
    }, [], now);

    const module = report.weakness.module.find((item) => item.label === "Cell Biology");
    expect(module?.reviewIds).toEqual(["weak"]);
    expect(report.errorRanking[0]).toMatchObject({ reviewId: "weak", errors: 1 });
    expect(report.fullAnswerDependenceIds).toEqual(["weak"]);
  });

  it("生成未来30天逐日负担和具体卡片；债务趋势没有历史基线时保持未知", () => {
    const snapshots: DiagnosticSnapshot[] = [{
      dateKey: "2026-07-14",
      capturedAt: now.toISOString(),
      currentDebt: 1,
      activeCards: 2,
      introducedToday: 0
    }];
    const report = buildDiagnosticReport([
      card("overdue"),
      card("future")
    ], {
      overdue: record("overdue", { nextReviewAt: "2026-07-13T08:00:00+08:00" }),
      future: record("future", { nextReviewAt: "2026-07-20T08:00:00+08:00" })
    }, snapshots, now);

    expect(report.forecast30[0].reviewIds).toEqual(["overdue"]);
    expect(report.forecast30.find((day) => day.dateKey === "2026-07-20")?.reviewIds).toEqual(["future"]);
    expect(report.debt.current).toBe(1);
    expect(report.debt.change7Days).toBeNull();
  });
});

describe("卡片体检", () => {
  it("识别缺段、YAML异常、30秒版为空或过长、重复题名与重复稳定来源", () => {
    const issues = inspectCardHealth([
      {
        sourcePath: "cards/a.md",
        reviewId: "same-id",
        title: "Photosynthesis",
        sectionNumbers: [1, 2, 3, 8],
        frontmatter: { type: "recall-card", subject: "", module: "Cell Biology", frequency: "高频", status: "已整理", review_priority: "Z" },
        shortAnswer: "",
        fullAnswer: "标准答案",
        dataQuestionIds: [],
        noteQuestionIds: [],
        noteQuestionBankVersion: null,
        expectedQuestionBankVersion: null
      },
      {
        sourcePath: "cards/b.md",
        reviewId: "same-id",
        title: "Photosynthesis",
        sectionNumbers: [1, 2, 3, 4, 5, 6, 7, 8],
        frontmatter: { type: "recall-card", subject: "Biology", module: "Cell Biology", frequency: "高频", status: "已整理", review_priority: "A" },
        shortAnswer: "长".repeat(221),
        fullAnswer: "标准答案",
        dataQuestionIds: [],
        noteQuestionIds: [],
        noteQuestionBankVersion: null,
        expectedQuestionBankVersion: null
      }
    ]);

    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "missing-sections", "yaml-invalid", "short-empty", "short-too-long", "duplicate-title", "duplicate-source"
    ]));
  });

  it("区分已删除AI题仍留在原笔记与题库版本不一致", () => {
    const issues = inspectCardHealth([{
      sourcePath: "cards/a.md",
      reviewId: "rg-a",
      title: "Photosynthesis",
      sectionNumbers: [1, 2, 3, 4, 5, 6, 7, 8],
      frontmatter: { type: "recall-card", subject: "Biology", module: "Cell Biology", frequency: "高频", status: "已整理", review_priority: "A" },
      shortAnswer: "短答案",
      fullAnswer: "标准答案",
      dataQuestionIds: ["kept"],
      noteQuestionIds: ["kept", "deleted"],
      noteQuestionBankVersion: "old",
      expectedQuestionBankVersion: "new"
    }]);

    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "deleted-ai-unsynced", "question-bank-version"
    ]));
  });

  it("YAML科目允许数字或非空数组，不把数字subject误报为异常", () => {
    const issues = inspectCardHealth([{
      sourcePath: "cards/a.md",
      reviewId: "rg-a",
      title: "Derivative",
      sectionNumbers: [1, 2, 3, 4, 5, 6, 7, 8],
      frontmatter: { type: "recall-card", subject: 101, module: ["Calculus"], frequency: "高频", status: "已整理", review_priority: "A" },
      shortAnswer: "短答案",
      fullAnswer: "标准答案",
      dataQuestionIds: [],
      noteQuestionIds: [],
      noteQuestionBankVersion: null,
      expectedQuestionBankVersion: null
    }]);

    expect(issues.find((issue) => issue.code === "yaml-invalid")).toBeUndefined();
  });

  it("没有card_type的完整旧版六段式不误报第7、8段，已声明新版模板时仍按八段检查", () => {
    const base = {
      sourcePath: "cards/legacy.md",
      reviewId: "rg-legacy",
      title: "食物链",
      sectionNumbers: [1, 2, 3, 4, 5, 6],
      frontmatter: { type: "recall-card", subject: "Biology", module: "Ecology", frequency: "高频", status: "已整理" },
      shortAnswer: "短答案",
      fullAnswer: "标准答案",
      dataQuestionIds: [] as string[],
      noteQuestionIds: [] as string[],
      noteQuestionBankVersion: null,
      expectedQuestionBankVersion: null
    };

    expect(inspectCardHealth([base]).find((issue) => issue.code === "missing-sections")).toBeUndefined();
    expect(inspectCardHealth([{ ...base, frontmatter: { ...base.frontmatter, card_type: "概念卡" } }]))
      .toContainEqual(expect.objectContaining({ code: "missing-sections", detail: "缺少第 7、8 段" }));
  });
});
