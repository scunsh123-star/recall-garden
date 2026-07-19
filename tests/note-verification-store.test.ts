import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { NoteVerificationReport } from "../src/note-verification";
import {
  NoteVerificationStore,
  fingerprintVerificationMarkdown,
  verificationReportStoragePath
} from "../src/note-verification-store";

const report: NoteVerificationReport = {
  sourcePath: "Recall Garden/Cards/Statistics/card-Bayes Theorem.md",
  title: "Bayes' theorem",
  verdict: "needs_revision",
  summary: "存在一处表述问题。",
  confidence: 0.82,
  issues: [{
    type: "ambiguity",
    severity: "medium",
    quote: "唯一媒介",
    explanation: "表述过于绝对。",
    suggestion: "弱化绝对判断。",
    replacement: "重要媒介"
  }],
  provider: "deepseek",
  model: "test-model",
  generatedAt: "2026-07-15T04:00:00.000Z",
  inputTruncated: false
};

describe("saved note verification reports", () => {
  it("uses a stable opaque vault path per source note", async () => {
    const first = await verificationReportStoragePath(report.sourcePath);
    const again = await verificationReportStoragePath(report.sourcePath);
    const other = await verificationReportStoragePath("Recall Garden/Cards/Biology/card-Photosynthesis.md");
    expect(first).toBe(again);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^Recall Garden\/\.data\/verifications\/[a-f0-9]{32}\.json$/);
    expect(first).not.toContain("Bayes");
  });

  it("ignores the managed AI question bank when fingerprinting", async () => {
    const before = "# 标题\n正文\n<!-- recall-garden:question-bank:start -->\n题目 A\n<!-- recall-garden:question-bank:end -->";
    const after = "# 标题\n正文\n<!-- recall-garden:question-bank:start -->\n题目 B\n<!-- recall-garden:question-bank:end -->";
    expect(await fingerprintVerificationMarkdown(before)).toBe(await fingerprintVerificationMarkdown(after));
    expect(await fingerprintVerificationMarkdown("# 标题\n正文已修改")).not.toBe(await fingerprintVerificationMarkdown(before));
  });

  it("saves and reloads the latest report while detecting stale notes", async () => {
    const adapter = createMemoryAdapter();
    const store = new NoteVerificationStore({ vault: { adapter } } as unknown as App);
    await store.save(report, "# Bayes' theorem\n唯一媒介");

    const current = await store.load(report.sourcePath, "# Bayes' theorem\n唯一媒介");
    expect(current?.isStale).toBe(false);
    expect(current?.saved.report).toEqual(report);

    const stale = await store.load(report.sourcePath, "# Bayes' theorem\n重要媒介");
    expect(stale?.isStale).toBe(true);
  });

  it("moves a saved report when its source note is renamed", async () => {
    const adapter = createMemoryAdapter();
    const store = new NoteVerificationStore({ vault: { adapter } } as unknown as App);
    await store.save(report, "正文");
    await store.rename(report.sourcePath, "Recall Garden/Cards/Statistics/card-Bayes Theorem Revised.md");
    expect(await store.load(report.sourcePath, "正文")).toBeNull();
    const moved = await store.load("Recall Garden/Cards/Statistics/card-Bayes Theorem Revised.md", "正文");
    expect(moved?.saved.report.sourcePath).toBe("Recall Garden/Cards/Statistics/card-Bayes Theorem Revised.md");
  });

  it("refuses to overwrite a report written by a future plugin version", async () => {
    const adapter = createMemoryAdapter();
    const path = await verificationReportStoragePath(report.sourcePath);
    const future = JSON.stringify({ version: 99, sourcePath: report.sourcePath });
    adapter.files.set(path, future);
    const store = new NoteVerificationStore({ vault: { adapter } } as unknown as App);

    await expect(store.save(report, "正文")).rejects.toThrow("来自更高版本");
    expect(adapter.files.get(path)).toBe(future);
  });
});

function createMemoryAdapter() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  return {
    files,
    async exists(path: string): Promise<boolean> {
      return files.has(path) || folders.has(path);
    },
    async mkdir(path: string): Promise<void> {
      folders.add(path);
    },
    async read(path: string): Promise<string> {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    },
    async write(path: string, value: string): Promise<void> {
      files.set(path, value);
    },
    async remove(path: string): Promise<void> {
      files.delete(path);
    }
  };
}
