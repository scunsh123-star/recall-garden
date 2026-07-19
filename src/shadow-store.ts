import type { App } from "obsidian";
import type { Rating } from "./core";
import type { ReviewRecord } from "./data";
import type { StoredReviewSession } from "./session";
import { parseStoredReviewSession } from "./session";
import type { DiagnosticSnapshot } from "./diagnostics";
import {
  CreateShadowReviewEventInput,
  ReviewRecordProjection,
  createShadowReviewEvent,
  parseShadowEventLog,
  projectReviewRecord,
  verifyShadowEventChain
} from "./shadow-events";

const SHADOW_ROOT = "Recall Garden/.data";
const DEVICE_SECRET_ID = "recall-garden-device-id";

export interface ShadowStoreStatus {
  initialized: boolean;
  deviceId: string;
  baselinePath: string;
  eventPath: string;
  sessionPath: string;
  diagnosticsPath: string;
  eventCount: number;
  chainValid: boolean;
  invalidLines: number[];
  lastHash: string;
  error: string;
}

export interface AppendShadowReviewInput {
  rating: Rating;
  revealLevel: 0 | 1 | 2;
  durationSeconds: number | null;
  before: ReviewRecordProjection | null;
  after: ReviewRecordProjection;
}

export class ShadowStore {
  private status: ShadowStoreStatus = {
    initialized: false,
    deviceId: "",
    baselinePath: "",
    eventPath: "",
    sessionPath: "",
    diagnosticsPath: "",
    eventCount: 0,
    chainValid: true,
    invalidLines: [],
    lastHash: "",
    error: ""
  };
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(private app: App, private pluginVersion: string) {}

