export const DEFAULT_EXAM_NAME = "2026 年 12 月考试";
export const DEFAULT_EXAM_START_DATE = "2026-12-19";
export const DEFAULT_EXAM_END_DATE = "2026-12-20";

export interface ExamCountdownConfig {
  name: string;
  startDate: string;
  endDate: string;
}

export interface ExamCountdown {
  name: string;
  status: "upcoming" | "active" | "ended";
  value: string;
  unit: string;
  dateLabel: string;
  detail: string;
  remaining: ExamCountdownRemaining | null;
}

export interface ExamCountdownRemaining {
  totalSeconds: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
  serial: number;
}

export function buildExamCountdown(config: ExamCountdownConfig, now = new Date()): ExamCountdown | null {
  const start = parseDateKey(config.startDate);
  const requestedEnd = parseDateKey(config.endDate);
  if (!start || !requestedEnd) return null;
  const end = requestedEnd.serial < start.serial ? start : requestedEnd;
  const todaySerial = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const startTime = new Date(start.year, start.month - 1, start.day).getTime();
  const endExclusiveTime = new Date(end.year, end.month - 1, end.day + 1).getTime();
  const name = config.name.trim() || DEFAULT_EXAM_NAME;
  const dateLabel = formatDateRange(start, end);

  if (now.getTime() < startTime) {
    const remaining = splitRemainingSeconds(Math.ceil((startTime - now.getTime()) / 1000));
    return {
      name,
      status: "upcoming",
      value: String(remaining.days),
      unit: "天",
      dateLabel,
      detail: "距离开考 · 按设备本地时间每秒更新",
      remaining
    };
  }

  if (now.getTime() < endExclusiveTime) {
    const totalDays = daysBetween(start.serial, end.serial) + 1;
    const currentDay = daysBetween(start.serial, todaySerial) + 1;
    return {
      name,
      status: "active",
      value: "进行中",
      unit: `第 ${currentDay}/${totalDays} 天`,
      dateLabel,
      detail: "按计划完成今天，保持清醒和节奏。",
      remaining: null
    };
  }

  return {
    name,
    status: "ended",
    value: "已结束",
    unit: `${daysBetween(end.serial, todaySerial)} 天`,
    dateLabel,
    detail: "考试周期已经结束，记得留下复盘证据。",
    remaining: null
  };
}

export function normalizeExamDateKey(value: unknown, fallback: string): string {
  return typeof value === "string" && parseDateKey(value) ? value : fallback;
}

function parseDateKey(value: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const serial = Date.UTC(year, month - 1, day);
  const date = new Date(serial);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day, serial };
}

function formatDateRange(start: CalendarDate, end: CalendarDate): string {
  if (start.serial === end.serial) return `${start.year} 年 ${start.month} 月 ${start.day} 日`;
  if (start.year === end.year && start.month === end.month) {
    return `${start.year} 年 ${start.month} 月 ${start.day}—${end.day} 日`;
  }
  if (start.year === end.year) {
    return `${start.year} 年 ${start.month} 月 ${start.day} 日—${end.month} 月 ${end.day} 日`;
  }
  return `${start.year} 年 ${start.month} 月 ${start.day} 日—${end.year} 年 ${end.month} 月 ${end.day} 日`;
}

function daysBetween(earlier: number, later: number): number {
  return Math.round((later - earlier) / 86_400_000);
}

function splitRemainingSeconds(totalSeconds: number): ExamCountdownRemaining {
  const safeTotal = Math.max(0, totalSeconds);
  const days = Math.floor(safeTotal / 86_400);
  const afterDays = safeTotal % 86_400;
  const hours = Math.floor(afterDays / 3_600);
  const afterHours = afterDays % 3_600;
  const minutes = Math.floor(afterHours / 60);
  const seconds = afterHours % 60;
  return { totalSeconds: safeTotal, days, hours, minutes, seconds };
}
