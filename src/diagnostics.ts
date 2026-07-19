import type { ReviewRecord } from "./data";

const TIMEOUT_SECONDS = 90;
const SHORT_ANSWER_MAX_CHARS = 220;

export interface DiagnosticCard {
  reviewId: string;
  sourcePath: string;
  title: string;
  subject: string;
  module: string;
  frequency: string;
  examYears: number[];
  retrievability: number | null;
}

export interface CardHealthInput {
  sourcePath: string;
  reviewId: string | null;
  title: string;
  sectionNumbers: number[];
  frontmatter: Record<string, unknown>;
  shortAnswer: string | null;
  fullAnswer: string | null;
  dataQuestionIds: string[];
  noteQuestionIds: string[];
  noteQuestionBankVersion: string | null;
  expectedQuestionBankVersion: string | null;
}

export type CardHealthIssueCode =
  | "missing-sections"
  | "yaml-invalid"
  | "short-empty"
  | "short-too-long"
  | "duplicate-title"
  | "duplicate-source"
  | "deleted-ai-unsynced"
  | "question-bank-version";

export interface CardHealthIssue {
  code: CardHealthIssueCode;
  sourcePath: string;
  reviewId: string | null;
  title: string;
  detail: string;
}

export interface DiagnosticSnapshot {
  dateKey: string;
  capturedAt: string;
  currentDebt: number;
  activeCards: number;
  introducedToday: number;
}

export interface DiagnosticGroup {
  label: string;
  count: number;
  averageWeakness: number;
  reviewIds: string[];
}

export interface DiagnosticReport {
  windows: { today: number; days7: number; days30: number };
  rates: { again: number; hard: number; forgetting: number; fullReveal: number };
  averageDurationSeconds: number | null;
  timeoutCards: Array<{ reviewId: string; title: string; sourcePath: string; averageSeconds: number }>;
  retrievability: Array<{ key: string; label: string; count: number; reviewIds: string[] }>;
  weakness: {
    subject: DiagnosticGroup[];
    module: DiagnosticGroup[];
    frequency: DiagnosticGroup[];
    examYear: DiagnosticGroup[];
  };
  errorRanking: Array<{ reviewId: string; title: string; sourcePath: string; errors: number; errorRate: number }>;
  forecast30: Array<{ dateKey: string; count: number; reviewIds: string[] }>;
  newCards: { today: number; days7: number; days30: number; dailyAverage30: number };
  debt: { current: number; change7Days: number | null; change30Days: number | null };
  fullAnswerDependenceIds: string[];
}

