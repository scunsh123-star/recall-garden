import { describe, expect, it } from "vitest";
import { buildStudyCalendarMonth } from "../src/calendar";

const NOW = new Date("2026-07-14T12:00:00+08:00");

const cards = [
  {
    reviewId: "alpha",
    nextReviewAt: "2026-07-14T09:00:00+08:00",
    isExam: true,
    history: [
      { reviewedAt: "2026-07-13T10:00:00+08:00", rating: 3 },
      { reviewedAt: "2026-07-14T10:00:00+08:00", rating: 1 }
    ]
  },
  {
    reviewId: "beta",
    nextReviewAt: "2026-07-10T09:00:00+08:00",
    isExam: false,
    history: [
      { reviewedAt: "2026-07-12T10:00:00+08:00", rating: 3 },
      { reviewedAt: "2026-07-13T11:00:00+08:00", rating: 2 }
    ]
  },
  {
    reviewId: "gamma",
    nextReviewAt: "2026-08-02T09:00:00+08:00",
    isExam: true,
    history: []
  }
] as const;

describe("built-in study calendar", () => {
  it("builds a stable six-week Monday-first month grid", () => {
    const calendar = buildStudyCalendarMonth(cards, [], 2026, 6, NOW);
    expect(calendar.days).toHaveLength(42);
    expect(calendar.days[0].dateKey).toBe("2026-06-29");
    expect(calendar.days[41].dateKey).toBe("2026-08-09");
    expect(calendar.weeks).toHaveLength(6);
    expect(calendar.weeks.every((week) => week.length === 7)).toBe(true);
  });

  it("aggregates scheduled, completed, error, exam and debt evidence", () => {
    const calendar = buildStudyCalendarMonth(cards, [
      { dateKey: "2026-07-13", currentDebt: 4 }
    ], 2026, 6, NOW);
    const today = calendar.days.find((day) => day.dateKey === "2026-07-14")!;
    expect(today.isToday).toBe(true);
    expect(today.scheduledCount).toBe(1);
    expect(today.completedCount).toBe(1);
    expect(today.againCount).toBe(1);
    expect(today.examDueCount).toBe(1);
    expect(today.debtCount).toBe(2);
    expect(today.reviewIds).toEqual(["alpha", "beta"]);

    const yesterday = calendar.days.find((day) => day.dateKey === "2026-07-13")!;
    expect(yesterday.completedCount).toBe(2);
    expect(yesterday.debtCount).toBe(4);
  });

  it("calculates month totals, heat intensity and the current streak", () => {
    const calendar = buildStudyCalendarMonth(cards, [], 2026, 6, NOW);
    expect(calendar.summary.completed).toBe(4);
    expect(calendar.summary.activeDays).toBe(3);
    expect(calendar.summary.scheduled).toBe(2);
    expect(calendar.summary.againRate).toBe(25);
    expect(calendar.streak).toBe(3);

    const july13 = calendar.days.find((day) => day.dateKey === "2026-07-13")!;
    const july12 = calendar.days.find((day) => day.dateKey === "2026-07-12")!;
    expect(july13.heatLevel).toBe(4);
    expect(july12.heatLevel).toBe(2);
  });

  it("keeps a streak alive through yesterday when today has no review yet", () => {
    const withoutToday = cards.map((card) => ({
      ...card,
      history: card.history.filter((attempt) => !attempt.reviewedAt.startsWith("2026-07-14"))
    }));
    const calendar = buildStudyCalendarMonth(withoutToday, [], 2026, 6, NOW);
    expect(calendar.streak).toBe(2);
  });

  it("keeps archived history visible without treating it as future schedule or debt", () => {
    const historyOnlyCard = {
      reviewId: "archived",
      nextReviewAt: null,
      isExam: false,
      history: [{ reviewedAt: "2026-07-11T10:00:00+08:00", rating: 3 }]
    } as const;
    const calendar = buildStudyCalendarMonth([...cards, historyOnlyCard], [], 2026, 6, NOW);
    const july11 = calendar.days.find((day) => day.dateKey === "2026-07-11")!;
    expect(july11.completedCount).toBe(1);
    expect(july11.completedReviewIds).toContain("archived");
    expect(calendar.summary.completed).toBe(5);
    expect(calendar.summary.scheduled).toBe(2);
    expect(calendar.days.find((day) => day.isToday)?.debtReviewIds).not.toContain("archived");
  });
});
