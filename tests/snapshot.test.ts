import { describe, expect, it } from "vitest";
import { createEmptyData } from "../src/data";
import {
  createSnapshot,
  diffSnapshots,
  parseSnapshot,
  prepareRestoredData
} from "../src/snapshot";

describe("数据快照", () => {
  it("导出时清除SecretStorage引用且不包含OAuth或API Key", () => {
    const data = createEmptyData();
    data.settings.deepseekSecretId = "my-deepseek-key";
    const snapshot = createSnapshot(data, "0.3.0", "2026-07-13T00:00:00.000Z");
    const serialized = JSON.stringify(snapshot);
    expect(snapshot.data.settings.deepseekSecretId).toBe("");
    expect(serialized).not.toContain("my-deepseek-key");
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("refreshToken");
  });

  it("恢复时保留当前设备的本地密钥引用", () => {
    const current = createEmptyData();
    current.settings.deepseekSecretId = "device-local-secret";
    const incoming = createEmptyData();
    incoming.settings.folder = "incoming-folder";
    const restored = prepareRestoredData(current, incoming);
    expect(restored.settings.folder).toBe("incoming-folder");
    expect(restored.settings.deepseekSecretId).toBe("device-local-secret");
  });

  it("解析快照并拒绝未来快照格式", () => {
    const snapshot = createSnapshot(createEmptyData(), "0.4.0");
    expect(parseSnapshot(snapshot).data.version).toBe(5);
    expect(() => parseSnapshot({ ...snapshot, snapshotVersion: 9 })).toThrow("高于当前支持");
  });

  it("导入前列出新增、移除和变化的稳定ID", () => {
    const current = createEmptyData();
    current.sourceIds["a.md"] = "rg-a";
    current.sourceIds["b.md"] = "rg-b";
    const incoming = createEmptyData();
    incoming.sourceIds["a-renamed.md"] = "rg-a";
    incoming.sourceIds["c.md"] = "rg-c";
    incoming.settings.folder = "incoming";
    const diff = diffSnapshots(current, incoming);
    expect(diff.settingsChanged).toBe(true);
    expect(diff.addedIds).toEqual(["rg-c"]);
    expect(diff.removedIds).toEqual(["rg-b"]);
    expect(diff.changedIds).toEqual(["rg-a"]);
  });
});
