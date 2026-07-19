import { ReviewRecord } from "./data";

export type ReviewPriority = "S" | "A" | "B" | "C";
export type QueueReason = "overdue" | "wrong" | "exam" | "high-frequency" | "due" | "new";
export type ForecastRisk = "low" | "medium" | "high";

export interface QueueCardMetadata {
  reviewId: string;
  examYears: number[];
  frequency: string;
  status: string;
  reviewPriority: ReviewPriority | null;
}

export interface QueueBuildOptions {
  now: Date;
  dailyNewCards: number;
  dailyReviewLimit: number;
  pauseNewCards: boolean;
}

export interface PrioritizedQueueItem<T extends QueueCardMetadata> {
  card: T;
  reason: QueueReason;
}

export interface DueForecastOptions extends QueueBuildOptions {
  days: number;
}

export interface DueForecastDay {
  dateKey: string;
  scheduledDue: number;
  plannedNewCards: number;
  minimumLoad: number;
}

export interface DueForecast {
  days: DueForecastDay[];
  totalScheduledDue: number;
  currentDebt: number;
  risk: ForecastRisk;
  warning: string;
}

const REASON_ORDER: Record<QueueReason, number> = {
  overdue: 0,
  wrong: 1,
  exam: 2,
  "high-frequency": 3,
  due: 4,
  new: 5
};

const PRIORITY_ORDER: Record<ReviewPriority, number> = { S: 4, A: 3, B: 2, C: 1 };

export function normalizeExamYears(value: unknown): number[] {
  const values = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  const years = new Set<number>();
  for (const item of values) {
    if (typeof item === "number" && Number.isInteger(item) && item >= 1900 && item <= 2100) {
      years.add(item);
      continue;
    }
    if (typeof item !== "string") continue;
    for (const match of item.matchAll(/(?:19|20)\d{2}/g)) years.add(Number(match[0]));
  }
  return [...years].sort((left, right) => left - right);
}

export function normalizeReviewPriority(value: unknown): ReviewPriority | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return normalized === "S" || normalized === "A" || normalized === "B" || normalized === "C" ? normalized : null;
}

export function frequencyRank(value: string): number {
  const normalized = value.trim();
  if (/^高频/.test(normalized)) return 3;
  if (/^中高频/.test(normalized)) return 2;
  if (/^中频/.test(normalized)) return 1;
  return 0;
}

export function buildPrioritizedQueue<T extends QueueCardMetadata>(
  cards: readonly T[],
  records: Readonly<Record<string, ReviewRecord>>,
  options: QueueBuildOptions
): Array<PrioritizedQueueItem<T>> {
  const nowTime = options.now.getTime();
  const todayStart = startOfLocalDay(options.now).getTime();
  const due: Array<PrioritizedQueueItem<T>> = [];
  const fresh: Array<PrioritizedQueueItem<T>> = [];

  for (const card of cards) {
    const record = records[card.reviewId];
    if (!record) {
      fresh.push({ card, reason: "new" });
      continue;
    }
    const dueTime = Date.parse(record.nextReviewAt);
    if (!Number.isFinite(dueTime) || dueTime > nowTime) continue;
    due.push({ card, reason: queueReason(card, record, dueTime, todayStart) });
  }

  due.sort((left, right) => compareQueueItems(left, right, records));
  fresh.sort((left, right) => compareQueueItems(left, right, records));

  const introducedToday = Object.values(records).filter((record) =>
    localDateKey(new Date(record.introducedAt)) === localDateKey(options.now)
  ).length;
  const remainingNewSlots = options.pauseNewCards
    ? 0
    : Math.max(0, options.dailyNewCards - introducedToday);
  return [...due, ...fresh.slice(0, remainingNewSlots)].slice(0, options.dailyReviewLimit);
}

