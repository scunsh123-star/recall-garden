export type CardKind = "definition" | "comparison" | "exam-transfer";
export type AuthoringReviewPriority = "S" | "A" | "B" | "C";

export interface CardDraft {
  kind: CardKind;
  topic: string;
  subject: string;
  module: string;
  examYears: number[];
  frequency: string;
  status: string;
  reviewPriority: AuthoringReviewPriority;
}

interface CardTemplate {
  label: string;
  sections: ReadonlyArray<readonly [string, string]>;
}

export const CARD_KIND_LABELS: Readonly<Record<CardKind, string>> = {
  definition: "概念卡",
  comparison: "对比卡",
  "exam-transfer": "应用迁移卡"
};

export const SUPPORTED_CARD_TYPES = ["recall-card", "study-card", "学习卡", "名词解释"] as const;

export function isRecallCardType(value: unknown): boolean {
  return SUPPORTED_CARD_TYPES.includes(String(value ?? "").trim() as typeof SUPPORTED_CARD_TYPES[number]);
}

const CARD_TEMPLATES: Readonly<Record<CardKind, CardTemplate>> = {
  definition: {
    label: CARD_KIND_LABELS.definition,
    sections: [
      ["一句话定义", "用一句完整的话写清上位概念、核心属性与适用边界。"],
      ["标准答题版", "【定义】\n\n【核心内涵】\n\n【形成机制或结构】\n\n【意义与应用】"],
      ["核心机制与结构", "- 关键要素：\n- 作用关系：\n- 形成过程："],
      ["意义与应用", "说明该概念为何重要，以及它如何用于解释、判断、解决问题或指导实践。"],
      ["易混概念辨析", "| 概念 | 共同点 | 核心差异 | 易错点 |\n| --- | --- | --- | --- |\n|  |  |  |  |"],
      ["30秒默写版", "- 定义：\n- 机制：\n- 意义："],
      ["问题与迁移", "- 基础回忆：\n- 简答或论述：\n- 案例与实践迁移："],
      ["来源与核验", "- 来源：\n- 待核验：\n- 相关卡片：" ]
    ]
  },
  comparison: {
    label: CARD_KIND_LABELS.comparison,
    sections: [
      ["辨析结论", "先用一句话说明二者最关键的关系与区别。"],
      ["标准答题版", "【共同语境】\n\n【概念A】\n\n【概念B】\n\n【核心区别】\n\n【应用判断】"],
      ["共同点", "- 共同研究对象：\n- 共同理论背景：\n- 共同应用范围："],
      ["差异维度", "| 维度 | 概念A | 概念B |\n| --- | --- | --- |\n| 定义 |  |  |\n| 尺度 |  |  |\n| 机制 |  |  |\n| 应用 |  |  |"],
      ["易错表述与判断", "- 不能互换的情形：\n- 可以联系的情形：\n- 常见错误："],
      ["30秒默写版", "- 共同点：\n- 核心差异：\n- 判断口诀："],
      ["问题与迁移", "- 直接比较题：\n- 综合论述中的使用：\n- 案例或实践判断："],
      ["来源与核验", "- 来源：\n- 待核验：\n- 相关卡片：" ]
    ]
  },
  "exam-transfer": {
    label: CARD_KIND_LABELS["exam-transfer"],
    sections: [
      ["任务与目标", "写出原始问题、使用场景，以及真正需要掌握的知识或能力。"],
      ["标准答题版", "【破题】\n\n【核心论点】\n\n【分论点一】\n\n【分论点二】\n\n【案例与结论】"],
      ["背景与前置知识", "- 理论背景：\n- 前置知识：\n- 与既有问题的关系："],
      ["解决框架", "1. \n2. \n3. \n4. "],
      ["案例与迁移", "- 典型案例：\n- 反例：\n- 跨情境应用：\n- 实践判断："],
      ["30秒默写版", "- 破题句：\n- 三个核心论点：\n- 结论："],
      ["变式题", "- 概念替换：\n- 尺度变化：\n- 反向设问：\n- 综合论述："],
      ["来源与核验", "- 原题来源：\n- 参考答案来源：\n- 待核验：\n- 相关卡片：" ]
    ]
  }
};

export function buildCardMarkdown(draft: CardDraft, createdDate: string): string {
  const error = validateCardDraft(draft);
  if (error) throw new Error(error);
  const normalizedYears = normalizeYears(draft.examYears);
  const template = CARD_TEMPLATES[draft.kind];
  const frontmatter = [
    "---",
    "type: recall-card",
    `card_type: ${template.label}`,
    `subject: ${yamlSubject(draft.subject.trim())}`,
    `module: ${yamlScalar(draft.module.trim())}`,
    `topic: ${yamlScalar(draft.topic.trim())}`,
    "aliases: []",
    "keywords: []",
    "related: []",
    `exam_years: [${normalizedYears.join(", ")}]`,
    `frequency: ${yamlScalar(draft.frequency.trim())}`,
    `status: ${yamlScalar(draft.status.trim())}`,
    `review_priority: ${draft.reviewPriority}`,
    "source: recall-garden",
    `created: ${createdDate}`,
    "---"
  ];
  const sections = template.sections.map(([title, body], index) => `## ${index + 1}. ${title}\n\n${body}`);
  return `${frontmatter.join("\n")}\n\n# ${draft.topic.trim()}\n\n${sections.join("\n\n")}\n`;
}

