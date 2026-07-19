import { describe, expect, it } from "vitest";
import {
  parseStoredReviewSession,
  reconcileSessionQueue,
  resolveSessionScrollTop,
  restoreStoredSessionQueue,
  sessionQueuesEqual
} from "../src/session";

interface Card {
  reviewId: string;
  title: string;
  queueReason: "due" | "new" | null;
}

describe("复习会话后台刷新", () => {
  it("按原顺序保留当前队列和排队原因，同时吸收重新扫描后的卡片内容", () => {
    const queue: Card[] = [
      { reviewId: "current", title: "旧标题", queueReason: "due" },
      { reviewId: "next", title: "下一张", queueReason: "new" }
    ];
    const scanned: Card[] = [
      { reviewId: "new-card", title: "新加入", queueReason: null },
      { reviewId: "current", title: "更新后的标题", queueReason: null },
      { reviewId: "next", title: "下一张（更新）", queueReason: null }
    ];

    expect(reconcileSessionQueue(queue, scanned)).toEqual([
      { reviewId: "current", title: "更新后的标题", queueReason: "due" },
      { reviewId: "next", title: "下一张（更新）", queueReason: "new" }
    ]);
  });

  it("移除扫描后已不存在的卡，但不会把新卡强塞进当前会话", () => {
    const queue: Card[] = [
      { reviewId: "deleted", title: "已删除", queueReason: "due" },
      { reviewId: "current", title: "当前", queueReason: "due" }
    ];
    const scanned: Card[] = [
      { reviewId: "current", title: "当前", queueReason: null },
      { reviewId: "new-card", title: "新卡", queueReason: null }
    ];

    expect(reconcileSessionQueue(queue, scanned).map((card) => card.reviewId)).toEqual(["current"]);
  });

  it("扫描结果与当前队列内容一致时判定为无需重绘，内容改变时才刷新", () => {
    const queue: Card[] = [{ reviewId: "current", title: "当前", queueReason: "due" }];
    const same = reconcileSessionQueue(queue, [{ reviewId: "current", title: "当前", queueReason: null }]);
    const changed = reconcileSessionQueue(queue, [{ reviewId: "current", title: "新标题", queueReason: null }]);

    expect(sessionQueuesEqual(queue, same)).toBe(true);
    expect(sessionQueuesEqual(queue, changed)).toBe(false);
  });

  it("从设备会话快照恢复队列顺序和揭示状态，并忽略已经不存在的卡", () => {
    const snapshot = parseStoredReviewSession({
      version: 1,
      savedAt: "2026-07-14T08:00:00.000Z",
      mode: "scheduled",
      queue: [
        { reviewId: "missing", queueReason: "due" },
        { reviewId: "current", queueReason: "new" }
      ],
      revealStep: 2,
      reviewActions: 4,
      activeQuestionId: "ai-1",
      scrollTop: 320
    });
    const scanned: Card[] = [{ reviewId: "current", title: "当前", queueReason: null }];

    expect(snapshot).not.toBeNull();
    expect(restoreStoredSessionQueue(snapshot!.queue, scanned)).toEqual([
      { reviewId: "current", title: "当前", queueReason: "new" }
    ]);
    expect(snapshot).toMatchObject({ revealStep: 2, reviewActions: 4, scrollTop: 320 });
    expect(parseStoredReviewSession({ version: 99 })).toBeNull();
  });

  it("视图卸载后scrollTop被DOM清零时保留最后一次有效滚动位置", () => {
    expect(resolveSessionScrollTop(320, 0, false)).toBe(320);
    expect(resolveSessionScrollTop(320, 0, true)).toBe(0);
    expect(resolveSessionScrollTop(320, 480, true)).toBe(480);
  });
});
