import { describe, expect, it } from "vitest";
import { buildExamCountdown } from "../src/exam-countdown";

const config = {
  name: "2026 年 12 月考试",
  startDate: "2026-12-19",
  endDate: "2026-12-20"
};

describe("exam countdown", () => {
  it("counts down to local midnight with day, hour, minute and second precision", () => {
    const countdown = buildExamCountdown(config, new Date(2026, 6, 14, 23, 30));
    expect(countdown).toMatchObject({
      status: "upcoming",
      value: "157",
      unit: "天",
      dateLabel: "2026 年 12 月 19—20 日",
      remaining: {
        days: 157,
        hours: 0,
        minutes: 30,
        seconds: 0
      }
    });
  });

  it("keeps the final second visible and switches exactly at local midnight", () => {
    expect(buildExamCountdown(config, new Date(2026, 11, 18, 23, 59, 59))).toMatchObject({
      status: "upcoming",
      remaining: {
        days: 0,
        hours: 0,
        minutes: 0,
        seconds: 1,
        totalSeconds: 1
      }
    });
    expect(buildExamCountdown(config, new Date(2026, 11, 19, 0, 0, 0))).toMatchObject({
      status: "active",
      remaining: null
    });
  });

  it("switches to the correct exam-day progress across the two-day range", () => {
    expect(buildExamCountdown(config, new Date(2026, 11, 19, 8))).toMatchObject({
      status: "active",
      value: "进行中",
      unit: "第 1/2 天",
      remaining: null
    });
    expect(buildExamCountdown(config, new Date(2026, 11, 20, 22))).toMatchObject({
      status: "active",
      value: "进行中",
      unit: "第 2/2 天"
    });
  });

  it("reports completion after the final exam day", () => {
    expect(buildExamCountdown(config, new Date(2026, 11, 21, 0, 1))).toMatchObject({
      status: "ended",
      value: "已结束",
      unit: "1 天"
    });
  });

  it("rejects invalid dates and safely collapses an inverted range", () => {
    expect(buildExamCountdown({ ...config, startDate: "2026-02-30" }, new Date(2026, 6, 14))).toBeNull();
    expect(buildExamCountdown({ ...config, endDate: "2026-12-01" }, new Date(2026, 11, 19))).toMatchObject({
      status: "active",
      unit: "第 1/1 天",
      dateLabel: "2026 年 12 月 19 日"
    });
  });
});
