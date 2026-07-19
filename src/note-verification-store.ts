import type { App } from "obsidian";
import {
  NoteVerificationReport,
  parseNoteVerificationReport,
  prepareNoteVerificationMarkdown
} from "./note-verification";

export const NOTE_VERIFICATION_STORE_VERSION = 1 as const;
export const NOTE_VERIFICATION_STORE_ROOT = "Recall Garden/.data/verifications";

export interface SavedNoteVerificationReport {
  version: typeof NOTE_VERIFICATION_STORE_VERSION;
  sourcePath: string;
  noteFingerprint: string;
  savedAt: string;
  report: NoteVerificationReport;
}

export interface LoadedNoteVerificationReport {
  saved: SavedNoteVerificationReport;
  isStale: boolean;
}

export class UnknownNoteVerificationStoreVersionError extends Error {
  constructor(version: number) {
    super(`核验报告来自更高版本（v${version}），当前插件不会覆盖它`);
    this.name = "UnknownNoteVerificationStoreVersionError";
  }
}

export class NoteVerificationStore {
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(private app: App) {}

  async save(report: NoteVerificationReport, markdown: string): Promise<SavedNoteVerificationReport> {
    const operation = this.writeChain.then(async () => {
      await this.ensureFolder(NOTE_VERIFICATION_STORE_ROOT);
      const path = await verificationReportStoragePath(report.sourcePath);
      const existing = await this.readPath(path);
      if (existing && existing.sourcePath !== report.sourcePath) {
        throw new Error("核验报告存储键冲突，已停止覆盖");
      }
      const saved: SavedNoteVerificationReport = {
        version: NOTE_VERIFICATION_STORE_VERSION,
        sourcePath: report.sourcePath,
        noteFingerprint: await fingerprintVerificationMarkdown(markdown),
        savedAt: new Date().toISOString(),
        report
      };
      await this.app.vault.adapter.write(path, `${JSON.stringify(saved, null, 2)}\n`);
      return saved;
    });
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  async load(sourcePath: string, markdown: string): Promise<LoadedNoteVerificationReport | null> {
    const path = await verificationReportStoragePath(sourcePath);
    const saved = await this.readPath(path);
    if (!saved) return null;
    if (saved.sourcePath !== sourcePath) throw new Error("核验报告路径校验失败，已停止读取");
    return {
      saved,
      isStale: saved.noteFingerprint !== await fingerprintVerificationMarkdown(markdown)
    };
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const operation = this.writeChain.then(async () => {
      const oldStoragePath = await verificationReportStoragePath(oldPath);
      const saved = await this.readPath(oldStoragePath);
      if (!saved) return;
      if (saved.sourcePath !== oldPath) throw new Error("旧核验报告路径校验失败，已停止迁移");

      await this.ensureFolder(NOTE_VERIFICATION_STORE_ROOT);
      const newStoragePath = await verificationReportStoragePath(newPath);
      const existing = await this.readPath(newStoragePath);
      if (existing && existing.sourcePath !== newPath) {
        throw new Error("新核验报告存储键冲突，已停止迁移");
      }
      const moved: SavedNoteVerificationReport = {
        ...saved,
        sourcePath: newPath,
        report: { ...saved.report, sourcePath: newPath }
      };
      await this.app.vault.adapter.write(newStoragePath, `${JSON.stringify(moved, null, 2)}\n`);
      if (newStoragePath !== oldStoragePath) await this.app.vault.adapter.remove(oldStoragePath);
    });
    this.writeChain = operation.catch(() => undefined);
    await operation;
  }

  private async readPath(path: string): Promise<SavedNoteVerificationReport | null> {
    if (!(await this.app.vault.adapter.exists(path))) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(await this.app.vault.adapter.read(path)) as unknown;
    } catch {
      throw new Error("已保存的核验报告损坏，当前插件不会覆盖它");
    }
    return parseSavedNoteVerificationReport(raw);
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    let current = "";
    for (const segment of folderPath.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      if (!(await this.app.vault.adapter.exists(current))) await this.app.vault.adapter.mkdir(current);
    }
  }
}

export async function verificationReportStoragePath(sourcePath: string): Promise<string> {
  const normalized = sourcePath.replace(/\\/g, "/");
  const digest = await sha256Hex(normalized);
  return `${NOTE_VERIFICATION_STORE_ROOT}/${digest.slice(0, 32)}.json`;
}

export async function fingerprintVerificationMarkdown(markdown: string): Promise<string> {
  return sha256Hex(prepareNoteVerificationMarkdown(markdown));
}

export function parseSavedNoteVerificationReport(value: unknown): SavedNoteVerificationReport {
  const item = asRecord(value);
  const version = Number(item.version);
  if (Number.isFinite(version) && version > NOTE_VERIFICATION_STORE_VERSION) {
    throw new UnknownNoteVerificationStoreVersionError(version);
  }
  if (version !== NOTE_VERIFICATION_STORE_VERSION) throw new Error("核验报告版本或结构无效");

  const sourcePath = stringValue(item.sourcePath);
  const noteFingerprint = stringValue(item.noteFingerprint);
  const savedAt = stringValue(item.savedAt);
  const rawReport = asRecord(item.report);
  const provider = rawReport.provider === "codex-oauth" || rawReport.provider === "deepseek"
    ? rawReport.provider
    : null;
  const model = stringValue(rawReport.model);
  const title = stringValue(rawReport.title);
  const generatedAt = stringValue(rawReport.generatedAt);
  if (!sourcePath || !/^[a-f0-9]{64}$/.test(noteFingerprint) || !isIsoDate(savedAt) || !provider || !model || !title || !isIsoDate(generatedAt)) {
    throw new Error("核验报告版本或结构无效");
  }

  const report = parseNoteVerificationReport(JSON.stringify(rawReport), {
    sourcePath,
    title,
    provider,
    model,
    generatedAt,
    inputTruncated: rawReport.inputTruncated === true
  });
  return {
    version: NOTE_VERIFICATION_STORE_VERSION,
    sourcePath,
    noteFingerprint,
    savedAt,
    report
  };
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isIsoDate(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}
