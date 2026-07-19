import { describe, expect, it } from "vitest";
import { migrateData } from "../src/data";
import {
  DEFAULT_UI_SKIN,
  UI_SKINS,
  normalizeUiSkin,
  uiSkinClass
} from "../src/ui-skin";

describe("UI skin management", () => {
  it("ships four stable built-in skins", () => {
    expect(Object.keys(UI_SKINS)).toEqual([
      "nebula-blue",
      "calm-blue",
      "classic-garden",
      "obsidian-native"
    ]);
    expect(DEFAULT_UI_SKIN).toBe("nebula-blue");
  });

  it("normalizes persisted values and produces a safe CSS class", () => {
    expect(normalizeUiSkin("classic-garden")).toBe("classic-garden");
    expect(normalizeUiSkin("future-skin")).toBe(DEFAULT_UI_SKIN);
    expect(normalizeUiSkin(null)).toBe(DEFAULT_UI_SKIN);
    expect(uiSkinClass("calm-blue")).toBe("recall-garden-skin-calm-blue");
  });

  it("adds appearance defaults without changing the data schema", () => {
    const migrated = migrateData({ version: 5, settings: {} });
    expect(migrated.version).toBe(5);
    expect(migrated.settings.uiSkin).toBe("nebula-blue");
    expect(migrated.settings.enableVisualEffects).toBe(true);
  });

  it("preserves valid settings and rejects unknown skins", () => {
    const valid = migrateData({
      version: 5,
      settings: { uiSkin: "obsidian-native", enableVisualEffects: false }
    });
    expect(valid.settings.uiSkin).toBe("obsidian-native");
    expect(valid.settings.enableVisualEffects).toBe(false);

    const invalid = migrateData({ version: 5, settings: { uiSkin: "neon-red" } });
    expect(invalid.settings.uiSkin).toBe(DEFAULT_UI_SKIN);
  });
});
