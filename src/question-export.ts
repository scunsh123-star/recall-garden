import type { AiQuestion, ChoiceQuestion, FillQuestion, MatchingQuestion } from "./ai";

export const QUESTION_BANK_START = "<!-- recall-garden:question-bank:start -->";
export const QUESTION_BANK_END = "<!-- recall-garden:question-bank:end -->";
const QUESTION_BANK_VERSION_PREFIX = "<!-- recall-garden:question-bank-version:";

export interface QuestionBankInspection {
  noteQuestionIds: string[];
  noteVersion: string | null;
  expectedVersion: string | null;
  versionMatches: boolean;
}

export function buildQuestionBankBlock(questions: readonly AiQuestion[], existingBlock = ""): string {
  const existingQuestions = extractExistingQuestionBlocks(existingBlock);
  const rendered = questions.map((question) =>
    existingQuestions.get(question.id) ?? renderQuestionBlock(question)
  );
  return [
    QUESTION_BANK_START,
    `${QUESTION_BANK_VERSION_PREFIX}${questionBankVersion(questions)} -->`,
    "## AI 变式题库（忆园托管）",
    "",
    "> [!info] 使用说明",
    "> 单选题安装 quizblock 后可直接交互；填空与连线题使用 Obsidian 原生折叠答案。请在忆园中管理题目，不要移动托管标记。",
    "",
    ...rendered.flatMap((block, index) => index === rendered.length - 1 ? [block] : [block, ""]),
    QUESTION_BANK_END
  ].join("\n");
}

export function inspectQuestionBank(markdown: string, questions: readonly AiQuestion[]): QuestionBankInspection {
  const start = markdown.indexOf(QUESTION_BANK_START);
  const end = markdown.indexOf(QUESTION_BANK_END, start + QUESTION_BANK_START.length);
  if (start < 0 || end < 0) {
    const expectedVersion = questions.length > 0 ? questionBankVersion(questions) : null;
    return { noteQuestionIds: [], noteVersion: null, expectedVersion, versionMatches: expectedVersion === null };
  }
  const block = markdown.slice(start, end + QUESTION_BANK_END.length);
  const noteQuestionIds = [...block.matchAll(/<!-- recall-garden:question:([A-Za-z0-9_-]+):start -->/g)]
    .map((match) => match[1]);
  const versionMatch = block.match(/<!-- recall-garden:question-bank-version:([a-f0-9]{8}) -->/i);
  const noteVersion = versionMatch?.[1]?.toLowerCase() ?? null;
  const expectedVersion = questions.length > 0 ? questionBankVersion(questions) : null;
  return {
    noteQuestionIds,
    noteVersion,
    expectedVersion,
    versionMatches: noteVersion === expectedVersion && sameStringSet(noteQuestionIds, questions.map((question) => question.id))
  };
}

export function upsertQuestionBank(markdown: string, questions: readonly AiQuestion[]): string {
  const start = markdown.indexOf(QUESTION_BANK_START);
  const end = markdown.indexOf(QUESTION_BANK_END, start + QUESTION_BANK_START.length);
  const hasManagedBlock = start >= 0 && end >= 0;

  if (questions.length === 0) {
    if (!hasManagedBlock) return markdown;
    return joinWithoutManagedBlock(
      markdown.slice(0, start),
      markdown.slice(end + QUESTION_BANK_END.length)
    );
  }

  if (hasManagedBlock) {
    const oldBlock = markdown.slice(start, end + QUESTION_BANK_END.length);
    const replacement = buildQuestionBankBlock(questions, oldBlock);
    return `${markdown.slice(0, start)}${replacement}${markdown.slice(end + QUESTION_BANK_END.length)}`;
  }

  return `${markdown.trimEnd()}\n\n${buildQuestionBankBlock(questions)}\n`;
}

function renderQuestionBlock(question: AiQuestion): string {
  const start = `<!-- recall-garden:question:${question.id}:start -->`;
  const end = `<!-- recall-garden:question:${question.id}:end -->`;
  const body = question.type === "choice"
    ? renderChoice(question)
    : question.type === "fill"
      ? renderFill(question)
      : renderMatching(question);
  return `${start}\n${body}\n${end}`;
}

function renderChoice(question: ChoiceQuestion): string {
  const lines = ["### 单选题", "", "```quiz", compactLine(question.prompt)];
  question.options.forEach((option, index) => {
    lines.push(`${index === question.answerIndex ? "[c]" : "[ ]"} ${compactLine(option)}`);
  });
  if (question.explanation.trim()) lines.push("", safeFenceText(question.explanation));
  lines.push("```");
  return lines.join("\n");
}

function renderFill(question: FillQuestion): string {
  const accepted = question.acceptedAnswers.filter((answer) => answer !== question.answer);
  const lines = [
    "### 填空题",
    "",
    "> [!question] 填空题",
    `> ${compactLine(question.prompt)}`,
    ">",
    "> > [!success]- 点击核对答案",
    `> > **答案：** ${compactLine(question.answer)}`
  ];
  if (accepted.length > 0) lines.push(`> > **可接受答案：** ${accepted.map(compactLine).join("、")}`);
  if (question.explanation.trim()) lines.push(...calloutLines(question.explanation, "> > "));
  return lines.join("\n");
}

function renderMatching(question: MatchingQuestion): string {
  const lines = [
    "### 连线题",
    "",
    "> [!question] 连线题",
    `> ${compactLine(question.prompt)}`,
    ">"
  ];
  question.pairs.forEach((pair, index) => lines.push(`> ${index + 1}. ${compactLine(pair.left)}`));
  lines.push(">", "> > [!success]- 点击核对配对");
  question.pairs.forEach((pair) => lines.push(`> > - ${compactLine(pair.left)} → ${compactLine(pair.right)}`));
  if (question.explanation.trim()) lines.push(...calloutLines(question.explanation, "> > "));
  return lines.join("\n");
}

function extractExistingQuestionBlocks(markdown: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const pattern = /<!-- recall-garden:question:([A-Za-z0-9_-]+):start -->[\s\S]*?<!-- recall-garden:question:\1:end -->/g;
  for (const match of markdown.matchAll(pattern)) blocks.set(match[1], match[0]);
  return blocks;
}

function compactLine(value: string): string {
  return safeFenceText(value).replace(/\s*\r?\n\s*/g, " ").trim();
}

function safeFenceText(value: string): string {
  return value.replace(/```/g, "''' ").trim();
}

function calloutLines(value: string, prefix: string): string[] {
  return safeFenceText(value).split(/\r?\n/).map((line) => `${prefix}${line}`);
}

function joinWithoutManagedBlock(before: string, after: string): string {
  const left = before.trimEnd();
  const right = after.trimStart();
  if (!left) return right ? `${right}\n` : "";
  if (!right) return `${left}\n`;
  return `${left}\n\n${right}`;
}

function questionBankVersion(questions: readonly AiQuestion[]): string {
  const canonical = questions.map((question) => {
    const shared = { id: question.id, type: question.type, prompt: question.prompt, explanation: question.explanation };
    if (question.type === "choice") return { ...shared, options: question.options, answerIndex: question.answerIndex };
    if (question.type === "fill") return { ...shared, answer: question.answer, acceptedAnswers: question.acceptedAnswers };
    return { ...shared, pairs: question.pairs };
  });
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify(canonical)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}
