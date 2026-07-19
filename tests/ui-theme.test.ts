import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const styles = readFileSync(join(root, "styles.css"), "utf8");
const mainSource = readFileSync(join(root, "src", "main.ts"), "utf8");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as { version: string };

describe("v1.0.0 AI learning interface", () => {
  it("publishes the calendar, countdown and AI verification releases", () => {
    expect(manifest.version).toBe("1.0.0");
    expect(styles).toContain("Recall Garden v0.9.3 · Nebula Blue");
    expect(styles).toContain("Recall Garden v0.9.4 · Skin manager");
    expect(styles).toContain("Recall Garden v0.9.5 · Built-in study calendar");
    expect(styles).toContain("Recall Garden v0.9.6 · Exam countdown");
    expect(styles).toContain("Recall Garden v0.9.7 · AI note verification");
    expect(styles).toContain("Recall Garden v0.9.8 · Safe verification write-back");
    expect(styles).toContain("Recall Garden v0.9.9 · Saved verification reports");
    expect(styles).toContain("Recall Garden v0.9.10 · Responsive card header");
    expect(styles).toContain("Recall Garden v0.9.11 · Complete verification issues");
    expect(styles).toContain("Recall Garden v0.9.12 · Precise exam countdown");
    expect(styles).toContain("Recall Garden v1.0.0 · AI learning pack");
    expect(styles).toContain(".recall-garden-calendar-grid");
    expect(styles).toContain(".recall-garden-calendar-detail");
    expect(styles).toContain(".recall-garden-exam-countdown");
    expect(styles).toContain("@container garden-review-view (max-width: 460px)");
    expect(styles).toContain(".recall-garden-verification-modal");
    expect(styles).toContain(".recall-garden-verification-issue");
    expect(styles).toContain(".recall-garden-verification-apply");
    expect(styles).toContain(".recall-garden-verification-replacement");
    expect(styles).toContain(".recall-garden-verification-saved-meta");
    expect(styles).toContain(".recall-garden-learning-preview");
    expect(styles).toContain(".recall-garden-learning-grid");
  });

  it("gates one-click AI learning write-back behind a full preview", () => {
    expect(mainSource).toContain("new AiLearningPreviewModal");
    expect(mainSource).toContain('text: "确认并写回全部"');
    expect(mainSource).toContain("applyAiLearningPackWithQuestionBank(latest, pack, existingQuestions)");
    expect(mainSource).toContain("card?.reviewId ?? this.data.sourceIds[file.path]");
    expect(mainSource).toContain('this.renderSummaryChip(summary, "原有AI题库"');
    expect(mainSource).toContain('this.renderCardHeading(questionBankCard, "原有AI变式练习"');
    expect(mainSource).toContain('text: "AI学习补全"');
  });

  it("keeps the verification report wide, bounded, and internally scrollable", () => {
    expect(styles).toContain(".modal.recall-garden-verification-shell");
    expect(styles).toContain("width: min(920px, calc(100% - 32px));");
    expect(styles).toContain("max-height: min(86vh, 820px);");
    expect(styles).toMatch(
      /\.recall-garden-verification-modal\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s,
    );
    expect(styles).toMatch(
      /\.recall-garden-verification-modal\s*\{[^}]*max-height:\s*min\(86vh, 820px\);/s,
    );
    expect(styles).toContain("max-height: calc(100vh - 42px);");
    expect(styles).toMatch(
      /\.recall-garden-verification-issues\s*\{[^}]*flex:\s*1 1 auto;[^}]*overflow-y:\s*auto;/s,
    );
    expect(styles).toMatch(
      /\.recall-garden-verification-issues\s*\{[^}]*overflow-x:\s*hidden;/s,
    );
    expect(styles).toContain(
      "grid-template-columns: minmax(54px, 0.72fr) repeat(2, minmax(84px, 1.15fr));",
    );
  });

  it("wires per-issue safe write-back without closing the report", () => {
    expect(mainSource).toContain('this.modalEl.addClass("recall-garden-verification-shell")');
    expect(mainSource).toContain("const canApply = hasReplacement && !this.context.isStale");
    expect(mainSource).toContain('text: this.context.isStale');
    expect(mainSource).toContain('"重新核验后修订"');
    expect(mainSource).toContain("applyNoteVerificationReplacement(latest, issue)");
    expect(mainSource).toContain("this.app.vault.process(file");
    expect(mainSource).toContain('status.setText("已写回原笔记")');
    expect(mainSource).toContain('cls: "recall-garden-verification-replacement"');
  });

  it("auto-saves and reopens the latest report without another AI call", () => {
    expect(mainSource).toContain("new NoteVerificationStore(this.app)");
    expect(mainSource).toContain("await this.verificationStore.save(report, markdown)");
    expect(mainSource).toContain('id: "open-saved-verification-report"');
    expect(mainSource).toContain('text: "报告"');
    expect(mainSource).toContain("loaded.isStale");
  });

  it("defines a shared blue glass visual system", () => {
    expect(styles).toContain("--garden-blue:");
    expect(styles).toContain("--garden-cyan:");
    expect(styles).toContain("--garden-glass:");
    expect(styles).toContain("--garden-glow:");
    expect(styles).toContain("backdrop-filter: blur(");
  });

  it("keeps mobile, touch and reduced-motion fallbacks", () => {
    expect(styles).toContain("@media (hover: hover)");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain("@media (max-width: 700px)");
  });

  it("adapts rating cards to narrow Obsidian leaves without text overflow", () => {
    expect(styles).toContain("container-name: garden-rating-panel;");
    expect(styles).toContain("@container garden-rating-panel (max-width: 620px)");
    expect(styles).toContain("@container garden-rating-panel (max-width: 330px)");
    expect(styles).toMatch(/\.recall-garden-rating-criterion\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
    expect(styles).toMatch(/\.recall-garden-rating-criterion\s*\{[^}]*white-space:\s*normal;/s);
  });

  it("moves the three card actions out of the title width on medium leaves", () => {
    expect(styles).toContain("@container garden-review-view (max-width: 760px)");
    expect(styles).toMatch(
      /@container garden-review-view \(max-width: 760px\)[\s\S]*?\.recall-garden-card-header\s*\{[^}]*flex-direction:\s*column;/,
    );
    expect(styles).toMatch(
      /@container garden-review-view \(max-width: 760px\)[\s\S]*?\.recall-garden-card-actions\s*\{[^}]*width:\s*100%;[^}]*justify-content:\s*flex-end;/,
    );
  });

  it("keeps every verification issue at content height when the report has many issues", () => {
    expect(styles).toMatch(
      /\.recall-garden-verification-issues\s*\{[^}]*grid-auto-rows:\s*max-content;[^}]*align-content:\s*start;/s,
    );
  });

  it("renders a four-part live exam clock and disposes its timer with the review view", () => {
    expect(styles).toContain(".recall-garden-exam-time-part");
    expect(styles).toContain("font-variant-numeric: tabular-nums");
    expect(mainSource).toContain('createTimePart("天")');
    expect(mainSource).toContain('createTimePart("秒")');
    expect(mainSource).toContain("this.stopExamCountdown?.();");
    expect(mainSource).toContain("window.clearTimeout(timer)");
  });
});
