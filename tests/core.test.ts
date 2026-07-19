import { describe, expect, it } from "vitest";
import {
  INTERVAL_MINUTES,
  RATING_CRITERIA,
  computeSchedule,
  findShortAnswer,
  findStandardAnswer,
  formatInterval,
  isCompleteEightSectionCard,
  parseLevelTwoSections
} from "../src/core";

describe("8段式解析", () => {
  it("按二级标题切分1至8段并保留正文边界", () => {
    const markdown = Array.from({ length: 8 }, (_, index) => `## ${index + 1}. 第${index + 1}段\n\n正文${index + 1}`).join("\n\n");
    const sections = parseLevelTwoSections(markdown);
    expect(sections.map((section) => section.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(sections[0]).toMatchObject({ title: "第1段", body: "正文1" });
    expect(sections[7]).toMatchObject({ title: "第8段", body: "正文8" });
    expect(isCompleteEightSectionCard(sections)).toBe(true);
  });

  it("缺少任意编号时不判定为完整8段式", () => {
    const sections = parseLevelTwoSections("## 1. 一\n甲\n## 8. 八\n乙");
    expect(isCompleteEightSectionCard(sections)).toBe(false);
  });
});
describe("答案识别", () => {
  it.each(["30秒版", "30 秒默写版", "30秒答题版", "30秒复习版"])("识别 %s", (title) => {
    const sections = parseLevelTwoSections(`## ${title}\n\n短答案`);
    expect(findShortAnswer(sections)).toBe("短答案");
  });

  it.each(["标准答题版", "标准答案", "完整答案"])("识别 %s", (title) => {
    const sections = parseLevelTwoSections(`## ${title}\n\n完整正文`);
    expect(findStandardAnswer(sections)).toBe("完整正文");
  });
});

describe("四级评分与阶段边界", () => {
  const now = new Date("2026-07-13T00:00:00.000Z");

  it("新卡良好进入第0阶段", () => {
    expect(computeSchedule(null, 3, now)).toMatchObject({ stage: 0, intervalMinutes: 20 });
  });

  it("新卡轻松跳至第1阶段", () => {
    expect(computeSchedule(null, 4, now)).toMatchObject({ stage: 1, intervalMinutes: 1_440 });
  });

  it("重来降低两个阶段并在10分钟后重排", () => {
    expect(computeSchedule(5, 1, now)).toMatchObject({ stage: 3, intervalMinutes: 10 });
  });

  it("困难降低一个阶段并使用该阶段60%的间隔", () => {
    expect(computeSchedule(5, 2, now)).toMatchObject({ stage: 4, intervalMinutes: 6_048 });
  });

  it("最高阶段不会越过间隔表末端", () => {
    const highest = INTERVAL_MINUTES.length - 1;
    expect(computeSchedule(highest, 3, now)).toMatchObject({ stage: highest, intervalMinutes: 86_400 });
    expect(computeSchedule(highest, 4, now)).toMatchObject({ stage: highest, intervalMinutes: 86_400 });
  });

  it("按分钟精确计算下一次复习时间", () => {
    expect(computeSchedule(null, 3, now).dueAt).toBe("2026-07-13T00:20:00.000Z");
  });

  it("固定四级评分口径，避免看完答案后的熟悉感虚高", () => {
    expect(RATING_CRITERIA.map((item) => [item.rating, item.label, item.description])).toEqual([
      [1, "重来", "定义或核心机制答错"],
      [2, "困难", "知道主题，但漏关键机制"],
      [3, "良好", "定义和主体结构完整"],
      [4, "轻松", "能辨析、迁移且无需提示"]
    ]);
  });
});

describe("间隔格式化", () => {
  it.each([
    [20, "20分钟"],
    [120, "2小时"],
    [1_440, "1天"],
    [21_600, "15天"]
  ])("将 %i 分钟格式化为 %s", (minutes, expected) => {
    expect(formatInterval(minutes)).toBe(expected);
  });
});