export function buildDiagnosticReport(
  cards: readonly DiagnosticCard[],
  records: Readonly<Record<string, ReviewRecord>>,
  snapshots: readonly DiagnosticSnapshot[],
  now: Date
): DiagnosticReport {
  const todayStart = startOfLocalDay(now);
  const starts = {
    today: todayStart.getTime(),
    days7: addLocalDays(todayStart, -6).getTime(),
    days30: addLocalDays(todayStart, -29).getTime()
  };
  const attempts30 = cards.flatMap((card) => (records[card.reviewId]?.history ?? [])
    .filter((attempt) => validTime(attempt.reviewedAt) >= starts.days30)
    .map((attempt) => ({ card, attempt })));
  const attempts7 = attempts30.filter(({ attempt }) => validTime(attempt.reviewedAt) >= starts.days7);
  const attemptsToday = attempts30.filter(({ attempt }) => validTime(attempt.reviewedAt) >= starts.today);
  const durations = attempts30.flatMap(({ attempt }) => attempt.durationSeconds === null ? [] : [attempt.durationSeconds]);
  const totalFsrsReps = cards.reduce((sum, card) => sum + (records[card.reviewId]?.fsrs?.reps ?? 0), 0);
  const totalFsrsLapses = cards.reduce((sum, card) => sum + (records[card.reviewId]?.fsrs?.lapses ?? 0), 0);
  const scoreById = new Map<string, number>();
  const fullAnswerDependenceIds: string[] = [];
  const timeoutCards: DiagnosticReport["timeoutCards"] = [];

  for (const card of cards) {
    const record = records[card.reviewId];
    if (!record) continue;
    const recent = attempts30.filter((item) => item.card.reviewId === card.reviewId).map((item) => item.attempt);
    const againRate = ratio(recent.filter((attempt) => attempt.rating === 1).length, recent.length);
    const hardRate = ratio(recent.filter((attempt) => attempt.rating === 2).length, recent.length);
    const fullRate = ratio(recent.filter((attempt) => attempt.fullyRevealed).length, recent.length);
    const retrievalPenalty = card.retrievability === null ? 0 : Math.max(0, 0.9 - card.retrievability) / 0.9;
    const weakness = Math.round(Math.min(100,
      againRate * 45 + hardRate * 25 + fullRate * 20 + retrievalPenalty * 35 + (record.lastRating <= 2 ? 15 : 0)
    ));
    scoreById.set(card.reviewId, weakness);
    if (recent.length >= 2 && fullRate >= 0.5) fullAnswerDependenceIds.push(card.reviewId);
    const slow = recent.flatMap((attempt) => attempt.durationSeconds !== null && attempt.durationSeconds > TIMEOUT_SECONDS
      ? [attempt.durationSeconds]
      : []);
    if (slow.length > 0) timeoutCards.push({
      reviewId: card.reviewId,
      title: card.title,
      sourcePath: card.sourcePath,
      averageSeconds: Math.round(slow.reduce((sum, value) => sum + value, 0) / slow.length)
    });
  }

  const weakCards = cards.filter((card) => {
    const record = records[card.reviewId];
    return record && ((scoreById.get(card.reviewId) ?? 0) >= 25 || record.lastRating <= 2 || record.errorCount > 0);
  });
  const forecast30 = Array.from({ length: 30 }, (_, index) => ({
    dateKey: localDateKey(addLocalDays(todayStart, index)),
    count: 0,
    reviewIds: [] as string[]
  }));
  const forecastByDate = new Map(forecast30.map((day, index) => [day.dateKey, index]));
  let currentDebt = 0;
  for (const card of cards) {
    const due = validTime(records[card.reviewId]?.nextReviewAt ?? "");
    if (!Number.isFinite(due)) continue;
    if (due <= now.getTime()) currentDebt += 1;
    const index = due < todayStart.getTime() ? 0 : forecastByDate.get(localDateKey(new Date(due)));
    if (index !== undefined) {
      forecast30[index].reviewIds.push(card.reviewId);
      forecast30[index].count += 1;
    }
  }

  return {
    windows: { today: attemptsToday.length, days7: attempts7.length, days30: attempts30.length },
    rates: {
      again: ratio(attempts30.filter(({ attempt }) => attempt.rating === 1).length, attempts30.length),
      hard: ratio(attempts30.filter(({ attempt }) => attempt.rating === 2).length, attempts30.length),
      forgetting: ratio(totalFsrsLapses, totalFsrsReps),
      fullReveal: ratio(attempts30.filter(({ attempt }) => attempt.fullyRevealed).length, attempts30.length)
    },
    averageDurationSeconds: durations.length === 0 ? null : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
    timeoutCards: timeoutCards.sort((left, right) => right.averageSeconds - left.averageSeconds),
    retrievability: retrievabilityBuckets(cards),
    weakness: {
      subject: groupWeakness(weakCards, scoreById, (card) => [card.subject || "未分类"]),
      module: groupWeakness(weakCards, scoreById, (card) => [card.module || "未分类"]),
      frequency: groupWeakness(weakCards, scoreById, (card) => [card.frequency || "待判断"]),
      examYear: groupWeakness(weakCards, scoreById, (card) => card.examYears.length > 0 ? card.examYears.map(String) : ["非真题"])
    },
    errorRanking: cards.flatMap((card) => {
      const record = records[card.reviewId];
      return record && record.errorCount > 0 ? [{
        reviewId: card.reviewId,
        title: card.title,
        sourcePath: card.sourcePath,
        errors: record.errorCount,
        errorRate: ratio(record.errorCount, record.reviewCount)
      }] : [];
    }).sort((left, right) => right.errors - left.errors || right.errorRate - left.errorRate).slice(0, 30),
    forecast30,
    newCards: {
      today: introducedCount(records, starts.today),
      days7: introducedCount(records, starts.days7),
      days30: introducedCount(records, starts.days30),
      dailyAverage30: round(introducedCount(records, starts.days30) / 30)
    },
    debt: {
      current: currentDebt,
      change7Days: debtChange(currentDebt, snapshots, localDateKey(addLocalDays(todayStart, -7))),
      change30Days: debtChange(currentDebt, snapshots, localDateKey(addLocalDays(todayStart, -30)))
    },
    fullAnswerDependenceIds
  };
}

export function inspectCardHealth(inputs: readonly CardHealthInput[]): CardHealthIssue[] {
  const issues: CardHealthIssue[] = [];
  for (const input of inputs) {
    const add = (code: CardHealthIssueCode, detail: string) => issues.push({
      code,
      sourcePath: input.sourcePath,
      reviewId: input.reviewId,
      title: input.title,
      detail
    });
    const present = new Set(input.sectionNumbers);
    const expectsEightSections = validYamlValue(input.frontmatter.card_type) || present.has(7) || present.has(8);
    const expectedSections = expectsEightSections ? [1, 2, 3, 4, 5, 6, 7, 8] : [1, 2, 3, 4, 5, 6];
    const missing = expectedSections.filter((number) => !present.has(number));
    if (missing.length > 0) add("missing-sections", `缺少第 ${missing.join("、")} 段`);
    const yamlIssues = validateFrontmatter(input.frontmatter);
    if (yamlIssues.length > 0) add("yaml-invalid", yamlIssues.join("；"));
    if (!input.shortAnswer?.trim()) add("short-empty", "30秒版为空或缺失");
    else if (compactLength(input.shortAnswer) > SHORT_ANSWER_MAX_CHARS) {
      add("short-too-long", `30秒版 ${compactLength(input.shortAnswer)} 字，建议不超过 ${SHORT_ANSWER_MAX_CHARS} 字`);
    }
    const noteIds = new Set(input.noteQuestionIds);
    const dataIds = new Set(input.dataQuestionIds);
    const deleted = input.noteQuestionIds.filter((id) => !dataIds.has(id));
    if (deleted.length > 0) add("deleted-ai-unsynced", `原笔记仍保留 ${deleted.length} 道已从忆园删除的题`);
    const hasQuestionBank = noteIds.size > 0 || dataIds.size > 0 || input.noteQuestionBankVersion !== null;
    const idsMatch = noteIds.size === dataIds.size && [...noteIds].every((id) => dataIds.has(id));
    if (hasQuestionBank && (!idsMatch || input.noteQuestionBankVersion !== input.expectedQuestionBankVersion)) {
      add("question-bank-version", "原笔记题库与忆园当前题库版本不一致，请重新同步");
    }
  }
  addDuplicateIssues(inputs, issues, "title", "duplicate-title", "重复题名");
  addDuplicateIssues(inputs.filter((input) => input.reviewId !== null), issues, "reviewId", "duplicate-source", "同一稳定ID对应多个来源");
  return issues;
}

