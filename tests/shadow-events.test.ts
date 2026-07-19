import { describe, expect, it } from "vitest";
import type { ReviewRecord } from "../src/data";
import {
  createShadowReviewEvent,
  parseShadowEventLog,
  projectReviewRecord,
  verifyShadowEventChain
} from "../src/shadow-events";

function record(reviewId: string, count: number, rating: 1 | 2 | 3 | 4): ReviewRecord {
  return {
    reviewId,
    sourcePath: `${reviewId}.md`,
    stage: 2,
    introducedAt: "2026-07-10T00:00:00.000Z",
    lastReviewedAt: `2026-07-14T0${count}:00:00.000Z`,
    nextReviewAt: "2026-07-15T00:00:00.000Z",
    lastRating: rating,
    reviewCount: count,
    errorCount: rating === 1 ? 1 : 0,
    history: [],
    fsrs: null
  };
}

describe("影子评分事件链", () => {
  it("生成不包含完整历史的评分事件，并建立可验证的前向哈希链", async () => {
    const first = await createShadowReviewEvent({
      eventId: "event-1",
      deviceId: "device-a",
      previousHash: "",
      rating: 3,
      revealLevel: 1,
      durationSeconds: 25,
      before: projectReviewRecord(record("card", 1, 2)),
      after: projectReviewRecord(record("card", 2, 3))
    });
    const second = await createShadowReviewEvent({
      eventId: "event-2",
      deviceId: "device-a",
      previousHash: first.hash,
      rating: 4,
      revealLevel: 0,
      durationSeconds: null,
      before: first.after,
      after: projectReviewRecord(record("card", 3, 4))
    });

    expect(first.previousHash).toBe("");
    expect(second.previousHash).toBe(first.hash);
    expect(first.after).not.toHaveProperty("history");
    await expect(verifyShadowEventChain([first, second])).resolves.toMatchObject({
      valid: true,
      eventCount: 2,
      lastHash: second.hash
    });
  });

  it("能发现事件内容篡改和损坏的JSONL行", async () => {
    const event = await createShadowReviewEvent({
      eventId: "event-1",
      deviceId: "device-a",
      previousHash: "",
      rating: 3,
      revealLevel: 2,
      durationSeconds: 30,
      before: null,
      after: projectReviewRecord(record("card", 1, 3))
    });
    const tampered = { ...event, rating: 1 as const };

    await expect(verifyShadowEventChain([tampered])).resolves.toMatchObject({ valid: false, invalidIndex: 0 });
    expect(parseShadowEventLog(`${JSON.stringify(event)}\n{broken}\n`)).toMatchObject({
      events: [event],
      invalidLines: [2]
    });
  });
});
