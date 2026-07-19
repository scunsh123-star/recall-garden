import { describe, expect, it } from "vitest";
import type { AiQuestion } from "../src/ai";
import {
  buildQuestionBankBlock,
  inspectQuestionBank,
  upsertQuestionBank
} from "../src/question-export";

const base = {
  reviewId: "rg_card",
  sourcePath: "Recall Garden/Cards/Web/card-HTTP caching.md",
  explanation: "用于解释核心机制。",
  createdAt: "2026-07-14T00:00:00.000Z",
  provider: "deepseek" as const,
  model: "deepseek-chat",
  attempts: 0,
  correctCount: 0,
  lastAnsweredAt: ""
};

function questions(): AiQuestion[] {
  return [
    {
      ...base,
      id: "choice-1",
      type: "choice",
      prompt: "HTTP缓存最核心的作用是什么？",
      options: ["增加重复传输", "复用可用响应并减少请求成本", "禁用状态码", "删除所有响应头"],
      answerIndex: 1
    },
    {
      ...base,
      id: "fill-1",
      type: "fill",
      prompt: "HTTP缓存通过复用____减少重复传输。",
      answer: "已有响应",
      acceptedAnswers: ["缓存响应"]
    },
    {
      ...base,
      id: "matching-1",
      type: "matching",
      prompt: "将缓存指令与作用配对。",
      pairs: [
        { left: "max-age", right: "声明新鲜时间" },
        { left: "no-store", right: "禁止存储响应" }
      ]
    }
  ];
}

describe("AI题库回写", () => {
  it("选择题输出合法 quizblock，填空和连线输出可折叠原生 Markdown", () => {
    const block = buildQuestionBankBlock(questions());

    expect(block).toContain("```quiz\nHTTP缓存最核心的作用是什么？");
    expect(block).toContain("[c] 复用可用响应并减少请求成本");
    expect(block.match(/^\[c\]/gm)).toHaveLength(1);
    expect(block).toContain("> [!question] 填空题");
    expect(block).toContain("> > **答案：** 已有响应");
    expect(block).toContain("> [!question] 连线题");
    expect(block).toContain("> > - max-age → 声明新鲜时间");
  });

  it("重复同步保留 quizblock 已写入笔记的作答标记，并加入新题而不复制旧题", () => {
    const original = upsertQuestionBank("# HTTP caching\n\n八段式正文。\n", [questions()[0]])
      .replace("[c] 复用可用响应并减少请求成本", "[r] 复用可用响应并减少请求成本");
    const updated = upsertQuestionBank(original, questions().slice(0, 2));

    expect(updated).toContain("[r] 复用可用响应并减少请求成本");
    expect(updated.match(/recall-garden:question:choice-1:start/g)).toHaveLength(1);
    expect(updated).toContain("recall-garden:question:fill-1:start");
  });

  it("只替换托管题库，删除已移除的题目并完整保留八段式正文和手写内容", () => {
    const body = "# HTTP caching\n\n## 1. 概念\n原正文。\n\n## 8. 30秒默写版\n原答案。\n";
    const withBank = upsertQuestionBank(body, questions());
    const synced = upsertQuestionBank(`${withBank}\n我的手写尾注。\n`, [questions()[1]]);

    expect(synced).toContain(body.trim());
    expect(synced).toContain("我的手写尾注。");
    expect(synced).not.toContain("choice-1");
    expect(synced).not.toContain("matching-1");
    expect(synced.match(/<!-- recall-garden:question-bank:start -->/g)).toHaveLength(1);
  });

  it("题库清空后显式同步会移除整个托管区块，正文保持不变", () => {
    const body = "# HTTP caching\n\n## 1. 概念\n原正文。\n";
    const withBank = `${upsertQuestionBank(body, questions())}\n区块外尾注。\n`;
    const cleared = upsertQuestionBank(withBank, []);

    expect(cleared).not.toContain("recall-garden:question-bank");
    expect(cleared).toContain(body.trim());
    expect(cleared).toContain("区块外尾注。");
  });

  it("写入稳定题库版本，供卡片体检识别原笔记是否落后", () => {
    const synced = upsertQuestionBank("# HTTP caching\n", questions());
    const status = inspectQuestionBank(synced, questions());

    expect(status.noteQuestionIds).toEqual(["choice-1", "fill-1", "matching-1"]);
    expect(status.versionMatches).toBe(true);
    expect(status.expectedVersion).toMatch(/^[a-f0-9]{8}$/);
    expect(inspectQuestionBank(synced.replace(status.expectedVersion!, "deadbeef"), questions()).versionMatches).toBe(false);
  });
});