export function buildDueForecast(
  records: Readonly<Record<string, ReviewRecord>>,
  activeReviewIds: ReadonlySet<string>,
  options: DueForecastOptions
): DueForecast {
  const days = Math.max(1, Math.floor(options.days));
  const todayStart = startOfLocalDay(options.now);
  const buckets = Array.from({ length: days }, (_, index) => {
    const date = addLocalDays(todayStart, index);
    return {
      dateKey: localDateKey(date),
      scheduledDue: 0,
      plannedNewCards: options.pauseNewCards ? 0 : options.dailyNewCards,
      minimumLoad: 0
    };
  });
  const bucketByDate = new Map(buckets.map((day, index) => [day.dateKey, index]));
  let currentDebt = 0;
  let introducedToday = 0;

  for (const reviewId of activeReviewIds) {
    const record = records[reviewId];
    if (!record) continue;
    if (localDateKey(new Date(record.introducedAt)) === localDateKey(options.now)) introducedToday += 1;
    const dueTime = Date.parse(record.nextReviewAt);
    if (!Number.isFinite(dueTime)) continue;
    if (dueTime <= options.now.getTime()) currentDebt += 1;
    const dueDate = new Date(dueTime);
    const index = dueTime < todayStart.getTime() ? 0 : bucketByDate.get(localDateKey(dueDate));
    if (index !== undefined) buckets[index].scheduledDue += 1;
  }

  if (!options.pauseNewCards) {
    buckets[0].plannedNewCards = Math.max(0, options.dailyNewCards - introducedToday);
  }

  for (const day of buckets) day.minimumLoad = day.scheduledDue + day.plannedNewCards;
  const totalScheduledDue = buckets.reduce((sum, day) => sum + day.scheduledDue, 0);
  const peakLoad = Math.max(...buckets.map((day) => day.minimumLoad));
  const risk = forecastRisk(currentDebt, peakLoad, options.dailyNewCards, options.dailyReviewLimit, options.pauseNewCards);
  return {
    days: buckets,
    totalScheduledDue,
    currentDebt,
    risk,
    warning: forecastWarning(risk, options.dailyNewCards, options.pauseNewCards, currentDebt, options.dailyReviewLimit)
  };
}

function queueReason(card: QueueCardMetadata, record: ReviewRecord, dueTime: number, todayStart: number): QueueReason {
  if (dueTime < todayStart) return "overdue";
  if (isWeakRecord(record)) return "wrong";
  if (card.examYears.length > 0) return "exam";
  if (frequencyRank(card.frequency) >= 2) return "high-frequency";
  return "due";
}

function isWeakRecord(record: ReviewRecord): boolean {
  if (record.lastRating === 1) return true;
  return record.reviewCount >= 2 && record.errorCount / record.reviewCount >= 0.4;
}

function compareQueueItems<T extends QueueCardMetadata>(
  left: PrioritizedQueueItem<T>,
  right: PrioritizedQueueItem<T>,
  records: Readonly<Record<string, ReviewRecord>>
): number {
  const reasonDifference = REASON_ORDER[left.reason] - REASON_ORDER[right.reason];
  if (reasonDifference !== 0) return reasonDifference;
  const priorityDifference = priorityRank(right.card.reviewPriority) - priorityRank(left.card.reviewPriority);
  if (priorityDifference !== 0) return priorityDifference;
  const errorDifference = errorRate(records[right.card.reviewId]) - errorRate(records[left.card.reviewId]);
  if (errorDifference !== 0) return errorDifference;
  const examDifference = right.card.examYears.length - left.card.examYears.length;
  if (examDifference !== 0) return examDifference;
  const frequencyDifference = frequencyRank(right.card.frequency) - frequencyRank(left.card.frequency);
  if (frequencyDifference !== 0) return frequencyDifference;
  const dueDifference = dueTimestamp(records[left.card.reviewId]) - dueTimestamp(records[right.card.reviewId]);
  if (dueDifference !== 0) return dueDifference;
  return left.card.reviewId.localeCompare(right.card.reviewId, "zh-CN");
}

function priorityRank(priority: ReviewPriority | null): number {
  return priority ? PRIORITY_ORDER[priority] : 0;
}

function errorRate(record: ReviewRecord | undefined): number {
  return record && record.reviewCount > 0 ? record.errorCount / record.reviewCount : 0;
}

function dueTimestamp(record: ReviewRecord | undefined): number {
  if (!record) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(record.nextReviewAt);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function forecastRisk(
  currentDebt: number,
  peakLoad: number,
  dailyNewCards: number,
  dailyReviewLimit: number,
  pauseNewCards: boolean
): ForecastRisk {
  if (currentDebt > dailyReviewLimit || peakLoad > dailyReviewLimit) return "high";
  if (!pauseNewCards && dailyNewCards >= 21) return "high";
  if (!pauseNewCards && dailyNewCards >= 15) return "medium";
  if (peakLoad >= dailyReviewLimit * 0.8) return "medium";
  return "low";
}

function forecastWarning(
  risk: ForecastRisk,
  dailyNewCards: number,
  pauseNewCards: boolean,
  currentDebt: number,
  dailyReviewLimit: number
): string {
  if (pauseNewCards) return `已暂停新卡；当前只清理 ${currentDebt} 张到期复习债务。`;
  if (currentDebt > dailyReviewLimit) return `当前已有 ${currentDebt} 张复习债务，超过单轮上限 ${dailyReviewLimit}。建议暂停新卡。`;
  if (dailyNewCards >= 21) {
    return `每日新卡 ${dailyNewCards} 张较激进；预测尚未计入 FSRS 学习、重学步骤及后续回流，实际负担会更高。`;
  }
  if (risk === "medium") return `每日新卡 ${dailyNewCards} 张可能形成回流高峰，请观察未来7天容量。`;
  return "未来7天负担目前可控。";
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
