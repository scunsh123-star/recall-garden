import {
  DataSummary,
  RecallGardenData,
  migrateData,
  summarizeData
} from "./data";

export const SNAPSHOT_KIND = "recall-garden-snapshot" as const;
export const SNAPSHOT_VERSION = 1 as const;

export interface RecallGardenSnapshot {
  kind: typeof SNAPSHOT_KIND;
  snapshotVersion: typeof SNAPSHOT_VERSION;
  pluginVersion: string;
  exportedAt: string;
  data: RecallGardenData;
}

export interface SnapshotDiff {
  current: DataSummary;
  incoming: DataSummary;
  settingsChanged: boolean;
  addedIds: string[];
  removedIds: string[];
  changedIds: string[];
}

export function createSnapshot(
  data: RecallGardenData,
  pluginVersion: string,
  exportedAt = new Date().toISOString()
): RecallGardenSnapshot {
  const cloned = migrateData(JSON.parse(JSON.stringify(data)) as unknown);
  cloned.settings.deepseekSecretId = "";
  return {
    kind: SNAPSHOT_KIND,
    snapshotVersion: SNAPSHOT_VERSION,
    pluginVersion,
    exportedAt,
    data: cloned
  };
}

export function parseSnapshot(raw: unknown): RecallGardenSnapshot {
  if (!isRecord(raw) || raw.kind !== SNAPSHOT_KIND) throw new Error("不是有效的忆园数据快照");
  const snapshotVersion = Number(raw.snapshotVersion);
  if (snapshotVersion > SNAPSHOT_VERSION) {
    throw new Error(`快照格式 ${snapshotVersion} 高于当前支持的版本 ${SNAPSHOT_VERSION}`);
  }
  if (snapshotVersion !== SNAPSHOT_VERSION) throw new Error("快照格式版本缺失或无效");
  return {
    kind: SNAPSHOT_KIND,
    snapshotVersion: SNAPSHOT_VERSION,
    pluginVersion: typeof raw.pluginVersion === "string" ? raw.pluginVersion : "unknown",
    exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : "",
    data: migrateData(raw.data)
  };
}

export function prepareRestoredData(current: RecallGardenData, incoming: RecallGardenData): RecallGardenData {
  const restored = migrateData(JSON.parse(JSON.stringify(incoming)) as unknown);
  restored.settings.deepseekSecretId = current.settings.deepseekSecretId;
  return restored;
}

export function diffSnapshots(current: RecallGardenData, incoming: RecallGardenData): SnapshotDiff {
  const currentIds = stableIdSet(current);
  const incomingIds = stableIdSet(incoming);
  const shared = [...currentIds].filter((id) => incomingIds.has(id));
  return {
    current: summarizeData(current),
    incoming: summarizeData(incoming),
    settingsChanged: JSON.stringify(snapshotSafeSettings(current)) !== JSON.stringify(snapshotSafeSettings(incoming)),
    addedIds: [...incomingIds].filter((id) => !currentIds.has(id)).sort(),
    removedIds: [...currentIds].filter((id) => !incomingIds.has(id)).sort(),
    changedIds: shared.filter((id) => serializedCard(current, id) !== serializedCard(incoming, id)).sort()
  };
}

function snapshotSafeSettings(data: RecallGardenData): RecallGardenData["settings"] {
  return { ...data.settings, deepseekSecretId: "" };
}

function stableIdSet(data: RecallGardenData): Set<string> {
  return new Set([...Object.values(data.sourceIds), ...Object.keys(data.archived)]);
}

function serializedCard(data: RecallGardenData, reviewId: string): string {
  const activePath = Object.entries(data.sourceIds).find(([, id]) => id === reviewId)?.[0] ?? "";
  return JSON.stringify({
    activePath,
    record: data.records[reviewId] ?? null,
    questions: data.questions[reviewId] ?? [],
    archived: data.archived[reviewId] ?? null
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
