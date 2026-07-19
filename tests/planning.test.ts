import { describe, expect, it } from "vitest";
import type { DueForecast } from "../src/queue";
import {
  DailyPlanInput,
  buildDailyPlanDocument,
  upsertDailyPlan
} from "../src/planning";

function input(overrides: Partial<DailyPlanInput> = {}): DailyPlanInput {
  const forecast: DueForecast = {
    days: [
      { dateKey: "2026-07-14", scheduledDue: 8, plannedNewCards: 5, minimumLoad: 13 },
      { dateKey: "2026-07-15", scheduledDue: 12, plannedNewCards: 5, minimumLoad: 17 }
    ],
    totalScheduledDue: 20,
    currentDebt: 3,
    risk: "medium",
    warning: "未来两天存在回流高峰。"
  };
  return {
    dateKey: "2026-07-14",
    dueCount: 8,
    newCount: 5,
    weakCount: 4,
    forecast,
    ...overrides
  };
}

describe("忆园每日学习计划", () => {
  it("生成普通 Markdown 可用、同时兼容 Tasks 日期与优先级语法的计划", () => {
    const markdown = buildDailyPlanDocument(input());

    expect(markdown).toContain("# 忆园学习计划 · 2026-07-14");
    expect(markdown).toContain("- [ ] 完成忆园今日调度（到期 8 张 · 新卡 5 张） #忆园/调度 ⏫ 📅 2026-07-14");
    expect(markdown).toContain("- [ ] 自由复习薄弱卡（建议 4 张） #忆园/薄弱 🔼 📅 2026-07-14");
    expect(markdown).toContain("| 07-15 | 12 | 5 | 17 |");
    expect(markdown).toContain("勾选任务不会代替忆园四级评分");
  });

  it("重复更新会刷新数量，并保留用户已经勾选的任务", () => {
    const original = buildDailyPlanDocument(input())
      .replace("- [ ] 完成忆园今日调度", "- [x] 完成忆园今日调度")
      .replace("- [ ] 写一句今日复盘", "- [X] 写一句今日复盘");
    const updated = upsertDailyPlan(original, input({ dueCount: 2, newCount: 0, weakCount: 7 }));

    expect(updated).toContain("- [x] 完成忆园今日调度（到期 2 张 · 新卡 0 张）");
    expect(updated).toContain("- [X] 写一句今日复盘");
    expect(updated).toContain("自由复习薄弱卡（建议 7 张）");
  });

  it("只替换受忆园管理的区块，不覆盖区块外的手写内容", () => {
    const original = `${buildDailyPlanDocument(input())}\n我的手写补充：明天重点看水文。\n`;
    const updated = upsertDailyPlan(original, input({ dueCount: 1 }));

    expect(updated).toContain("我的手写补充：明天重点看水文。");
    expect(updated.match(/<!-- recall-garden:plan:start -->/g)).toHaveLength(1);
    expect(updated).toContain("到期 1 张");
  });
});
