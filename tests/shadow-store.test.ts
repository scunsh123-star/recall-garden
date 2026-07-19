import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { ReviewRecord } from "../src/data";
import { projectReviewRecord } from "../src/shadow-events";
import { ShadowStore } from "../src/shadow-store";

function record(count: number): ReviewRecord {
  return {
    reviewId: "card",
    sourcePath: "card.md",
    stage: 2,
    introducedAt: "2026-07-10T00:00:00.000Z",
    lastReviewedAt: `2026-07-14T0${count}:00:00.000Z`,
    nextReviewAt: "2026-07-15T00:00:00.000Z",
    lastRating: 3,
    reviewCount: count,
    errorCount: 0,
    history: [],
    fsrs: null
  };
}

function fakeApp(): { app: App; files: Map<string, string> } {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const secrets = new Map<string, string>();
  const adapter = {
    exists: async (path: string) => files.has(path) || folders.has(path),
    mkdir: async (path: string) => { folders.add(path); },
    write: async (path: string, value: string) => { files.set(path, value); },
    append: async (path: string, value: string) => { files.set(path, `${files.get(path) ?? ""}${value}`); },
    read: async (path: string) => files.get(path) ?? ""
  };
  return {
    app: {
      vault: { adapter },
      secretStorage: {
        getSecret: (key: string) => secrets.get(key) ?? null,
        setSecret: (key: string, value: string) => { secrets.set(key, value); }
      }
    } as unknown as App,
    files
  };
}

describe("影子事件存储", () => {
  it("初始化基线、追加事件、验证哈希链并保存恢复会话", async () => {
    const { app, files } = fakeApp();
    const store = new ShadowStore(app, "0.9.0");
    const status = await store.initialize({ card: record(1) });

    expect(status.initialized).toBe(true);
    expect(files.get(status.baselinePath)).toContain('"pluginVersion": "0.9.0"');
    await store.appendReview({
      rating: 3,
      revealLevel: 1,
      durationSeconds: 20,
      before: projectReviewRecord(record(1)),
      after: projectReviewRecord(record(2))
    });
    await expect(store.verify()).resolves.toMatchObject({ chainValid: true, eventCount: 1 });

    const session = {
      version: 1 as const,
      savedAt: "2026-07-14T08:00:00.000Z",
      mode: "scheduled" as const,
      queue: [{ reviewId: "card", queueReason: "due" }],
      revealStep: 2 as const,
      reviewActions: 3,
      activeQuestionId: null,
      scrollTop: 120
    };
    await store.saveSession(session);
    await expect(store.loadSession()).resolves.toEqual(session);

    await store.saveDiagnosticSnapshot({
      dateKey: "2026-07-14",
      capturedAt: "2026-07-14T08:00:00.000Z",
      currentDebt: 8,
      activeCards: 154,
      introducedToday: 2
    });
    await store.saveDiagnosticSnapshot({
      dateKey: "2026-07-14",
      capturedAt: "2026-07-14T12:00:00.000Z",
      currentDebt: 5,
      activeCards: 154,
      introducedToday: 2
    });
    await expect(store.loadDiagnosticSnapshots()).resolves.toEqual([expect.objectContaining({
      dateKey: "2026-07-14",
      currentDebt: 5
    })]);
  });
});