export function validateCardDraft(draft: CardDraft): string | null {
  if (!validRequiredText(draft.topic)) return "请填写题名，且不要包含换行。";
  if (!validRequiredText(draft.subject)) return "请填写科目，且不要包含换行。";
  if (!validRequiredText(draft.module)) return "请填写模块，且不要包含换行。";
  if (!validRequiredText(draft.frequency)) return "请选择频次。";
  if (!validRequiredText(draft.status)) return "请选择状态。";
  return null;
}

export function parseExamYearsInput(value: string): number[] {
  const years = [...value.matchAll(/(?:19|20)\d{2}/g)].map((match) => Number(match[0]));
  return normalizeYears(years);
}

export function buildUniqueCardPath(
  scanFolder: string,
  draft: Pick<CardDraft, "topic" | "subject" | "module">,
  exists: (path: string) => boolean
): string {
  const folder = normalizeVaultPath(scanFolder);
  const module = sanitizePathSegment(draft.module);
  const topic = sanitizePathSegment(draft.topic);
  const parent = [folder, module].filter(Boolean).join("/");
  const baseName = `card-${topic}`;
  let suffix = 1;
  while (true) {
    const candidateName = suffix === 1 ? `${baseName}.md` : `${baseName}-${suffix}.md`;
    const candidate = [parent, candidateName].filter(Boolean).join("/");
    if (!exists(candidate)) return candidate;
    suffix += 1;
  }
}

export function buildBasesDashboard(scanFolder: string): string {
  const folder = escapeBaseString(normalizeVaultPath(scanFolder));
  const commonOrder = ["file.name", "subject", "module", "exam_years", "frequency", "status", "review_priority"];
  const view = (
    name: string,
    options: { filter?: string; groupBy?: string; order?: string[] } = {}
  ): string[] => {
    const lines = ["  - type: table", `    name: ${JSON.stringify(name)}`];
    if (options.filter) lines.push("    filters:", `      and:`, `        - '${options.filter}'`);
    if (options.groupBy) {
      lines.push("    groupBy:", `      property: ${options.groupBy}`, "      direction: ASC");
    }
    lines.push("    order:", ...(options.order ?? commonOrder).map((property) => `      - ${property}`));
    return lines;
  };
  const globalFilters = [
    ...(folder ? [`    - 'file.inFolder("${folder}")'`] : []),
    `    - '(${SUPPORTED_CARD_TYPES.map((type) => `type == "${type}"`).join(" || ")})'`
  ];
  return [
    "filters:",
    "  and:",
    ...globalFilters,
    "properties:",
    "  file.name:",
    "    displayName: 卡片",
    "  subject:",
    "    displayName: 科目",
    "  module:",
    "    displayName: 模块",
    "  exam_years:",
    "    displayName: 真题年份",
    "  frequency:",
    "    displayName: 频次",
    "  status:",
    "    displayName: 状态",
    "  review_priority:",
    "    displayName: 优先级",
    "views:",
    ...view("全部卡片"),
    ...view("历年真题", { filter: "list(exam_years).length > 0" }),
    ...view("高频卡", { filter: "/^(高频|中高频)/.matches(frequency)" }),
    ...view("S级优先", { filter: 'review_priority == "S"' }),
    ...view("待处理", { filter: 'status.contains("待")' }),
    ...view("按科目", { groupBy: "subject" }),
    ""
  ].join("\n");
}

function normalizeYears(values: readonly number[]): number[] {
  return [...new Set(values.filter((year) => Number.isInteger(year) && year >= 1900 && year <= 2100))]
    .sort((left, right) => left - right);
}

function normalizeVaultPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|#[\]^]/g, "·")
    .replace(/\.{2,}/g, "·")
    .replace(/·+/g, "·")
    .replace(/^[.\s·]+|[.\s·]+$/g, "") || "未分类";
}

function yamlSubject(value: string): string {
  return /^\d+$/.test(value) ? String(Number(value)) : yamlScalar(value);
}

function yamlScalar(value: string): string {
  if (/^[\p{L}\p{N}_·（）()／/+-]+$/u.test(value) && !/^(?:true|false|null|~)$/i.test(value)) return value;
  return JSON.stringify(value);
}

function escapeBaseString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/'/g, "''");
}

function validRequiredText(value: string): boolean {
  return Boolean(value.trim()) && !/[\r\n]/.test(value);
}
