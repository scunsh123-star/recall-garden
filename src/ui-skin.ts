export const UI_SKINS = {
  "nebula-blue": {
    label: "星穹蓝",
    description: "蓝色极光、玻璃层次与轻量光效，视觉表现最完整。"
  },
  "calm-blue": {
    label: "静水蓝",
    description: "降低饱和度、阴影和动画，适合长时间专注复习。"
  },
  "classic-garden": {
    label: "经典忆园",
    description: "恢复沉静的园林绿色与温暖强调色。"
  },
  "obsidian-native": {
    label: "Obsidian 原生",
    description: "尽量跟随当前 Obsidian 主题，减少装饰与视觉覆盖。"
  }
} as const;

export type UiSkin = keyof typeof UI_SKINS;

export const DEFAULT_UI_SKIN: UiSkin = "nebula-blue";
export const UI_SKIN_CLASSES = Object.keys(UI_SKINS).map((skin) => `recall-garden-skin-${skin}`);

export function normalizeUiSkin(value: unknown): UiSkin {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(UI_SKINS, value)
    ? value as UiSkin
    : DEFAULT_UI_SKIN;
}

export function uiSkinClass(value: unknown): string {
  return `recall-garden-skin-${normalizeUiSkin(value)}`;
}

export function applyUiSkin(element: HTMLElement, skin: unknown, enableVisualEffects: boolean): void {
  element.classList.remove(...UI_SKIN_CLASSES, "recall-garden-effects-off");
  element.classList.add(uiSkinClass(skin));
  if (!enableVisualEffects) element.classList.add("recall-garden-effects-off");
}
