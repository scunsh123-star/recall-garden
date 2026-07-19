import type { DueForecast } from "./queue";

export const DAILY_PLAN_START = "<!-- recall-garden:plan:start -->";
export const DAILY_PLAN_END = "<!-- recall-garden:plan:end -->";

export interface DailyPlanInput {
  dateKey: string;
  dueCount: number;
  newCount: number;
  weakCount: number;
  forecast: DueForecast;
}

type TaskKey = "调度" | "薄弱" | "复盘";
type TaskChecks = Partial<Record<TaskKey, " " | "x" | "X">>;

export function buildDailyPlanDocument(input: DailyPlanInput): string {
  return [
    "---",
    "type: recall-garden-plan",
    `date: ${input.dateKey}`,
    "tags:",
    "  - 忆园/学习计划",
    "---",
    "",
    `# 忆园学习计划 · ${input.dateKey}`,
    "",
    buildManagedBlock(input, {}),
    "",
    "## 我的复盘",
    "",
    "- 最容易忘：",
    "- 明天优先看：",
    ""
  ].join("\n");
}

export function upsertDailyPlan(existing: string, input: DailyPlanInput): string {
  if (!existing.trim()) return buildDailyPlanDocument(input);

  const start = existing.indexOf(DAILY_PLAN_START);
  const end = existing.indexOf(DAILY_PLAN_END, start + DAILY_PLAN_START.length);
  const oldManagedBlock = start >= 0 && end >= 0
    ? existing.slice(start, end + DAILY_PLAN_END.length)
    : "";
  const replacement = buildManagedBlock(input, extractTaskChecks(oldManagedBlock));

  if (start >= 0 && end >= 0) {
    return `${existing.slice(0, start)}${replacement}${existing.slice(end + DAILY_PLAN_END.length)}`;
  }
  return `${existing.trimEnd()}\n\n${replacement}\n`;
}

function buildManagedBlock(input: DailyPlanInput, checks: TaskChecks): string {
  const forecast = input.forecast;
  const lines = [
    DAILY_PLAN_START,
    "## 今日任务",
    "",
    "> [!important] 调度边界",
    "> 任务清单负责计划与提醒；勾选任务不会代替忆园四级评分，也不会修改 FSRS 下次复习时间。",
    "",
    taskLine(checks.调度, `完成忆园今日调度（到期 ${input.dueCount} 张 · 新卡 ${input.newCount} 张）`, "#忆园/调度", "⏫", input.dateKey)
  ];

  if (input.weakCount > 0) {
    lines.push(taskLine(checks.薄弱, `自由复习薄弱卡（建议 ${input.weakCount} 张）`, "#忆园/薄弱", "🔼", input.dateKey));
  }
  lines.push(taskLine(checks.复盘, "写一句今日复盘", "#忆园/复盘", "🔽", input.dateKey));
  lines.push(
    "",
    `> [!${forecast.risk === "high" ? "danger" : forecast.risk === "medium" ? "warning" : "success"}] 未来 7 天 · ${riskLabel(forecast.risk)}`,
    `> ${forecast.warning}`,
    "",
    "## 未来 7 天负担",
    "",
    "| 日期 | 到期 | 计划新卡 | 最低负担 |",
    "| --- | ---: | ---: | ---: |"
  );
  for (const day of forecast.days) {
    lines.push(`| ${day.dateKey.slice(5)} | ${day.scheduledDue} | ${day.plannedNewCards} | ${day.minimumLoad} |`);
  }
  lines.push(
    "",
    `当前复习债务：**${forecast.currentDebt}** 张 · 7 天已排定到期：**${forecast.totalScheduledDue}** 张。`,
    DAILY_PLAN_END
  );
  return lines.join("\n");
}

function taskLine(
  check: " " | "x" | "X" | undefined,
  description: string,
  tag: `#忆园/${TaskKey}`,
  priority: "⏫" | "🔼" | "🔽",
  dateKey: string
): string {
  return `- [${check ?? " "}] ${description} ${tag} ${priority} 📅 ${dateKey}`;
}

function extractTaskChecks(markdown: string): TaskChecks {
  const checks: TaskChecks = {};
  for (const key of ["调度", "薄弱", "复盘"] as const) {
    const escapedTag = `#忆园/${key}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = markdown.match(new RegExp(`^- \\[([ xX])\\].*${escapedTag}(?:\\s|$)`, "m"));
    if (match) checks[key] = match[1] as " " | "x" | "X";
  }
  return checks;
}

function riskLabel(risk: DueForecast["risk"]): string {
  return risk === "high" ? "负担偏高" : risk === "medium" ? "注意回流" : "负担可控";
}