function retrievabilityBuckets(cards: readonly DiagnosticCard[]): DiagnosticReport["retrievability"] {
  const buckets = [
    { key: "under-70", label: "低于70%", minimum: 0, maximum: 0.7, reviewIds: [] as string[] },
    { key: "70-85", label: "70%—85%", minimum: 0.7, maximum: 0.85, reviewIds: [] as string[] },
    { key: "85-90", label: "85%—90%", minimum: 0.85, maximum: 0.9, reviewIds: [] as string[] },
    { key: "90-plus", label: "90%以上", minimum: 0.9, maximum: Number.POSITIVE_INFINITY, reviewIds: [] as string[] }
  ];
  for (const card of cards) {
    if (card.retrievability === null) continue;
    const bucket = buckets.find((item) => card.retrievability! >= item.minimum && card.retrievability! < item.maximum);
    if (bucket) bucket.reviewIds.push(card.reviewId);
  }
  return buckets.map(({ key, label, reviewIds }) => ({ key, label, count: reviewIds.length, reviewIds }));
}

function groupWeakness(
  cards: readonly DiagnosticCard[],
  scores: ReadonlyMap<string, number>,
  labels: (card: DiagnosticCard) => string[]
): DiagnosticGroup[] {
  const groups = new Map<string, { ids: string[]; score: number }>();
  for (const card of cards) {
    for (const label of labels(card)) {
      const group = groups.get(label) ?? { ids: [], score: 0 };
      group.ids.push(card.reviewId);
      group.score += scores.get(card.reviewId) ?? 0;
      groups.set(label, group);
    }
  }
  return [...groups.entries()].map(([label, group]) => ({
    label,
    count: group.ids.length,
    averageWeakness: Math.round(group.score / group.ids.length),
    reviewIds: group.ids
  })).sort((left, right) => right.averageWeakness - left.averageWeakness || right.count - left.count || left.label.localeCompare(right.label, "zh-CN"));
}

function validateFrontmatter(frontmatter: Record<string, unknown>): string[] {
  const issues: string[] = [];
  for (const key of ["subject", "module", "frequency", "status"] as const) {
    if (!validYamlValue(frontmatter[key])) issues.push(`${key} 为空`);
  }
  const priority = frontmatter.review_priority;
  if (priority !== undefined && (typeof priority !== "string" || !["S", "A", "B", "C"].includes(priority.trim().toUpperCase()))) {
    issues.push("review_priority 应为 S/A/B/C");
  }
  return issues;
}

function validYamlValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0 && value.some(validYamlValue);
  return false;
}

function addDuplicateIssues(
  inputs: readonly CardHealthInput[],
  issues: CardHealthIssue[],
  key: "title" | "reviewId",
  code: CardHealthIssueCode,
  detail: string
): void {
  const groups = new Map<string, CardHealthInput[]>();
  for (const input of inputs) {
    const raw = input[key];
    const normalized = typeof raw === "string" ? raw.trim().toLocaleLowerCase("zh-CN") : "";
    if (!normalized) continue;
    const group = groups.get(normalized) ?? [];
    group.push(input);
    groups.set(normalized, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const input of group) issues.push({ code, sourcePath: input.sourcePath, reviewId: input.reviewId, title: input.title, detail });
  }
}

function introducedCount(records: Readonly<Record<string, ReviewRecord>>, start: number): number {
  return Object.values(records).filter((record) => validTime(record.introducedAt) >= start).length;
}

function debtChange(current: number, snapshots: readonly DiagnosticSnapshot[], dateKey: string): number | null {
  const baseline = snapshots.find((snapshot) => snapshot.dateKey === dateKey);
  return baseline ? current - baseline.currentDebt : null;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? round(numerator / denominator) : 0;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function compactLength(value: string): number {
  return value.replace(/\s+/g, "").length;
}

function validTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addLocalDays(value: Date, days: number): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days);
}

function localDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
