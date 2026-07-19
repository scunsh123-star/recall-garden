export interface StudyCalendarAttempt {
  reviewedAt: string;
  rating: number;
}

export interface StudyCalendarCard {
  reviewId: string;
  nextReviewAt: string | null;
  isExam: boolean;
  history: readonly StudyCalendarAttempt[];
}

export interface StudyCalendarDebtSnapshot {
  dateKey: string;
  currentDebt: number;
}

export interface StudyCalendarDay {
  dateKey: string;
  dayNumber: number;
  inMonth: boolean;
  isToday: boolean;
  isPast: boolean;
  isFuture: boolean;
  scheduledCount: number;
  completedCount: number;
  againCount: number;
  examDueCount: number;
  debtCount: number;
  heatLevel: 0 | 1 | 2 | 3 | 4;
  scheduledReviewIds: string[];
  completedReviewIds: string[];
  debtReviewIds: string[];
  reviewIds: string[];
}

export interface StudyCalendarMonth {
  year: number;
  monthIndex: number;
  label: string;
  days: StudyCalendarDay[];
  weeks: StudyCalendarDay[][];
  streak: number;
  summary: {
    completed: number;
    activeDays: number;
    scheduled: number;
    againRate: number;
  };
}

export function buildStudyCalendarMonth(
  cards: readonly StudyCalendarCard[],
  debtSnapshots: readonly StudyCalendarDebtSnapshot[],
  year: number,
  monthIndex: number,
  now: Date
): StudyCalendarMonth {
  const firstOfMonth = new Date(year, monthIndex, 1, 12);
  const mondayOffset = (firstOfMonth.getDay() + 6) % 7;
  const gridStart = new Date(year, monthIndex, 1 - mondayOffset, 12);
  const todayKey = localDateKey(now);
  const todayStart = startOfLocalDay(now).getTime();
  const nowTime = now.getTime();
  const activeDateKeys = new Set<string>();
  const byDate = new Map<string, StudyCalendarDay>();
  const days: StudyCalendarDay[] = [];

  for (let index = 0; index < 42; index += 1) {
    const date = addLocalDays(gridStart, index);
    const dateKey = localDateKey(date);
    const comparison = startOfLocalDay(date).getTime() - todayStart;
    const day: StudyCalendarDay = {
      dateKey,
      dayNumber: date.getDate(),
      inMonth: date.getFullYear() === year && date.getMonth() === monthIndex,
      isToday: dateKey === todayKey,
      isPast: comparison < 0,
      isFuture: comparison > 0,
      scheduledCount: 0,
      completedCount: 0,
      againCount: 0,
      examDueCount: 0,
      debtCount: 0,
      heatLevel: 0,
      scheduledReviewIds: [],
      completedReviewIds: [],
      debtReviewIds: [],
      reviewIds: []
    };
    days.push(day);
    byDate.set(dateKey, day);
  }

  for (const snapshot of debtSnapshots) {
    const day = byDate.get(snapshot.dateKey);
    if (day && snapshot.dateKey !== todayKey) day.debtCount = Math.max(0, Math.round(snapshot.currentDebt));
  }

  for (const card of cards) {
    const nextReviewTime = Date.parse(card.nextReviewAt ?? "");
    if (Number.isFinite(nextReviewTime)) {
      const scheduledDay = byDate.get(localDateKey(new Date(nextReviewTime)));
      if (scheduledDay) {
        scheduledDay.scheduledCount += 1;
        addUnique(scheduledDay.scheduledReviewIds, card.reviewId);
        if (card.isExam) scheduledDay.examDueCount += 1;
      }
      if (nextReviewTime <= nowTime) {
        const today = byDate.get(todayKey);
        if (today) addUnique(today.debtReviewIds, card.reviewId);
      }
    }

    for (const attempt of card.history) {
      const reviewedTime = Date.parse(attempt.reviewedAt);
      if (!Number.isFinite(reviewedTime)) continue;
      const dateKey = localDateKey(new Date(reviewedTime));
      activeDateKeys.add(dateKey);
      const day = byDate.get(dateKey);
      if (!day) continue;
      day.completedCount += 1;
      if (attempt.rating === 1) day.againCount += 1;
      addUnique(day.completedReviewIds, card.reviewId);
    }
  }

  const today = byDate.get(todayKey);
  if (today) today.debtCount = today.debtReviewIds.length;

  const monthDays = days.filter((day) => day.inMonth);
  const maxCompleted = Math.max(0, ...monthDays.map((day) => day.completedCount));
  for (const day of days) {
    day.heatLevel = heatLevel(day.completedCount, maxCompleted);
    day.reviewIds = unique([
      ...day.scheduledReviewIds,
      ...day.completedReviewIds,
      ...day.debtReviewIds
    ]);
  }

  const completed = monthDays.reduce((sum, day) => sum + day.completedCount, 0);
  const again = monthDays.reduce((sum, day) => sum + day.againCount, 0);
  const scheduled = monthDays.reduce((sum, day) => sum + day.scheduledCount, 0);
  const weeks = Array.from({ length: 6 }, (_, index) => days.slice(index * 7, index * 7 + 7));

  return {
    year,
    monthIndex,
    label: `${year}年${monthIndex + 1}月`,
    days,
    weeks,
    streak: currentStreak(activeDateKeys, now),
    summary: {
      completed,
      activeDays: monthDays.filter((day) => day.completedCount > 0).length,
      scheduled,
      againRate: completed === 0 ? 0 : Math.round((again / completed) * 100)
    }
  };
}

export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function currentStreak(activeDateKeys: ReadonlySet<string>, now: Date): number {
  let cursor = startOfLocalDay(now);
  if (!activeDateKeys.has(localDateKey(cursor))) cursor = addLocalDays(cursor, -1);
  let streak = 0;
  while (activeDateKeys.has(localDateKey(cursor))) {
    streak += 1;
    cursor = addLocalDays(cursor, -1);
  }
  return streak;
}

function heatLevel(completed: number, maximum: number): 0 | 1 | 2 | 3 | 4 {
  if (completed <= 0 || maximum <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil((completed / maximum) * 4))) as 1 | 2 | 3 | 4;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date: Date, amount: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