  async initialize(records: Readonly<Record<string, ReviewRecord>>): Promise<ShadowStoreStatus> {
    const deviceId = this.getOrCreateDeviceId();
    const baselinePath = `${SHADOW_ROOT}/baselines/${deviceId}.json`;
    const eventPath = `${SHADOW_ROOT}/events/${deviceId}.jsonl`;
    const sessionPath = `${SHADOW_ROOT}/sessions/${deviceId}.json`;
    const diagnosticsPath = `${SHADOW_ROOT}/diagnostics/${deviceId}.json`;
    this.status = { ...this.status, deviceId, baselinePath, eventPath, sessionPath, diagnosticsPath };

    try {
      await this.ensureFolder(`${SHADOW_ROOT}/baselines`);
      await this.ensureFolder(`${SHADOW_ROOT}/events`);
      await this.ensureFolder(`${SHADOW_ROOT}/sessions`);
      await this.ensureFolder(`${SHADOW_ROOT}/diagnostics`);
      if (!(await this.app.vault.adapter.exists(baselinePath))) {
        const baseline = {
          version: 1,
          deviceId,
          createdAt: new Date().toISOString(),
          pluginVersion: this.pluginVersion,
          records: Object.fromEntries(Object.entries(records).map(([reviewId, record]) =>
            [reviewId, projectReviewRecord(record)]
          ))
        };
        await this.app.vault.adapter.write(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
      }
      if (!(await this.app.vault.adapter.exists(eventPath))) {
        await this.app.vault.adapter.write(eventPath, "");
      }
      await this.verify();
      this.status.initialized = true;
      return this.getStatus();
    } catch (error) {
      this.status.initialized = false;
      this.status.chainValid = false;
      this.status.error = error instanceof Error ? error.message : "影子存储初始化失败";
      return this.getStatus();
    }
  }

  async verify(): Promise<ShadowStoreStatus> {
    if (!this.status.eventPath) return this.getStatus();
    if (!(await this.app.vault.adapter.exists(this.status.eventPath))) {
      this.status = { ...this.status, eventCount: 0, chainValid: true, invalidLines: [], lastHash: "", error: "" };
      return this.getStatus();
    }
    const raw = await this.app.vault.adapter.read(this.status.eventPath);
    const parsed = parseShadowEventLog(raw);
    const verification = await verifyShadowEventChain(parsed.events);
    const chainValid = parsed.invalidLines.length === 0 && verification.valid;
    this.status = {
      ...this.status,
      eventCount: parsed.events.length,
      chainValid,
      invalidLines: parsed.invalidLines,
      lastHash: verification.lastHash,
      error: chainValid ? "" : parsed.invalidLines.length > 0
        ? `事件日志第 ${parsed.invalidLines.join("、")} 行损坏`
        : `事件哈希链在第 ${(verification.invalidIndex ?? 0) + 1} 条断裂`
    };
    return this.getStatus();
  }

  async appendReview(input: AppendShadowReviewInput): Promise<void> {
    const operation = this.writeChain.then(async () => {
      if (!this.status.initialized) throw new Error("影子事件存储尚未初始化");
      if (!this.status.chainValid) throw new Error(this.status.error || "影子事件链无效，已停止追加");
      const eventInput: CreateShadowReviewEventInput = {
        eventId: createStableId("event"),
        deviceId: this.status.deviceId,
        previousHash: this.status.lastHash,
        ...input
      };
      const event = await createShadowReviewEvent(eventInput);
      await this.app.vault.adapter.append(this.status.eventPath, `${JSON.stringify(event)}\n`);
      this.status.eventCount += 1;
      this.status.lastHash = event.hash;
    });
    this.writeChain = operation.catch(() => undefined);
    await operation;
  }

  async loadSession(): Promise<StoredReviewSession | null> {
    if (!this.status.initialized || !(await this.app.vault.adapter.exists(this.status.sessionPath))) return null;
    try {
      return parseStoredReviewSession(JSON.parse(await this.app.vault.adapter.read(this.status.sessionPath)) as unknown);
    } catch {
      return null;
    }
  }

  async saveSession(session: StoredReviewSession): Promise<void> {
    if (!this.status.initialized) return;
    const operation = this.writeChain.then(() =>
      this.app.vault.adapter.write(this.status.sessionPath, `${JSON.stringify(session, null, 2)}\n`)
    );
    this.writeChain = operation.catch(() => undefined);
    await operation;
  }

  async loadDiagnosticSnapshots(): Promise<DiagnosticSnapshot[]> {
    if (!this.status.initialized || !(await this.app.vault.adapter.exists(this.status.diagnosticsPath))) return [];
    try {
      const parsed = JSON.parse(await this.app.vault.adapter.read(this.status.diagnosticsPath)) as { snapshots?: unknown };
      if (!Array.isArray(parsed.snapshots)) return [];
      return parsed.snapshots.flatMap((value) => isDiagnosticSnapshot(value) ? [value] : []);
    } catch {
      return [];
    }
  }

  async saveDiagnosticSnapshot(snapshot: DiagnosticSnapshot): Promise<void> {
    if (!this.status.initialized) return;
    const operation = this.writeChain.then(async () => {
      const existing = await this.loadDiagnosticSnapshots();
      const snapshots = [
        ...existing.filter((item) => item.dateKey !== snapshot.dateKey),
        snapshot
      ].sort((left, right) => left.dateKey.localeCompare(right.dateKey)).slice(-120);
      await this.app.vault.adapter.write(this.status.diagnosticsPath, `${JSON.stringify({ version: 1, snapshots }, null, 2)}\n`);
    });
    this.writeChain = operation.catch(() => undefined);
    await operation;
  }

  getStatus(): ShadowStoreStatus {
    return { ...this.status, invalidLines: [...this.status.invalidLines] };
  }

  private getOrCreateDeviceId(): string {
    const stored = this.app.secretStorage.getSecret(DEVICE_SECRET_ID)?.trim();
    if (stored) return stored;
    const deviceId = createStableId("device");
    this.app.secretStorage.setSecret(DEVICE_SECRET_ID, deviceId);
    return deviceId;
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    let current = "";
    for (const segment of folderPath.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      if (!(await this.app.vault.adapter.exists(current))) await this.app.vault.adapter.mkdir(current);
    }
  }
}

function createStableId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isDiagnosticSnapshot(value: unknown): value is DiagnosticSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<DiagnosticSnapshot>;
  return typeof item.dateKey === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.dateKey) &&
    typeof item.capturedAt === "string" &&
    Number.isFinite(item.currentDebt) && Number.isFinite(item.activeCards) && Number.isFinite(item.introducedToday);
}
