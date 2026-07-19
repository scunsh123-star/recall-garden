import { describe, expect, it } from "vitest";
import {
  CardDraft,
  buildBasesDashboard,
  buildCardMarkdown,
  buildUniqueCardPath,
  isRecallCardType,
  parseExamYearsInput,
  validateCardDraft
} from "../src/authoring";
import {
  findShortAnswer,
  findStandardAnswer,
  isCompleteEightSectionCard,
  parseLevelTwoSections
} from "../src/core";

function draft(overrides: Partial<CardDraft> = {}): CardDraft {
  return {
    kind: "definition",
    topic: "Photosynthesis",
    subject: "Biology",
    module: "Cell Biology",
    examYears: [2024, 2022],
    frequency: "中高频",
    status: "待背诵",
    reviewPriority: "A",
    ...overrides
  };
}

describe("原生八段式制卡", () => {
  it("识别通用卡片类型并兼容旧版类型", () => {
    expect(isRecallCardType("recall-card")).toBe(true);
    expect(isRecallCardType("study-card")).toBe(true);
    expect(isRecallCardType("学习卡")).toBe(true);
    expect(isRecallCardType("名词解释")).toBe(true);
    expect(isRecallCardType("project-note")).toBe(false);
  });

  it.each([
    ["definition", "概念卡"],
    ["comparison", "对比卡"],
    ["exam-transfer", "应用迁移卡"]
  ] as const)("生成可立即进入忆园的%s模板", (kind, label) => {
    const markdown = buildCardMarkdown(draft({ kind }), "2026-07-14");
    const sections = parseLevelTwoSections(markdown);
    expect(markdown).toContain(`card_type: ${label}`);
    expect(sections.map((section) => section.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(isCompleteEightSectionCard(sections)).toBe(true);
    expect(findStandardAnswer(sections)).not.toBeNull();
    expect(findShortAnswer(sections)).not.toBeNull();
  });

  it("生成结构化YAML并规范化真题年份", () => {
    const markdown = buildCardMarkdown(draft({ examYears: [2024, 2022, 2024] }), "2026-07-14");
    expect(markdown).toContain("type: recall-card");
    expect(markdown).toContain("subject: Biology");
    expect(markdown).toContain('module: "Cell Biology"');
    expect(markdown).toContain("topic: Photosynthesis");
    expect(markdown).toContain("exam_years: [2022, 2024]");
    expect(markdown).toContain("review_priority: A");
    expect(markdown).toContain("created: 2026-07-14");
  });

  it("拒绝缺少题名、科目或模块的卡片", () => {
    expect(validateCardDraft(draft({ topic: "" }))).toContain("题名");
    expect(validateCardDraft(draft({ subject: "" }))).toContain("科目");
    expect(validateCardDraft(draft({ module: "" }))).toContain("模块");
    expect(validateCardDraft(draft())).toBeNull();
  });

  it("解析混合分隔符年份并去重排序", () => {
    expect(parseExamYearsInput("2024、2022, 2024 / 2023；无")).toEqual([2022, 2023, 2024]);
  });
});

describe("安全路径与重名处理", () => {
  it("按扫描目录、模块和题名生成路径并清理非法字符", () => {
    expect(buildUniqueCardPath("Recall Garden/Cards", draft({ topic: "Supply/Demand:Comparison?" }), () => false))
      .toBe("Recall Garden/Cards/Cell Biology/card-Supply·Demand·Comparison.md");
  });

  it("已有同名文件时递增后缀而不覆盖", () => {
    const occupied = new Set([
      "Recall Garden/Cards/Cell Biology/card-Photosynthesis.md",
      "Recall Garden/Cards/Cell Biology/card-Photosynthesis-2.md"
    ]);
    expect(buildUniqueCardPath("Recall Garden/Cards", draft(), (path) => occupied.has(path)))
      .toBe("Recall Garden/Cards/Cell Biology/card-Photosynthesis-3.md");
  });
});

describe("Bases资料库", () => {
  it("生成合法YAML结构和六个复习视图", () => {
    const base = buildBasesDashboard("Recall Garden/Cards");
    expect(base).toContain("file.inFolder(\"Recall Garden/Cards\")");
    expect(base).toContain('type == "recall-card"');
    expect(base).toContain('type == "名词解释"');
    expect(base).toContain('name: "全部卡片"');
    expect(base).toContain('name: "历年真题"');
    expect(base).toContain('name: "高频卡"');
    expect(base).toContain('name: "S级优先"');
    expect(base).toContain('name: "待处理"');
    expect(base).toContain('name: "按科目"');
    expect(base).toContain("list(exam_years).length > 0");
    expect(base).toContain("/^(高频|中高频)/.matches(frequency)");
  });

  it("转义扫描文件夹中的引号，避免破坏Bases YAML", () => {
    expect(buildBasesDashboard("John's \"Cards\"")).toContain("John''s \\\"Cards\\\"");
  });
});
