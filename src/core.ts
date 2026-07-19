export const INTERVAL_MINUTES = [20, 1_440, 2_880, 5_760, 10_080, 21_600, 43_200, 86_400] as const;

export type Rating = 1 | 2 | 3 | 4;

export interface RatingCriterion {
  rating: Rating;
  label: string;
  description: string;
}

export const RATING_CRITERIA: readonly RatingCriterion[] = [
  { rating: 1, label: "重来", description: "定义或核心机制答错" },
  { rating: 2, label: "困难", description: "知道主题，但漏关键机制" },
  { rating: 3, label: "良好", description: "定义和主体结构完整" },
  { rating: 4, label: "轻松", description: "能辨析、迁移且无需提示" }
] as const;

export interface ParsedSection {
  number: number | null;
  title: string;
  body: string;
}

export interface SchedulePreview {
  stage: number;
  dueAt: string;
  intervalMinutes: number;
}

export function parseLevelTwoSections(markdown: string): ParsedSection[] {
  const headingPattern = /^##\s+(?:(\d+)\.\s*)?(.+?)\s*$/gm;
  const matches: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(markdown)) !== null) {
    matches.push(match);
  }

  return matches.map((headingMatch, index) => {
    const bodyStart = headingMatch.index + headingMatch[0].length;
    const bodyEnd = index + 1 < matches.length ? (matches[index + 1].index ?? markdown.length) : markdown.length;
    return {
      number: headingMatch[1] ? Number(headingMatch[1]) : null,
      title: headingMatch[2].trim(),
      body: markdown.slice(bodyStart, bodyEnd).trim()
    };
  });
}

export function normalizeSectionTitle(title: string): string {
  return title.replace(/[\s　]/g, "").toLowerCase();
}

export function isCompleteEightSectionCard(sections: ParsedSection[]): boolean {
  const numbers = new Set(sections.map((section) => section.number).filter((value): value is number => value !== null));
  return [1, 2, 3, 4, 5, 6, 7, 8].every((number) => numbers.has(number));
}

export function findStandardAnswer(sections: ParsedSection[]): string | null {
  const section = sections.find((candidate) => {
    const title = normalizeSectionTitle(candidate.title);
    return title.includes("标准答题版") || title.includes("标准答案") || title.includes("完整答案");
  });
  return section?.body || null;
}

export function findShortAnswer(sections: ParsedSection[]): string | null {
  const section = sections.find((candidate) => /30秒(?:默写|答题|复习)?版/.test(normalizeSectionTitle(candidate.title)));
  return section?.body || null;
}

export function computeSchedule(currentStage: number | null, rating: Rating, now: Date): SchedulePreview {
  const lastStage = INTERVAL_MINUTES.length - 1;
  const stageBeforeReview = currentStage ?? -1;
  let stage: number;
  let intervalMinutes: number;

  if (rating === 1) {
    stage = Math.max(0, stageBeforeReview - 2);
    intervalMinutes = 10;
  } else if (rating === 2) {
    stage = Math.max(0, stageBeforeReview - 1);
    intervalMinutes = Math.max(12, Math.round(INTERVAL_MINUTES[stage] * 0.6));
  } else if (rating === 3) {
    stage = Math.min(lastStage, stageBeforeReview + 1);
    intervalMinutes = INTERVAL_MINUTES[stage];
  } else {
    stage = Math.min(lastStage, stageBeforeReview + 2);
    intervalMinutes = INTERVAL_MINUTES[stage];
  }

  return {
    stage,
    intervalMinutes,
    dueAt: new Date(now.getTime() + intervalMinutes * 60_000).toISOString()
  };
}

export function formatInterval(minutes: number): string {
  if (minutes < 60) return `${minutes}分钟`;
  if (minutes < 1_440) return `${Math.round(minutes / 60)}小时`;
  return `${Math.round(minutes / 1_440)}天`;
}
