import {
  App,
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderer,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  SecretComponent,
  Setting,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
  parseYaml,
  requireApiVersion,
  setIcon
} from "obsidian";
import {
  RATING_CRITERIA,
  Rating,
  findShortAnswer,
  findStandardAnswer,
  formatInterval,
  isCompleteEightSectionCard,
  parseLevelTwoSections
} from "./core";
import {
  AiProvider,
  AiQuestion,
  AiQuestionType,
  AiService,
  DeviceLoginInfo,
  normalizeAnswer,
  questionTypeLabel
} from "./ai";
import {
  CURRENT_DATA_VERSION,
  RecallGardenData,
  UnknownSchemaVersionError,
  assignReviewId,
  buildReviewRecord,
  createEmptyData,
  migrateData,
  reconcileSources,
  updateSourcePath
} from "./data";
import { getFsrsRetrievability, previewFsrsSchedule, seedFsrsStateFromLegacy } from "./fsrs-scheduler";
import {
  DueForecast,
  QueueCardMetadata,
  QueueReason,
  ReviewPriority,
  buildDueForecast,
  buildPrioritizedQueue,
  normalizeExamYears,
  normalizeReviewPriority
} from "./queue";
import {
  RecallGardenSnapshot,
  SnapshotDiff,
  createSnapshot,
  diffSnapshots,
  parseSnapshot,
  prepareRestoredData
} from "./snapshot";
import {
  CARD_KIND_LABELS,
  CardDraft,
  CardKind,
  buildBasesDashboard,
  buildCardMarkdown,
  buildUniqueCardPath,
  isRecallCardType,
  parseExamYearsInput,
  validateCardDraft
} from "./authoring";
import {
  FreeReviewMode,
  buildFreeReviewQueue as createFreeReviewQueue
} from "./free-review";
import {
  buildDailyPlanDocument,
  upsertDailyPlan
} from "./planning";
import { inspectQuestionBank, upsertQuestionBank } from "./question-export";
import {
  StoredReviewSession,
  StoredSessionMode,
  reconcileSessionQueue,
  resolveSessionScrollTop,
  restoreStoredSessionQueue,
  sessionQueuesEqual
} from "./session";
import { projectReviewRecord } from "./shadow-events";
import { ShadowStore, ShadowStoreStatus } from "./shadow-store";
import {
  CardHealthInput,
  CardHealthIssue,
  DiagnosticGroup,
  DiagnosticReport,
  DiagnosticSnapshot,
  buildDiagnosticReport,
  inspectCardHealth
} from "./diagnostics";
import { UI_SKINS, UiSkin, applyUiSkin, normalizeUiSkin } from "./ui-skin";
import {
  StudyCalendarDay,
  StudyCalendarMonth,
  buildStudyCalendarMonth,
  localDateKey as calendarDateKey
} from "./calendar";
import { ExamCountdownConfig, buildExamCountdown } from "./exam-countdown";
import {
  NoteVerificationIssue,
  NoteVerificationReport,
  NoteVerificationReplacementStatus,
  applyNoteVerificationReplacement,
  noteVerificationSeverityLabel,
  noteVerificationTypeLabel
} from "./note-verification";
import { NoteVerificationStore } from "./note-verification-store";
import {
  AiLearningPack,
  applyAiLearningPackWithQuestionBank,
  buildAiLearningWritebackPreview
} from "./ai-learning";

const VIEW_TYPE_RECALL_GARDEN = "recall-garden-review";
const VIEW_TYPE_RECALL_GARDEN_DIAGNOSTICS = "recall-garden-diagnostics";
const VIEW_TYPE_RECALL_GARDEN_CALENDAR = "recall-garden-calendar";
const SNAPSHOT_FOLDER = "Recall Garden Backups";
const GENERATED_FOLDER = "Recall Garden";
const BASES_DASHBOARD_PATH = `${GENERATED_FOLDER}/忆园资料库.base`;
const DAILY_PLAN_FOLDER = `${GENERATED_FOLDER}/学习计划`;

interface ReviewCard extends QueueCardMetadata {
  reviewId: string;
  sourcePath: string;
  title: string;
  subject: string;
  module: string;
  examYears: number[];
  frequency: string;
  status: string;
  reviewPriority: ReviewPriority | null;
  shortAnswer: string;
  fullAnswer: string;
  completeEightSections: boolean;
  queueReason: QueueReason | null;
}

interface GardenStats {
  total: number;
  due: number;
  newCards: number;
  reviewed: number;
  mastered: number;
  masteryRate: number;
  errors: number;
  archived: number;
  subjects: Array<[string, number]>;
}

export default class RecallGardenPlugin extends Plugin {
  data: RecallGardenData = createEmptyData();
  cards: ReviewCard[] = [];
  aiService!: AiService;
  dataReadOnlyReason: string | null = null;
  private needsSchemaMigrationSave = false;
  private scanTimer: number | null = null;
  private hasScannedVault = false;
  private shadowStore!: ShadowStore;
  private verificationStore!: NoteVerificationStore;
  private healthIssues: CardHealthIssue[] = [];
  private diagnosticSnapshots: DiagnosticSnapshot[] = [];

  async onload(): Promise<void> {
    await this.loadPluginData();
    this.shadowStore = new ShadowStore(this.app, this.manifest.version);
    this.verificationStore = new NoteVerificationStore(this.app);
    if (requireApiVersion("1.11.4")) {
      this.aiService = new AiService(this.app, () => this.data.settings);
    }

    this.registerView(VIEW_TYPE_RECALL_GARDEN, (leaf) => new RecallGardenView(leaf, this));
    this.registerView(VIEW_TYPE_RECALL_GARDEN_DIAGNOSTICS, (leaf) => new RecallGardenDiagnosticsView(leaf, this));
    this.registerView(VIEW_TYPE_RECALL_GARDEN_CALENDAR, (leaf) => new RecallGardenCalendarView(leaf, this));
    this.addRibbonIcon("sprout", "打开 Recall Garden｜忆园", () => void this.activateView());
    this.addRibbonIcon("chart-no-axes-combined", "打开忆园诊断中心", () => void this.activateDiagnosticsView());
    this.addRibbonIcon("calendar-days", "打开忆园学习日历", () => void this.activateCalendarView());
    this.addRibbonIcon("file-plus-2", "新建忆园卡", () => this.openCardCreator());
    this.addCommand({
      id: "open-review-view",
      name: "打开今日复习",
      callback: () => void this.activateView()
    });
    this.addCommand({
      id: "rescan-cards",
      name: "重新扫描学习卡",
      callback: async () => {
        await this.scanVault({ resetSessions: true });
        new Notice(`忆园已识别 ${this.cards.length} 张学习卡`);
      }
    });
    this.addCommand({
      id: "open-diagnostics-view",
      name: "打开可行动诊断中心",
      callback: () => void this.activateDiagnosticsView()
    });
    this.addCommand({
      id: "open-study-calendar",
      name: "打开学习日历",
      callback: () => void this.activateCalendarView()
    });
    this.addCommand({
      id: "create-review-card",
      name: "新建八段式复习卡",
      callback: () => this.openCardCreator()
    });
    this.addCommand({
      id: "generate-bases-dashboard",
      name: "生成或更新忆园资料库",
      callback: () => void this.generateBasesDashboard()
    });
    this.addCommand({
      id: "generate-daily-study-plan",
      name: "生成或更新今日学习计划",
      callback: () => void this.generateDailyStudyPlan()
    });
    this.addCommand({
      id: "generate-ai-question-for-active-note",
      name: "为当前学习卡生成AI单选题",
      callback: () => void this.generateForActiveFile("choice")
    });
    this.addCommand({
      id: "generate-ai-learning-pack-for-active-note",
      name: "AI学习补全当前笔记（30秒版、八段式与练习）",
      callback: () => void this.generateAiLearningForActiveNote()
    });
    this.addCommand({
      id: "verify-active-note-with-ai",
      name: "AI核验当前笔记",
      callback: () => void this.verifyActiveNote()
    });
    this.addCommand({
      id: "open-saved-verification-report",
      name: "查看当前笔记上次核验报告",
      callback: () => void this.openSavedVerificationForActiveNote()
    });
    this.addCommand({
      id: "sync-ai-questions-to-active-note",
      name: "同步当前学习卡AI题库到原笔记",
      callback: () => void this.syncQuestionsForActiveFile()
    });
    this.addCommand({
      id: "export-data-snapshot",
      name: "导出数据快照",
      callback: () => void this.exportDataSnapshot()
    });
    this.addCommand({
      id: "restore-data-snapshot",
      name: "从数据快照恢复",
      callback: () => this.openSnapshotPicker()
    });
    this.addCommand({
      id: "verify-shadow-event-log",
      name: "检查影子评分事件日志",
      callback: () => void this.verifyShadowEventLog(true)
    });
    this.addSettingTab(new RecallGardenSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      if (this.dataReadOnlyReason) {
        new Notice(`忆园已进入只读保护：${this.dataReadOnlyReason}`, 0);
        return;
      }
      if (this.needsSchemaMigrationSave) {
        try {
          const backupPath = await this.exportDataSnapshot(`pre-schema-v${CURRENT_DATA_VERSION}`);
          await this.savePluginData();
          this.needsSchemaMigrationSave = false;
          new Notice(`忆园数据已安全升级到 v${CURRENT_DATA_VERSION}；升级前快照：${backupPath}`, 10_000);
        } catch (error) {
          new Notice(error instanceof Error ? `忆园数据升级失败，已停止写入：${error.message}` : "忆园数据升级失败，已停止写入", 0);
          return;
        }
      }
      const shadowStatus = await this.shadowStore.initialize(this.data.records);
      if (!shadowStatus.chainValid) {
        new Notice(`忆园影子事件日志异常，评分仍会保存到 v5 主数据，但已停止追加影子日志：${shadowStatus.error}`, 0);
      }
      await this.scanVault();
      this.registerEvent(this.app.vault.on("create", () => this.scheduleScan()));
      this.registerEvent(this.app.vault.on("modify", () => this.scheduleScan()));
      this.registerEvent(this.app.vault.on("delete", () => this.scheduleScan()));
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) void this.handleRename(file, oldPath);
      }));
    });
  }

  onunload(): void {
    if (this.scanTimer !== null) window.clearTimeout(this.scanTimer);
  }

  private async loadPluginData(): Promise<void> {
    const loaded = await this.loadData();
    try {
      const rawVersion = typeof loaded === "object" && loaded !== null && "version" in loaded
        ? Number((loaded as { version?: unknown }).version ?? 1)
        : 1;
      this.data = migrateData(loaded);
      this.dataReadOnlyReason = null;
      this.needsSchemaMigrationSave = loaded !== null && loaded !== undefined &&
        (!Number.isFinite(rawVersion) || rawVersion < CURRENT_DATA_VERSION);
    } catch (error) {
      if (error instanceof UnknownSchemaVersionError) {
        this.data = createEmptyData();
        this.dataReadOnlyReason = `${error.message}。为防止覆盖，当前版本不会写入 data.json。`;
        return;
      }
      throw error;
    }
  }

  async savePluginData(): Promise<void> {
    if (this.dataReadOnlyReason) {
      new Notice(`忆园只读保护：${this.dataReadOnlyReason}`, 8_000);
      return;
    }
    await this.saveData(this.data);
  }

  private scheduleScan(): void {
    if (this.scanTimer !== null) window.clearTimeout(this.scanTimer);
    this.scanTimer = window.setTimeout(() => {
      this.scanTimer = null;
      void this.scanVault();
    }, 800);
  }

  private async handleRename(file: TFile, oldPath: string): Promise<void> {
    if (!this.dataReadOnlyReason) {
      const reviewId = updateSourcePath(this.data, oldPath, file.path);
      if (reviewId) await this.savePluginData();
    }
    try {
      await this.verificationStore.rename(oldPath, file.path);
    } catch (error) {
      new Notice(error instanceof Error ? `核验报告未能跟随重命名：${error.message}` : "核验报告未能跟随重命名", 8_000);
    }
    this.scheduleScan();
  }

  async scanVault(options: { resetSessions?: boolean } = {}): Promise<void> {
    if (this.dataReadOnlyReason) return;
    const folder = normalizePath(this.data.settings.folder.trim()).replace(/\/$/, "");
    const prefix = folder.length > 0 ? `${folder}/` : "";
    const allMarkdownFiles = this.app.vault.getMarkdownFiles();
    const existingVaultPaths = new Set(allMarkdownFiles.map((file) => file.path));
    const files = allMarkdownFiles.filter((file) => folder.length === 0 || file.path === folder || file.path.startsWith(prefix));
    const cards: ReviewCard[] = [];
    const healthInputs: CardHealthInput[] = [];
    const activeSourcePaths = new Set<string>();
    let dataChanged = false;

    for (const file of files) {
      const markdown = await this.app.vault.cachedRead(file);
      const frontmatter = this.readFrontmatter(file, markdown);
      if (!isRecallCardType(frontmatter.type)) continue;

      const sections = parseLevelTwoSections(markdown);
      const shortAnswer = findShortAnswer(sections);
      const fullAnswer = findStandardAnswer(sections);
      const existingReviewId = this.data.sourceIds[file.path] ?? null;
      const questions = existingReviewId ? this.data.questions[existingReviewId] ?? [] : [];
      const bank = inspectQuestionBank(markdown, questions);
      const healthInput: CardHealthInput = {
        sourcePath: file.path,
        reviewId: existingReviewId,
        title: this.readTitle(file, markdown, frontmatter),
        sectionNumbers: sections.flatMap((section) => section.number === null ? [] : [section.number]),
        frontmatter,
        shortAnswer,
        fullAnswer,
        dataQuestionIds: questions.map((question) => question.id),
        noteQuestionIds: bank.noteQuestionIds,
        noteQuestionBankVersion: bank.noteVersion,
        expectedQuestionBankVersion: bank.expectedVersion
      };
      if (!shortAnswer || !fullAnswer) {
        healthInputs.push(healthInput);
        continue;
      }

      const completeEightSections = isCompleteEightSectionCard(sections);
      if (this.data.settings.strictEightSections && !completeEightSections) {
        healthInputs.push(healthInput);
        continue;
      }

      const hadActiveId = Boolean(this.data.sourceIds[file.path]);
      const reviewId = assignReviewId(this.data, file.path, () => this.createReviewId());
      healthInput.reviewId = reviewId;
      healthInputs.push(healthInput);
      if (!hadActiveId) dataChanged = true;
      activeSourcePaths.add(file.path);

      cards.push({
        reviewId,
        sourcePath: file.path,
        title: this.readTitle(file, markdown, frontmatter),
        subject: this.frontmatterText(frontmatter.subject),
        module: this.frontmatterText(frontmatter.module),
        examYears: normalizeExamYears(frontmatter.exam_years),
        frequency: this.frontmatterText(frontmatter.frequency),
        status: this.frontmatterText(frontmatter.status),
        reviewPriority: normalizeReviewPriority(frontmatter.review_priority),
        shortAnswer,
        fullAnswer,
        completeEightSections,
        queueReason: null
      });
    }

    cards.sort((left, right) => `${left.subject}-${left.module}-${left.title}`.localeCompare(`${right.subject}-${right.module}-${right.title}`, "zh-CN"));
    const archived = reconcileSources(this.data, activeSourcePaths, existingVaultPaths);
    if (archived.length > 0) dataChanged = true;
    this.cards = cards;
    this.healthIssues = inspectCardHealth(healthInputs);
    if (dataChanged) await this.savePluginData();
    await this.updateDiagnosticSnapshot();
    const firstScan = !this.hasScannedVault;
    const resetSessions = options.resetSessions === true || firstScan;
    this.hasScannedVault = true;
    if (resetSessions) {
      this.refreshOpenViews({ restoreSession: firstScan });
    } else {
      this.refreshScannedCards();
    }
    this.refreshDiagnosticsViews();
  }

  private readFrontmatter(file: TFile, markdown: string): Record<string, unknown> {
    const cached = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (cached) return cached as Record<string, unknown>;

    const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
    if (!match) return {};
    try {
      return (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private readTitle(file: TFile, markdown: string, frontmatter: Record<string, unknown>): string {
    const topic = this.frontmatterText(frontmatter.topic);
    if (topic) return topic;
    const heading = markdown.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
    return heading || file.basename;
  }

  private frontmatterText(value: unknown): string {
    if (Array.isArray(value)) return value.map(String).join("、");
    return value === undefined || value === null ? "" : String(value).trim();
  }

  private createReviewId(): string {
    const random = Math.random().toString(36).slice(2, 10);
    return `rg_${Date.now().toString(36)}_${random}`;
  }

  openCardCreator(): void {
    if (this.dataReadOnlyReason) {
      new Notice(`只读保护中，不能新建忆园卡：${this.dataReadOnlyReason}`, 8_000);
      return;
    }
    new CardCreatorModal(this.app, this, this.authoringSeed()).open();
  }

  getSuggestedCardPath(draft: CardDraft): string {
    return buildUniqueCardPath(
      this.data.settings.folder,
      draft,
      (path) => this.app.vault.getAbstractFileByPath(path) !== null
    );
  }

  async createCardFromDraft(draft: CardDraft): Promise<TFile> {
    if (this.dataReadOnlyReason) throw new Error(this.dataReadOnlyReason);
    const error = validateCardDraft(draft);
    if (error) throw new Error(error);
    const path = this.getSuggestedCardPath(draft);
    await this.ensureFolderExists(path.split("/").slice(0, -1).join("/"));
    const file = await this.app.vault.create(path, buildCardMarkdown(draft, localDateString(new Date())));
    await this.scanVault({ resetSessions: true });
    await this.app.workspace.getLeaf(true).openFile(file);
    new Notice(`忆园卡已创建：${file.path}`, 6_000);
    return file;
  }

  async generateBasesDashboard(): Promise<TFile> {
    await this.ensureFolderExists(GENERATED_FOLDER);
    const content = buildBasesDashboard(this.data.settings.folder);
    const existing = this.app.vault.getAbstractFileByPath(BASES_DASHBOARD_PATH);
    let file: TFile;
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, () => content);
      file = existing;
    } else if (existing) {
      throw new Error(`${BASES_DASHBOARD_PATH} 已被同名文件夹占用`);
    } else {
      file = await this.app.vault.create(BASES_DASHBOARD_PATH, content);
    }
    await this.app.workspace.getLeaf(true).openFile(file);
    new Notice("忆园资料库已生成；若显示为源码，请先启用 Obsidian 内置 Bases。", 8_000);
    return file;
  }

  async generateDailyStudyPlan(): Promise<TFile> {
    const dateKey = localDateString(new Date());
    const path = `${DAILY_PLAN_FOLDER}/${dateKey}.md`;
    await this.ensureFolderExists(DAILY_PLAN_FOLDER);
    const queue = this.buildTodayQueue();
    const input = {
      dateKey,
      dueCount: queue.filter((card) => card.queueReason !== "new").length,
      newCount: queue.filter((card) => card.queueReason === "new").length,
      weakCount: this.buildFreeReviewQueue("weak").length,
      forecast: this.getDueForecast()
    };
    const existing = this.app.vault.getAbstractFileByPath(path);
    let file: TFile;
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, (current) => upsertDailyPlan(current, input));
      file = existing;
    } else if (existing) {
      throw new Error(`${path} 已被同名文件夹占用`);
    } else {
      file = await this.app.vault.create(path, buildDailyPlanDocument(input));
    }
    await this.app.workspace.getLeaf(true).openFile(file);
    new Notice("今日学习计划已更新；Tasks 未安装时也可作为普通 Markdown 清单使用。", 7_000);
    return file;
  }

  private authoringSeed(): CardDraft {
    const activePath = this.app.workspace.getActiveFile()?.path;
    const source = this.cards.find((card) => card.sourcePath === activePath);
    return {
      kind: "definition",
      topic: "",
      subject: source?.subject ?? "",
      module: source?.module ?? "",
      examYears: [],
      frequency: "待判断",
      status: "待完善",
      reviewPriority: "B"
    };
  }

  private async ensureFolderExists(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath).replace(/^\/+|\/+$/g, "");
    if (!normalized) return;
    let current = "";
    for (const segment of normalized.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing) throw new Error(`${current} 已被同名文件占用`);
      await this.app.vault.createFolder(current);
    }
  }

  buildTodayQueue(): ReviewCard[] {
    return buildPrioritizedQueue(this.cards, this.data.records, {
      now: new Date(),
      dailyNewCards: this.data.settings.dailyNewCards,
      dailyReviewLimit: this.data.settings.dailyReviewLimit,
      pauseNewCards: this.data.settings.pauseNewCards
    }).map(({ card, reason }) => ({ ...card, queueReason: reason }));
  }

  buildFreeReviewQueue(mode: FreeReviewMode): ReviewCard[] {
    return createFreeReviewQueue(this.cards, this.data.records, mode, new Date())
      .map((card) => ({ ...card, queueReason: null }));
  }

  getDueForecast(): DueForecast {
    return buildDueForecast(this.data.records, new Set(this.cards.map((card) => card.reviewId)), {
      now: new Date(),
      days: 7,
      dailyNewCards: this.data.settings.dailyNewCards,
      dailyReviewLimit: this.data.settings.dailyReviewLimit,
      pauseNewCards: this.data.settings.pauseNewCards
    });
  }

  getDiagnosticReport(): DiagnosticReport {
    const now = new Date();
    return buildDiagnosticReport(this.cards.map((card) => {
      const record = this.data.records[card.reviewId];
      return {
        reviewId: card.reviewId,
        sourcePath: card.sourcePath,
        title: card.title,
        subject: card.subject,
        module: card.module,
        frequency: card.frequency,
        examYears: card.examYears,
        retrievability: getFsrsRetrievability(record?.fsrs ?? null, now, this.data.settings)
      };
    }), this.data.records, this.diagnosticSnapshots, now);
  }

  getStudyCalendarMonth(year: number, monthIndex: number, now = new Date()): StudyCalendarMonth {
    const calendarCards = this.cards.flatMap((card) => {
      const record = this.data.records[card.reviewId];
      if (!record) return [];
      return [{
        reviewId: card.reviewId,
        nextReviewAt: record.nextReviewAt,
        isExam: card.examYears.length > 0,
        history: record.history.map((attempt) => ({
          reviewedAt: attempt.reviewedAt,
          rating: attempt.rating
        }))
      }];
    });
    const activeReviewIds = new Set(calendarCards.map((card) => card.reviewId));
    const archivedHistory = Object.values(this.data.archived).flatMap((entry) => {
      if (!entry.record || activeReviewIds.has(entry.reviewId)) return [];
      return [{
        reviewId: entry.reviewId,
        nextReviewAt: null,
        isExam: false,
        history: entry.record.history.map((attempt) => ({
          reviewedAt: attempt.reviewedAt,
          rating: attempt.rating
        }))
      }];
    });
    return buildStudyCalendarMonth([...calendarCards, ...archivedHistory], this.diagnosticSnapshots, year, monthIndex, now);
  }

  getCardsByReviewIds(reviewIds: readonly string[]): ReviewCard[] {
    const wanted = new Set(reviewIds);
    return this.cards.filter((card) => wanted.has(card.reviewId));
  }

  getHealthIssues(): CardHealthIssue[] {
    return this.healthIssues.map((issue) => ({ ...issue }));
  }

  private async updateDiagnosticSnapshot(): Promise<void> {
    if (!this.shadowStore.getStatus().initialized) return;
    const now = new Date();
    const currentDebt = this.cards.filter((card) => {
      const due = Date.parse(this.data.records[card.reviewId]?.nextReviewAt ?? "");
      return Number.isFinite(due) && due <= now.getTime();
    }).length;
    const dateKey = localDateString(now);
    const introducedToday = Object.values(this.data.records).filter((record) =>
      localDateString(new Date(record.introducedAt)) === dateKey
    ).length;
    try {
      await this.shadowStore.saveDiagnosticSnapshot({
        dateKey,
        capturedAt: now.toISOString(),
        currentDebt,
        activeCards: this.cards.length,
        introducedToday
      });
      this.diagnosticSnapshots = await this.shadowStore.loadDiagnosticSnapshots();
    } catch {
      this.diagnosticSnapshots = await this.shadowStore.loadDiagnosticSnapshots();
    }
  }

  async setPauseNewCards(paused: boolean): Promise<void> {
    this.data.settings.pauseNewCards = paused;
    await this.savePluginData();
    this.refreshOpenViews();
  }

  getStats(): GardenStats {
    const now = Date.now();
    const records = this.data.records;
    const reviewedCards = this.cards.filter((card) => records[card.reviewId] !== undefined);
    const mastered = reviewedCards.filter((card) => {
      const record = records[card.reviewId];
      const matureEnough = record.fsrs ? record.fsrs.stability >= 7 : record.stage >= 4;
      return matureEnough && record.lastRating !== 1;
    }).length;
    const subjects = new Map<string, number>();
    for (const card of this.cards) {
      const subject = card.subject || "未分类";
      subjects.set(subject, (subjects.get(subject) ?? 0) + 1);
    }

    return {
      total: this.cards.length,
      due: this.cards.filter((card) => {
        const record = records[card.reviewId];
        return record !== undefined && Date.parse(record.nextReviewAt) <= now;
      }).length,
      newCards: this.cards.filter((card) => records[card.reviewId] === undefined).length,
      reviewed: reviewedCards.length,
      mastered,
      masteryRate: reviewedCards.length === 0 ? 0 : Math.round((mastered / reviewedCards.length) * 100),
      errors: Object.values(records).reduce((sum, record) => sum + record.errorCount, 0),
      archived: Object.keys(this.data.archived).length,
      subjects: Array.from(subjects.entries()).sort((left, right) => right[1] - left[1])
    };
  }

  previewRating(card: ReviewCard, rating: Rating): string {
    const record = this.data.records[card.reviewId];
    const now = new Date();
    const state = record?.fsrs ?? (record ? seedFsrsStateFromLegacy(record, now) : null);
    return formatInterval(previewFsrsSchedule(state, now, this.data.settings)[rating].intervalMinutes);
  }

  async rateCard(
    card: ReviewCard,
    rating: Rating,
    evidence: { revealLevel: 0 | 1 | 2; durationSeconds: number | null }
  ): Promise<void> {
    const existing = this.data.records[card.reviewId];
    const before = existing ? projectReviewRecord(existing) : null;
    const reviewedAt = new Date();
    const updated = buildReviewRecord(
      existing,
      card.reviewId,
      card.sourcePath,
      rating,
      evidence,
      reviewedAt,
      this.data.settings
    );
    this.data.records[card.reviewId] = updated;
    await this.savePluginData();
    try {
      await this.shadowStore.appendReview({
        rating,
        revealLevel: evidence.revealLevel,
        durationSeconds: evidence.durationSeconds,
        before,
        after: projectReviewRecord(updated)
      });
    } catch (error) {
      new Notice(
        `本次评分已安全保存到 v5 主数据，但影子事件写入失败：${error instanceof Error ? error.message : "未知错误"}`,
        10_000
      );
    }
    await this.updateDiagnosticSnapshot();
    this.refreshDiagnosticsViews();
  }

  getShadowStoreStatus(): ShadowStoreStatus {
    return this.shadowStore.getStatus();
  }

  async verifyShadowEventLog(showNotice = false): Promise<ShadowStoreStatus> {
    const status = await this.shadowStore.verify();
    if (showNotice) {
      new Notice(
        status.chainValid
          ? `影子事件链完整：${status.eventCount} 条事件 · 设备 ${shortDeviceId(status.deviceId)}`
          : `影子事件链异常：${status.error}`,
        status.chainValid ? 6_000 : 0
      );
    }
    return status;
  }

  async loadStoredReviewSession(): Promise<StoredReviewSession | null> {
    return this.shadowStore.loadSession();
  }

  async saveStoredReviewSession(session: StoredReviewSession): Promise<void> {
    await this.shadowStore.saveSession(session);
  }

  getQuestions(card: ReviewCard): AiQuestion[] {
    return this.data.questions[card.reviewId] ?? [];
  }

  async generateAiQuestion(card: ReviewCard, type: AiQuestionType): Promise<void> {
    if (!this.aiService) {
      new Notice("AI 功能需要 Obsidian 1.11.4 或更高版本");
      return;
    }
    if (this.data.settings.aiProvider === "disabled") {
      new Notice("请先在忆园设置中启用 Codex 或 DeepSeek");
      return;
    }

    const notice = new Notice(`正在生成${questionTypeLabel(type)}…`, 0);
    try {
      const question = await this.aiService.generateQuestion(card, type);
      notice.hide();
      new AiQuestionPreviewModal(this.app, question, async () => {
        const questions = this.data.questions[card.reviewId] ?? [];
        this.data.questions[card.reviewId] = [question, ...questions].slice(0, 100);
        await this.savePluginData();
        this.refreshOpenCards();
        new Notice(`${questionTypeLabel(type)}已保存到本卡题库`);
      }).open();
    } catch (error) {
      notice.hide();
      new Notice(error instanceof Error ? error.message : "AI 出题失败", 10_000);
    }
  }

  async generateAiLearningPack(card: ReviewCard): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(card.sourcePath);
    if (!(file instanceof TFile)) {
      new Notice("找不到原笔记，无法生成AI学习包");
      return;
    }
    await this.generateAiLearningForFile(file, card);
  }

  async verifyNote(card: ReviewCard): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(card.sourcePath);
    if (!(file instanceof TFile)) {
      new Notice("找不到原笔记，无法进行 AI 核验");
      return;
    }
    await this.verifyNoteFile(file, card);
  }

  async openSavedVerification(card: ReviewCard): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(card.sourcePath);
    if (!(file instanceof TFile)) {
      new Notice("找不到原笔记，无法打开已保存的核验报告");
      return;
    }
    await this.openSavedVerificationFile(file, card);
  }

  async recordQuestionAttempt(question: AiQuestion, correct: boolean): Promise<void> {
    const questions = this.data.questions[question.reviewId] ?? [];
    const stored = questions.find((item) => item.id === question.id);
    if (!stored) return;
    stored.attempts += 1;
    stored.correctCount += correct ? 1 : 0;
    stored.lastAnsweredAt = new Date().toISOString();
    await this.savePluginData();
  }

  async deleteQuestion(question: AiQuestion): Promise<void> {
    const questions = this.data.questions[question.reviewId] ?? [];
    this.data.questions[question.reviewId] = questions.filter((item) => item.id !== question.id);
    await this.savePluginData();
    this.refreshOpenCards();
    new Notice("题目已从忆园删除；若曾回写原笔记，请再次同步题库。", 6_000);
  }

  async syncQuestionBank(card: ReviewCard): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(card.sourcePath);
    if (!(file instanceof TFile)) throw new Error("找不到原笔记，无法同步AI题库");
    const questions = this.getQuestions(card);
    await this.app.vault.process(file, (markdown) => upsertQuestionBank(markdown, questions));
    new Notice(
      questions.length > 0
        ? `已同步 ${questions.length} 道AI题到原笔记；单选题安装 quizblock 后可交互。`
        : "原笔记中的忆园托管题库已移除。",
      7_000
    );
  }

  async refreshCodexModels(): Promise<string[]> {
    if (!this.aiService) throw new Error("当前 Obsidian 版本不支持安全密钥存储");
    const models = await this.aiService.listCodexModels();
    if (models.length === 0) throw new Error("Codex 没有返回可用模型，请稍后重试或手动填写模型名");
    this.data.settings.codexModels = models;
    if (!models.includes(this.data.settings.codexModel)) this.data.settings.codexModel = models[0];
    await this.savePluginData();
    return models;
  }

  async exportDataSnapshot(label = "snapshot"): Promise<string> {
    if (this.dataReadOnlyReason) throw new Error(`只读保护中，无法导出已解析数据：${this.dataReadOnlyReason}`);
    const folder = normalizePath(SNAPSHOT_FOLDER);
    if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.adapter.mkdir(folder);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeLabel = label.replace(/[^a-z0-9-]/gi, "-").replace(/-+/g, "-");
    const path = normalizePath(`${folder}/recall-garden-${safeLabel}-${stamp}.json`);
    const snapshot = createSnapshot(this.data, this.manifest.version);
    await this.app.vault.adapter.write(path, `${JSON.stringify(snapshot, null, 2)}\n`);
    if (label === "snapshot") new Notice(`忆园数据快照已导出：${path}`, 8_000);
    return path;
  }

  openSnapshotPicker(): void {
    if (this.dataReadOnlyReason) {
      new Notice(`只读保护中，不能恢复快照：${this.dataReadOnlyReason}`, 8_000);
      return;
    }
    const prefix = `${normalizePath(SNAPSHOT_FOLDER)}/`;
    const files = this.app.vault.getFiles().filter((file) => file.extension === "json" && file.path.startsWith(prefix));
    if (files.length === 0) {
      new Notice(`没有找到快照。请先导出，或把快照放入 ${SNAPSHOT_FOLDER} 文件夹。`, 8_000);
      return;
    }
    new SnapshotPickerModal(this.app, files, (file) => void this.previewSnapshotRestore(file)).open();
  }

  async applySnapshot(snapshot: RecallGardenSnapshot): Promise<void> {
    if (this.dataReadOnlyReason) throw new Error(this.dataReadOnlyReason);
    const backupPath = await this.exportDataSnapshot("pre-restore");
    this.data = prepareRestoredData(this.data, snapshot.data);
    await this.savePluginData();
    await this.scanVault({ resetSessions: true });
    new Notice(`快照恢复完成。导入前备份：${backupPath}`, 10_000);
  }

  private async previewSnapshotRestore(file: TFile): Promise<void> {
    try {
      const raw = await this.app.vault.read(file);
      const snapshot = parseSnapshot(JSON.parse(raw) as unknown);
      const diff = diffSnapshots(this.data, snapshot.data);
      new RestorePreviewModal(this.app, file, snapshot, diff, async () => {
        await this.applySnapshot(snapshot);
      }).open();
    } catch (error) {
      new Notice(error instanceof Error ? `无法读取快照：${error.message}` : "无法读取快照", 10_000);
    }
  }

  private async generateForActiveFile(type: AiQuestionType): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("请先打开一张学习卡笔记");
      return;
    }
    let card = this.cards.find((item) => item.sourcePath === activeFile.path);
    if (!card) {
      await this.scanVault();
      card = this.cards.find((item) => item.sourcePath === activeFile.path);
    }
    if (!card) {
      new Notice("当前笔记不是忆园已识别的学习卡");
      return;
    }
    await this.generateAiQuestion(card, type);
  }

  private async generateAiLearningForActiveNote(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || activeFile.extension !== "md") {
      new Notice("请先打开一篇 Markdown 学习笔记");
      return;
    }
    let card = this.cards.find((item) => item.sourcePath === activeFile.path);
    if (!card) {
      await this.scanVault();
      card = this.cards.find((item) => item.sourcePath === activeFile.path);
    }
    await this.generateAiLearningForFile(activeFile, card);
  }

  private async generateAiLearningForFile(file: TFile, card?: ReviewCard): Promise<void> {
    if (!this.aiService) {
      new Notice("AI 功能需要 Obsidian 1.11.4 或更高版本");
      return;
    }
    if (this.data.settings.aiProvider === "disabled") {
      new Notice("请先在忆园设置中启用 Codex 或 DeepSeek");
      return;
    }

    const notice = new Notice(`正在生成《${card?.title ?? file.basename}》AI学习包…`, 0);
    try {
      const sourceMarkdown = await this.app.vault.cachedRead(file);
      const frontmatter = this.readFrontmatter(file, sourceMarkdown);
      const title = card?.title ?? this.readTitle(file, sourceMarkdown, frontmatter);
      const pack = await this.aiService.generateLearningPack({
        sourcePath: file.path,
        title,
        subject: card?.subject ?? this.frontmatterText(frontmatter.subject),
        module: card?.module ?? this.frontmatterText(frontmatter.module),
        markdown: sourceMarkdown
      });
      const existingReviewId = card?.reviewId ?? this.data.sourceIds[file.path];
      const existingQuestions = existingReviewId ? this.data.questions[existingReviewId] ?? [] : [];
      notice.hide();
      new AiLearningPreviewModal(this.app, sourceMarkdown, pack, existingQuestions, async () => {
        const outcome: {
          sourceChanged: boolean;
          writeResult: ReturnType<typeof applyAiLearningPackWithQuestionBank> | null;
        } = { sourceChanged: false, writeResult: null };
        await this.app.vault.process(file, (latest) => {
          if (latest !== sourceMarkdown) {
            outcome.sourceChanged = true;
            return latest;
          }
          outcome.writeResult = applyAiLearningPackWithQuestionBank(latest, pack, existingQuestions);
          return outcome.writeResult.markdown;
        });
        const writeResult = outcome.writeResult;
        if (outcome.sourceChanged || !writeResult) {
          throw new Error("预览后原笔记已发生变化。为避免覆盖，请重新生成并确认。");
        }
        await this.scanVault();
        const sectionText = writeResult.insertedSectionNumbers.length > 0
          ? `，补齐第 ${writeResult.insertedSectionNumbers.join("、")} 段`
          : "";
        const questionText = existingQuestions.length > 0 ? `，原有AI题库 ${existingQuestions.length} 道已同步` : "";
        new Notice(`AI学习包已写回《${title}》：30秒版已更新${sectionText}，新练习区块已同步${questionText}。`, 8_000);
      }).open();
    } catch (error) {
      notice.hide();
      new Notice(error instanceof Error ? error.message : "AI学习包生成失败", 10_000);
    }
  }

  private async verifyActiveNote(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || activeFile.extension !== "md") {
      new Notice("请先打开一篇 Markdown 笔记");
      return;
    }
    const card = this.cards.find((item) => item.sourcePath === activeFile.path);
    await this.verifyNoteFile(activeFile, card);
  }

  private async openSavedVerificationForActiveNote(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || activeFile.extension !== "md") {
      new Notice("请先打开一篇 Markdown 笔记");
      return;
    }
    const card = this.cards.find((item) => item.sourcePath === activeFile.path);
    await this.openSavedVerificationFile(activeFile, card);
  }

  private async openSavedVerificationFile(file: TFile, card?: ReviewCard): Promise<void> {
    try {
      const markdown = await this.app.vault.cachedRead(file);
      const loaded = await this.verificationStore.load(file.path, markdown);
      if (!loaded) {
        new Notice("这篇笔记还没有已保存的核验报告，请先执行一次 AI 核验");
        return;
      }
      new AiNoteVerificationModal(
        this.app,
        loaded.saved.report,
        () => void this.openSourcePath(file.path),
        {
          savedAt: loaded.saved.savedAt,
          isStale: loaded.isStale,
          onReverify: () => void this.verifyNoteFile(file, card)
        }
      ).open();
    } catch (error) {
      new Notice(error instanceof Error ? `无法读取已保存的核验报告：${error.message}` : "无法读取已保存的核验报告", 10_000);
    }
  }

  private async verifyNoteFile(file: TFile, card?: ReviewCard): Promise<void> {
    if (!this.aiService) {
      new Notice("AI 功能需要 Obsidian 1.11.4 或更高版本");
      return;
    }
    if (this.data.settings.aiProvider === "disabled") {
      new Notice("请先在忆园设置中启用 Codex 或 DeepSeek");
      return;
    }

    const notice = new Notice(`正在核验《${card?.title ?? file.basename}》…`, 0);
    try {
      const markdown = await this.app.vault.cachedRead(file);
      const frontmatter = this.readFrontmatter(file, markdown);
      const report = await this.aiService.verifyNote({
        sourcePath: file.path,
        title: card?.title ?? this.readTitle(file, markdown, frontmatter),
        subject: card?.subject ?? this.frontmatterText(frontmatter.subject),
        module: card?.module ?? this.frontmatterText(frontmatter.module),
        markdown
      });
      let savedAt: string | null = null;
      try {
        const saved = await this.verificationStore.save(report, markdown);
        savedAt = saved.savedAt;
      } catch (error) {
        new Notice(
          error instanceof Error ? `报告已生成，但自动保存失败：${error.message}` : "报告已生成，但自动保存失败",
          10_000
        );
      }
      notice.hide();
      new AiNoteVerificationModal(
        this.app,
        report,
        () => void this.openSourcePath(file.path),
        {
          savedAt,
          isStale: false,
          onReverify: () => void this.verifyNoteFile(file, card)
        }
      ).open();
    } catch (error) {
      notice.hide();
      new Notice(error instanceof Error ? error.message : "AI 笔记核验失败", 10_000);
    }
  }

  private async syncQuestionsForActiveFile(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("请先打开一张学习卡笔记");
      return;
    }
    let card = this.cards.find((item) => item.sourcePath === activeFile.path);
    if (!card) {
      await this.scanVault();
      card = this.cards.find((item) => item.sourcePath === activeFile.path);
    }
    if (!card) {
      new Notice("当前笔记不是忆园已识别的学习卡");
      return;
    }
    try {
      await this.syncQuestionBank(card);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "同步AI题库失败", 8_000);
    }
  }

  async openSource(card: ReviewCard): Promise<void> {
    await this.openSourcePath(card.sourcePath);
  }

  async openSourcePath(sourcePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) {
      new Notice("找不到原笔记，可能已在 Obsidian 外部移动");
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async startDiagnosticQueue(reviewIds: readonly string[], label: string): Promise<void> {
    const byId = new Map(this.cards.map((card) => [card.reviewId, card]));
    const queue = reviewIds.flatMap((reviewId) => {
      const card = byId.get(reviewId);
      return card ? [{ ...card, queueReason: null }] : [];
    });
    if (queue.length === 0) {
      new Notice("这个诊断项目前没有可复习卡片");
      return;
    }
    await this.activateView();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_RECALL_GARDEN)[0];
    if (leaf?.view instanceof RecallGardenView) await leaf.view.startDiagnosticReview(queue, label);
  }

  async activateView(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_RECALL_GARDEN)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_RECALL_GARDEN, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  async activateDiagnosticsView(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_RECALL_GARDEN_DIAGNOSTICS)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_RECALL_GARDEN_DIAGNOSTICS, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  async activateCalendarView(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_RECALL_GARDEN_CALENDAR)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_RECALL_GARDEN_CALENDAR, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  refreshOpenViews(options: { restoreSession?: boolean } = {}): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RECALL_GARDEN)) {
      const view = leaf.view;
      if (view instanceof RecallGardenView) void view.reloadSession(options.restoreSession === true);
    }
  }

  refreshUiSkin(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RECALL_GARDEN)) {
      const view = leaf.view;
      if (view instanceof RecallGardenView) view.applySkin();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RECALL_GARDEN_DIAGNOSTICS)) {
      const view = leaf.view;
      if (view instanceof RecallGardenDiagnosticsView) view.applySkin();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RECALL_GARDEN_CALENDAR)) {
      const view = leaf.view;
      if (view instanceof RecallGardenCalendarView) view.applySkin();
    }
  }

  refreshExamCountdownViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RECALL_GARDEN)) {
      const view = leaf.view;
      if (view instanceof RecallGardenView) void view.refreshCard();
    }
  }

  private refreshScannedCards(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RECALL_GARDEN)) {
      const view = leaf.view;
      if (view instanceof RecallGardenView) void view.refreshAfterScan();
    }
  }

  private refreshOpenCards(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RECALL_GARDEN)) {
      const view = leaf.view;
      if (view instanceof RecallGardenView) void view.refreshCard();
    }
  }

  private refreshDiagnosticsViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RECALL_GARDEN_DIAGNOSTICS)) {
      const view = leaf.view;
      if (view instanceof RecallGardenDiagnosticsView) void view.renderView();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RECALL_GARDEN_CALENDAR)) {
      const view = leaf.view;
      if (view instanceof RecallGardenCalendarView) void view.renderView();
    }
  }

}

class RecallGardenView extends ItemView {
  private plugin: RecallGardenPlugin;
  private queue: ReviewCard[] = [];
  private freeReviewMode: FreeReviewMode | null = null;
  private revealStep = 0;
  private reviewActions = 0;
  private activeQuestionId: string | null = null;
  private questionResult: { id: string; correct: boolean } | null = null;
  private timedReviewId: string | null = null;
  private cardStartedAt = Date.now();
  private sessionSaveTimer: number | null = null;
  private stopExamCountdown: (() => void) | null = null;
  private lastKnownScrollTop = 0;
  private diagnosticQueueLabel: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: RecallGardenPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_RECALL_GARDEN;
  }

  getDisplayText(): string {
    return "Recall Garden｜忆园";
  }

  getIcon(): string {
    return "sprout";
  }

  async onOpen(): Promise<void> {
    this.contentEl.setAttr("tabindex", "0");
    this.registerDomEvent(this.contentEl, "keydown", (event) => void this.handleKeydown(event));
    this.registerDomEvent(this.contentEl, "scroll", () => {
      this.lastKnownScrollTop = Math.max(0, this.contentEl.scrollTop);
      this.scheduleSessionSave(400);
    });
    await this.reloadSession(true);
  }

  async onClose(): Promise<void> {
    if (this.sessionSaveTimer !== null) window.clearTimeout(this.sessionSaveTimer);
    this.sessionSaveTimer = null;
    this.stopExamCountdown?.();
    this.stopExamCountdown = null;
    await this.persistSession();
  }

  async reloadSession(restoreStored = false): Promise<void> {
    if (restoreStored && await this.restoreStoredSession()) return;
    this.freeReviewMode = null;
    this.diagnosticQueueLabel = null;
    this.queue = this.plugin.buildTodayQueue();
    this.revealStep = 0;
    this.reviewActions = 0;
    this.activeQuestionId = null;
    this.questionResult = null;
    this.timedReviewId = null;
    await this.persistSession();
    await this.renderView();
  }

  async refreshCard(): Promise<void> {
    await this.renderView();
  }

  applySkin(): void {
    applyUiSkin(
      this.contentEl,
      this.plugin.data.settings.uiSkin,
      this.plugin.data.settings.enableVisualEffects
    );
  }

  async refreshAfterScan(): Promise<void> {
    const previousQueue = this.queue;
    const previousCardId = this.queue[0]?.reviewId ?? null;
    const nextQueue = reconcileSessionQueue(this.queue, this.plugin.cards);
    this.queue = nextQueue;
    const currentCardId = this.queue[0]?.reviewId ?? null;
    if (previousCardId !== currentCardId) this.resetCardState();
    if (!sessionQueuesEqual(previousQueue, nextQueue)) await this.renderView();
  }

  private async handleKeydown(event: KeyboardEvent): Promise<void> {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.key === " ") {
      event.preventDefault();
      if (this.queue.length === 0) return;
      this.revealStep = Math.min(2, this.revealStep + 1);
      await this.renderView();
      return;
    }
    if (this.freeReviewMode && this.queue.length > 0 && (event.key === "Enter" || event.key === "ArrowRight")) {
      event.preventDefault();
      await this.advanceFreeReview();
      return;
    }
    if (this.queue.length > 0 && ["1", "2", "3", "4"].includes(event.key)) {
      if (this.freeReviewMode) return;
      event.preventDefault();
      await this.submitRating(Number(event.key) as Rating);
    }
  }

  private async renderView(): Promise<void> {
    this.stopExamCountdown?.();
    this.stopExamCountdown = null;
    const container = this.contentEl;
    container.empty();
    container.addClass("recall-garden-view");
    this.applySkin();

    const header = container.createDiv({ cls: "recall-garden-header" });
    const brand = header.createDiv({ cls: "recall-garden-brand" });
    const brandMark = brand.createDiv({ cls: "recall-garden-brand-mark" });
    setIcon(brandMark, "sprout");
    const titleGroup = brand.createDiv({ cls: "recall-garden-brand-copy" });
    titleGroup.createDiv({ text: "ACTIVE RECALL", cls: "recall-garden-eyebrow" });
    titleGroup.createEl("h2", { text: "忆园" });
    titleGroup.createDiv({
      text: `FSRS-6 · 目标记忆率 ${Math.round(this.plugin.data.settings.desiredRetention * 100)}%`,
      cls: "recall-garden-subtitle"
    });
    const headerActions = header.createDiv({ cls: "recall-garden-header-actions" });
    const diagnosticsButton = headerActions.createEl("button", {
      cls: "clickable-icon recall-garden-header-action",
      attr: { "aria-label": "打开可行动诊断中心" }
    });
    setIcon(diagnosticsButton, "chart-no-axes-combined");
    diagnosticsButton.addEventListener("click", () => void this.plugin.activateDiagnosticsView());
    const calendarButton = headerActions.createEl("button", {
      cls: "clickable-icon recall-garden-header-action",
      attr: { "aria-label": "打开学习日历" }
    });
    setIcon(calendarButton, "calendar-days");
    calendarButton.addEventListener("click", () => void this.plugin.activateCalendarView());
    const createButton = headerActions.createEl("button", {
      cls: "clickable-icon recall-garden-header-action",
      attr: { "aria-label": "新建忆园卡" }
    });
    setIcon(createButton, "file-plus-2");
    createButton.addEventListener("click", () => this.plugin.openCardCreator());
    const planButton = headerActions.createEl("button", {
      cls: "clickable-icon recall-garden-header-action",
      attr: { "aria-label": "生成或更新今日学习计划" }
    });
    setIcon(planButton, "calendar-check-2");
    planButton.addEventListener("click", () => void this.plugin.generateDailyStudyPlan());
    const refreshButton = headerActions.createEl("button", { cls: "clickable-icon recall-garden-header-action", attr: { "aria-label": "重新扫描" } });
    setIcon(refreshButton, "refresh-cw");
    refreshButton.addEventListener("click", async () => {
      await this.plugin.scanVault({ resetSessions: true });
      new Notice(`已识别 ${this.plugin.cards.length} 张学习卡`);
    });

    this.stopExamCountdown = renderExamCountdown(container, {
      name: this.plugin.data.settings.examName,
      startDate: this.plugin.data.settings.examStartDate,
      endDate: this.plugin.data.settings.examEndDate
    });
    this.renderStats(container);

    if (this.freeReviewMode) this.renderFreeReviewBanner(container);

    if (this.queue.length === 0) {
      this.renderEmptyState(container);
      this.scheduleSessionSave();
      return;
    }

    const card = this.queue[0];
    this.syncCardTimer(card);
    this.renderProgress(container);

    const reasonClass = card.queueReason ? ` is-${card.queueReason}` : "";
    const cardEl = container.createDiv({ cls: `recall-garden-card${reasonClass}` });
    const cardHeader = cardEl.createDiv({ cls: "recall-garden-card-header" });
    const headline = cardHeader.createDiv({ cls: "recall-garden-card-headline" });
    this.renderCardMetadata(headline, card);
    headline.createEl("h2", { text: card.title, cls: "recall-garden-card-title" });
    const cardActions = cardHeader.createDiv({ cls: "recall-garden-card-actions" });
    const verifyButton = cardActions.createEl("button", { cls: "recall-garden-source-button recall-garden-verify-button", attr: { "aria-label": "AI 核验当前笔记" } });
    setIcon(verifyButton, "shield-check");
    verifyButton.createSpan({ text: "AI 核验" });
    verifyButton.addEventListener("click", () => void this.plugin.verifyNote(card));
    const reportButton = cardActions.createEl("button", { cls: "recall-garden-source-button recall-garden-report-button", attr: { "aria-label": "查看上次核验报告" } });
    setIcon(reportButton, "file-clock");
    reportButton.createSpan({ text: "报告" });
    reportButton.addEventListener("click", () => void this.plugin.openSavedVerification(card));
    const sourceButton = cardActions.createEl("button", { cls: "recall-garden-source-button", attr: { "aria-label": "打开原笔记" } });
    setIcon(sourceButton, "external-link");
    sourceButton.createSpan({ text: "原笔记" });
    sourceButton.addEventListener("click", () => void this.plugin.openSource(card));

    this.renderReviewStage(cardEl);
    cardEl.createDiv({ text: "先完整说出脑中的答案，再决定是否揭示。", cls: "recall-garden-prompt" });

    if (this.revealStep === 0) {
      const revealButton = cardEl.createEl("button", { text: "显示30秒版　Space", cls: "mod-cta recall-garden-reveal" });
      revealButton.addEventListener("click", async () => {
        this.revealStep = 1;
        await this.renderView();
      });
    }

    if (this.revealStep >= 1) {
      await this.renderAnswer(cardEl, "30秒默写版", card.shortAnswer, "recall-garden-answer-short");
    }

    if (this.revealStep === 1) {
      const fullButton = cardEl.createEl("button", { text: "显示完整答案　Space", cls: "recall-garden-reveal" });
      fullButton.addEventListener("click", async () => {
        this.revealStep = 2;
        await this.renderView();
      });
    }

    if (this.revealStep >= 2) {
      await this.renderAnswer(cardEl, "标准答题版", card.fullAnswer, "recall-garden-answer-full");
    }

    if (this.freeReviewMode) {
      this.renderFreeReviewControls(cardEl);
    } else {
      this.renderRatingButtons(cardEl, card);
    }
    this.renderAiTools(cardEl, card);

    window.setTimeout(() => this.contentEl.focus(), 0);
    this.scheduleSessionSave();
  }

  private async restoreStoredSession(): Promise<boolean> {
    const stored = await this.plugin.loadStoredReviewSession();
    if (!stored || !sameLocalDate(new Date(stored.savedAt), new Date()) || stored.queue.length === 0) return false;
    const queue = restoreStoredSessionQueue(stored.queue, this.plugin.cards);
    if (queue.length === 0) return false;
    this.queue = queue;
    this.freeReviewMode = stored.mode === "scheduled" ? null : stored.mode;
    this.revealStep = stored.revealStep;
    this.reviewActions = stored.reviewActions;
    const activeQuestionExists = stored.activeQuestionId !== null &&
      this.plugin.getQuestions(queue[0]).some((question) => question.id === stored.activeQuestionId);
    this.activeQuestionId = activeQuestionExists ? stored.activeQuestionId : null;
    this.questionResult = null;
    this.timedReviewId = null;
    await this.renderView();
    this.contentEl.scrollTop = stored.scrollTop;
    this.lastKnownScrollTop = stored.scrollTop;
    this.scheduleSessionSave();
    return true;
  }

  private scheduleSessionSave(delay = 120): void {
    if (this.sessionSaveTimer !== null) window.clearTimeout(this.sessionSaveTimer);
    this.sessionSaveTimer = window.setTimeout(() => {
      this.sessionSaveTimer = null;
      void this.persistSession();
    }, delay);
  }

  private async persistSession(): Promise<void> {
    const mode: StoredSessionMode = this.freeReviewMode ?? "scheduled";
    const scrollTop = resolveSessionScrollTop(
      this.lastKnownScrollTop,
      this.contentEl.scrollTop,
      this.contentEl.isConnected
    );
    this.lastKnownScrollTop = scrollTop;
    await this.plugin.saveStoredReviewSession({
      version: 1,
      savedAt: new Date().toISOString(),
      mode,
      queue: this.queue.map((card) => ({ reviewId: card.reviewId, queueReason: card.queueReason })),
      revealStep: this.revealStep as 0 | 1 | 2,
      reviewActions: this.reviewActions,
      activeQuestionId: this.activeQuestionId,
      scrollTop
    });
  }

  private renderStats(container: HTMLElement): void {
    const stats = this.plugin.getStats();
    const grid = container.createDiv({ cls: "recall-garden-stats" });
    this.renderStat(grid, String(stats.total), "已识别");
    this.renderStat(grid, String(stats.due), "已到期");
    this.renderStat(grid, `${stats.masteryRate}%`, "掌握率");
    this.renderStat(grid, String(stats.errors), "累计重来");

    const details = container.createEl("details", { cls: "recall-garden-distribution" });
    details.createEl("summary", { text: `科目分布 · 新卡 ${stats.newCards} · 已学习 ${stats.reviewed} · 已归档 ${stats.archived}` });
    const list = details.createDiv();
    for (const [subject, count] of stats.subjects) {
      list.createDiv({ text: `${subject}　${count}` });
    }

    this.renderForecast(container);
  }

  private renderProgress(container: HTMLElement): void {
    const totalActions = this.reviewActions + this.queue.length;
    const percentage = totalActions === 0 ? 100 : Math.min(100, (this.reviewActions / totalActions) * 100);
    const progress = container.createDiv({ cls: "recall-garden-progress" });
    const meta = progress.createDiv({ cls: "recall-garden-progress-meta" });
    meta.createSpan({ text: `${this.freeReviewMode ? "自由复习剩余" : "本轮剩余"} ${this.queue.length}` });
    meta.createSpan({ text: `${this.freeReviewMode ? "已看" : "已完成"} ${this.reviewActions}` });
    const track = progress.createDiv({ cls: "recall-garden-progress-track" });
    const fill = track.createDiv({ cls: "recall-garden-progress-fill" });
    fill.style.width = `${percentage}%`;
  }

  private renderFreeReviewBanner(container: HTMLElement): void {
    if (!this.freeReviewMode) return;
    const banner = container.createDiv({ cls: "recall-garden-free-banner" });
    const copy = banner.createDiv();
    copy.createEl("strong", { text: `自由复习 · ${this.diagnosticQueueLabel ?? this.freeReviewModeLabel(this.freeReviewMode)}` });
    copy.createDiv({ text: "仅浏览与主动回忆，不记录评分，也不修改 FSRS 下次复习时间。" });
    const exit = banner.createEl("button", { text: "返回今日队列" });
    exit.addEventListener("click", () => void this.reloadSession());
  }

  private renderEmptyState(container: HTMLElement): void {
    const empty = container.createDiv({ cls: "recall-garden-empty" });
    empty.createDiv({ text: "🌿", cls: "recall-garden-empty-icon" });
    empty.createEl("h3", {
      text: this.freeReviewMode ? "这一轮自由复习完成了" : "今天的园子已经照料好了"
    });
    empty.createEl("p", {
      text: this.freeReviewMode
        ? "想再看一轮可以直接重开；这里的浏览不会扰动复习算法。"
        : "没有到期卡片；你仍然可以回看今日内容、薄弱卡或全部卡。"
    });

    const actions = empty.createDiv({ cls: "recall-garden-empty-actions" });
    this.renderFreeReviewEntry(actions, "today", "再看今日卡");
    this.renderFreeReviewEntry(actions, "weak", "浏览薄弱卡");
    this.renderFreeReviewEntry(actions, "all", "浏览全部卡");

    if (!this.freeReviewMode) {
      const reload = actions.createEl("button", { text: "检查剩余到期" });
      reload.addEventListener("click", () => void this.reloadSession());
    } else {
      const exit = actions.createEl("button", { text: "返回今日队列" });
      exit.addEventListener("click", () => void this.reloadSession());
    }
  }

  private renderFreeReviewEntry(parent: HTMLElement, mode: FreeReviewMode, label: string): void {
    const count = this.plugin.buildFreeReviewQueue(mode).length;
    const button = parent.createEl("button", {
      text: `${label} · ${count}`,
      cls: mode === "today" ? "mod-cta" : ""
    });
    button.disabled = count === 0;
    button.addEventListener("click", () => void this.startFreeReview(mode));
  }

  private renderFreeReviewControls(parent: HTMLElement): void {
    const controls = parent.createDiv({ cls: "recall-garden-free-controls" });
    const copy = controls.createDiv();
    copy.createEl("strong", { text: "自由复习不计入调度" });
    copy.createDiv({ text: "按 Enter / → 或点击按钮浏览下一张。" });
    const actions = controls.createDiv({ cls: "recall-garden-free-control-actions" });
    const next = actions.createEl("button", { text: "下一张", cls: "mod-cta" });
    next.addEventListener("click", () => void this.advanceFreeReview());
    const exit = actions.createEl("button", { text: "返回今日队列" });
    exit.addEventListener("click", () => void this.reloadSession());
  }

  private async startFreeReview(mode: FreeReviewMode): Promise<void> {
    this.freeReviewMode = mode;
    this.diagnosticQueueLabel = null;
    this.queue = this.plugin.buildFreeReviewQueue(mode);
    this.reviewActions = 0;
    this.resetCardState();
    await this.renderView();
  }

  async startDiagnosticReview(queue: ReviewCard[], label: string): Promise<void> {
    this.freeReviewMode = "all";
    this.diagnosticQueueLabel = label;
    this.queue = queue;
    this.reviewActions = 0;
    this.resetCardState();
    await this.persistSession();
    await this.renderView();
  }

  private async advanceFreeReview(): Promise<void> {
    if (!this.freeReviewMode) return;
    this.queue.shift();
    this.reviewActions += 1;
    this.resetCardState();
    await this.renderView();
  }

  private resetCardState(): void {
    this.revealStep = 0;
    this.activeQuestionId = null;
    this.questionResult = null;
    this.timedReviewId = null;
  }

  private freeReviewModeLabel(mode: FreeReviewMode): string {
    return mode === "today" ? "今日已复习" : mode === "weak" ? "薄弱卡" : "全部卡";
  }

  private renderCardMetadata(parent: HTMLElement, card: ReviewCard): void {
    const primary = parent.createDiv({ cls: "recall-garden-card-primary-meta" });
    if (card.queueReason) {
      const reasonLabel = card.queueReason === "exam" && card.examYears.length > 0
        ? `${this.queueReasonLabel(card.queueReason)} · ${card.examYears.length}年`
        : this.queueReasonLabel(card.queueReason);
      primary.createSpan({
        text: reasonLabel,
        cls: `recall-garden-badge is-${card.queueReason}`,
        attr: card.queueReason === "exam" ? { title: card.examYears.join("、") } : undefined
      });
    }
    if (card.reviewPriority) {
      primary.createSpan({ text: `优先级 ${card.reviewPriority}`, cls: "recall-garden-badge is-priority" });
    }
    if (card.examYears.length > 0 && card.queueReason !== "exam") {
      primary.createSpan({
        text: `真题 · ${card.examYears.length}年`,
        cls: "recall-garden-badge is-exam",
        attr: { title: card.examYears.join("、") }
      });
    }

    const context = [
      card.subject,
      card.module,
      card.frequency,
      card.status,
      card.completeEightSections ? "完整8段式" : "兼容结构"
    ].filter(Boolean);
    if (context.length > 0) parent.createDiv({ text: context.join(" · "), cls: "recall-garden-card-context" });
  }

  private renderReviewStage(parent: HTMLElement): void {
    const stages = ["题目", "30秒版", "完整答案"];
    const stage = parent.createDiv({ cls: "recall-garden-stage" });
    stages.forEach((label, index) => {
      const item = stage.createDiv({
        cls: `recall-garden-stage-item${index === this.revealStep ? " is-current" : ""}${index < this.revealStep ? " is-complete" : ""}`
      });
      item.createSpan({ text: String(index + 1), cls: "recall-garden-stage-number" });
      item.createSpan({ text: label });
    });
  }

  private renderForecast(container: HTMLElement): void {
    const forecast = this.plugin.getDueForecast();
    const panel = container.createEl("details", { cls: `recall-garden-forecast is-${forecast.risk}` });
    const summary = panel.createEl("summary", { cls: "recall-garden-forecast-summary" });
    const summaryCopy = summary.createSpan();
    summaryCopy.createSpan({ text: "7天容量", cls: "recall-garden-forecast-title" });
    summaryCopy.createSpan({ text: `到期 ${forecast.totalScheduledDue} · 债务 ${forecast.currentDebt}`, cls: "recall-garden-forecast-summary-count" });
    summary.createSpan({ text: this.forecastRiskLabel(forecast.risk), cls: `recall-garden-risk-pill is-${forecast.risk}` });
    const body = panel.createDiv({ cls: "recall-garden-forecast-body" });
    body.createDiv({ text: forecast.warning, cls: "recall-garden-forecast-warning" });
    const peak = Math.max(1, ...forecast.days.map((day) => day.minimumLoad));
    for (const day of forecast.days) {
      const row = body.createDiv({ cls: "recall-garden-forecast-row" });
      row.createSpan({ text: day.dateKey.slice(5), cls: "recall-garden-forecast-date" });
      const track = row.createDiv({ cls: "recall-garden-forecast-track" });
      const bar = track.createDiv({ cls: "recall-garden-forecast-bar" });
      bar.style.width = `${Math.max(2, (day.minimumLoad / peak) * 100)}%`;
      row.createSpan({
        text: `到期 ${day.scheduledDue}${day.plannedNewCards > 0 ? ` + 新卡 ${day.plannedNewCards}` : ""}`,
        cls: "recall-garden-forecast-count"
      });
    }
    const pause = body.createEl("button", {
      text: this.plugin.data.settings.pauseNewCards ? "恢复引入新卡" : "暂停新卡，只清债务",
      cls: this.plugin.data.settings.pauseNewCards ? "" : "mod-warning"
    });
    pause.addEventListener("click", () => void this.plugin.setPauseNewCards(!this.plugin.data.settings.pauseNewCards));
  }

  private forecastRiskLabel(risk: DueForecast["risk"]): string {
    return risk === "high" ? "负担偏高" : risk === "medium" ? "注意回流" : "负担可控";
  }

  private renderStat(parent: HTMLElement, value: string, label: string): void {
    const item = parent.createDiv({ cls: "recall-garden-stat" });
    item.createDiv({ text: value, cls: "recall-garden-stat-value" });
    item.createDiv({ text: label, cls: "recall-garden-stat-label" });
  }

  private async renderAnswer(parent: HTMLElement, title: string, markdown: string, className: string): Promise<void> {
    const answer = parent.createDiv({ cls: `recall-garden-answer ${className}` });
    answer.createEl("h4", { text: title });
    const body = answer.createDiv({ cls: "recall-garden-markdown" });
    await MarkdownRenderer.render(this.app, markdown, body, this.queue[0].sourcePath, this);
  }

  private renderRatingButtons(parent: HTMLElement, card: ReviewCard): void {
    const layerLabels = ["仅标题", "30秒版", "完整答案"];
    const section = parent.createDiv({ cls: "recall-garden-rating-panel" });
    const header = section.createDiv({ cls: "recall-garden-rating-header" });
    const copy = header.createDiv();
    copy.createEl("h3", { text: "这次记得有多稳？" });
    copy.createDiv({
      text: `评分证据：${layerLabels[this.revealStep]} · ${this.plugin.data.settings.trackAnswerTime ? "计时中" : "未计时"}`,
      cls: "recall-garden-rating-evidence"
    });
    header.createSpan({ text: "快捷键 1—4", cls: "recall-garden-shortcut" });
    const ratings = section.createDiv({ cls: "recall-garden-ratings" });
    const classes: Record<Rating, string> = { 1: "is-again", 2: "is-hard", 3: "is-good", 4: "is-easy" };
    for (const criterion of RATING_CRITERIA) {
      const { rating, label, description } = criterion;
      const button = ratings.createEl("button", { cls: `recall-garden-rating ${classes[rating]}` });
      const top = button.createSpan({ cls: "recall-garden-rating-top" });
      top.createEl("kbd", { text: String(rating) });
      top.createEl("strong", { text: label });
      top.createSpan({ text: this.plugin.previewRating(card, rating), cls: "recall-garden-rating-interval" });
      button.createEl("small", { text: description, cls: "recall-garden-rating-criterion" });
      button.addEventListener("click", () => void this.submitRating(rating));
    }
  }

  private renderAiTools(parent: HTMLElement, card: ReviewCard): void {
    const questions = this.plugin.getQuestions(card);
    const section = parent.createEl("details", { cls: "recall-garden-ai" });
    if (this.activeQuestionId) section.open = true;
    const summary = section.createEl("summary", { cls: "recall-garden-ai-summary" });
    const summaryLabel = summary.createSpan();
    summaryLabel.createSpan({ text: "AI 变式练习", cls: "recall-garden-ai-title" });
    summaryLabel.createSpan({ text: questions.length > 0 ? `${questions.length} 题` : "可选", cls: "recall-garden-ai-count" });
    summary.createSpan({
      text: this.plugin.data.settings.aiProvider === "disabled" ? "未启用" : "实验性",
      cls: "recall-garden-badge"
    });

    const body = section.createDiv({ cls: "recall-garden-ai-body" });
    const actions = body.createDiv({ cls: "recall-garden-ai-actions" });
    const learning = actions.createEl("button", {
      text: "AI学习补全",
      cls: "recall-garden-ai-learning-button"
    });
    learning.addEventListener("click", () => void this.plugin.generateAiLearningPack(card));
    if (questions.length > 0) {
      const practice = actions.createEl("button", { text: `开始练习 · ${questions.length}题`, cls: "mod-cta" });
      practice.addEventListener("click", async () => {
        this.activeQuestionId = questions[0].id;
        this.questionResult = null;
        await this.renderView();
      });
      const sync = actions.createEl("button", { text: "回写原笔记" });
      sync.addEventListener("click", async () => {
        try {
          await this.plugin.syncQuestionBank(card);
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "同步AI题库失败", 8_000);
        }
      });
    }
    const generators: Array<[AiQuestionType, string]> = [
      ["choice", "生成选择"],
      ["fill", "生成填空"],
      ["matching", "生成连线"]
    ];
    for (const [type, label] of generators) {
      const button = actions.createEl("button", { text: label });
      button.addEventListener("click", () => void this.plugin.generateAiQuestion(card, type));
    }

    const active = questions.find((question) => question.id === this.activeQuestionId);
    if (active) this.renderAiQuestion(body, active, questions);
  }

  private renderAiQuestion(parent: HTMLElement, question: AiQuestion, allQuestions: AiQuestion[]): void {
    const box = parent.createDiv({ cls: "recall-garden-ai-question" });
    const meta = box.createDiv({ cls: "recall-garden-ai-question-meta" });
    meta.createSpan({ text: questionTypeLabel(question.type), cls: "recall-garden-badge is-complete" });
    meta.createSpan({ text: `${question.model} · 作答 ${question.attempts} 次`, cls: "recall-garden-ai-model" });
    box.createEl("p", { text: question.prompt, cls: "recall-garden-ai-prompt" });

    if (question.type === "choice") {
      const options = box.createDiv({ cls: "recall-garden-ai-options" });
      question.options.forEach((option, index) => {
        const label = options.createEl("label");
        const input = label.createEl("input");
        input.type = "radio";
        input.name = `recall-garden-${question.id}`;
        input.value = String(index);
        label.createSpan({ text: `${String.fromCharCode(65 + index)}. ${option}` });
      });
    } else if (question.type === "fill") {
      const input = box.createEl("input", {
        cls: "recall-garden-ai-fill",
        attr: { type: "text", placeholder: "输入答案后核对" }
      });
      input.dataset.questionId = question.id;
    } else {
      const rights = this.deterministicShuffle(
        question.pairs.map((pair) => pair.right),
        question.id
      );
      const rows = box.createDiv({ cls: "recall-garden-ai-matching" });
      question.pairs.forEach((pair, index) => {
        const row = rows.createDiv({ cls: "recall-garden-ai-match-row" });
        row.createSpan({ text: pair.left });
        const select = row.createEl("select");
        select.dataset.matchIndex = String(index);
        select.createEl("option", { text: "选择对应项", value: "" });
        rights.forEach((right) => select.createEl("option", { text: right, value: right }));
      });
    }

    const result = this.questionResult?.id === question.id ? this.questionResult : null;
    if (result) {
      const resultBox = box.createDiv({
        cls: `recall-garden-ai-result ${result.correct ? "is-correct" : "is-wrong"}`
      });
      resultBox.createEl("strong", { text: result.correct ? "回答正确" : "还没接上这根藤" });
      resultBox.createDiv({ text: `正确答案：${this.questionAnswerText(question)}` });
      if (question.explanation) resultBox.createDiv({ text: question.explanation });
    }

    const controls = box.createDiv({ cls: "recall-garden-ai-controls" });
    if (!result) {
      const check = controls.createEl("button", { text: "核对答案", cls: "mod-cta" });
      check.addEventListener("click", () => void this.checkAiAnswer(box, question));
    }
    if (allQuestions.length > 1) {
      const next = controls.createEl("button", { text: "换一题" });
      next.addEventListener("click", async () => {
        const index = allQuestions.findIndex((item) => item.id === question.id);
        this.activeQuestionId = allQuestions[(index + 1) % allQuestions.length].id;
        this.questionResult = null;
        await this.renderView();
      });
    }
    const close = controls.createEl("button", { text: "收起" });
    close.addEventListener("click", async () => {
      this.activeQuestionId = null;
      this.questionResult = null;
      await this.renderView();
    });
    const remove = controls.createEl("button", { text: "删除本题", cls: "recall-garden-ai-delete" });
    remove.addEventListener("click", async () => {
      this.activeQuestionId = null;
      this.questionResult = null;
      await this.plugin.deleteQuestion(question);
    });
  }

  private async checkAiAnswer(container: HTMLElement, question: AiQuestion): Promise<void> {
    let answered = false;
    let correct = false;
    if (question.type === "choice") {
      const checked = container.querySelector<HTMLInputElement>(`input[name="recall-garden-${CSS.escape(question.id)}"]:checked`);
      answered = checked !== null;
      correct = Number(checked?.value) === question.answerIndex;
    } else if (question.type === "fill") {
      const input = container.querySelector<HTMLInputElement>(`input[data-question-id="${CSS.escape(question.id)}"]`);
      const answer = normalizeAnswer(input?.value ?? "");
      answered = Boolean(answer);
      const accepted = [question.answer, ...question.acceptedAnswers].map(normalizeAnswer);
      correct = accepted.includes(answer);
    } else {
      const selects = Array.from(container.querySelectorAll<HTMLSelectElement>("select[data-match-index]"));
      answered = selects.length === question.pairs.length && selects.every((select) => Boolean(select.value));
      correct = answered && selects.every((select) => {
        const index = Number(select.dataset.matchIndex);
        return select.value === question.pairs[index]?.right;
      });
    }
    if (!answered) {
      new Notice("先作答，再核对。别想偷看，baka。", 4_000);
      return;
    }
    await this.plugin.recordQuestionAttempt(question, correct);
    this.questionResult = { id: question.id, correct };
    await this.renderView();
  }

  private questionAnswerText(question: AiQuestion): string {
    if (question.type === "choice") return `${String.fromCharCode(65 + question.answerIndex)}. ${question.options[question.answerIndex]}`;
    if (question.type === "fill") return question.answer;
    return question.pairs.map((pair) => `${pair.left} → ${pair.right}`).join("；");
  }

  private deterministicShuffle(values: string[], seed: string): string[] {
    const hash = (value: string) => {
      let result = 0;
      for (const char of `${seed}:${value}`) result = (result * 31 + char.charCodeAt(0)) | 0;
      return result;
    };
    return [...values].sort((left, right) => hash(left) - hash(right));
  }

  private async submitRating(rating: Rating): Promise<void> {
    const card = this.queue.shift();
    if (!card) return;
    const durationSeconds = this.plugin.data.settings.trackAnswerTime
      ? Math.max(0, Math.round((Date.now() - this.cardStartedAt) / 1_000))
      : null;
    await this.plugin.rateCard(card, rating, {
      revealLevel: this.revealStep as 0 | 1 | 2,
      durationSeconds
    });
    if (rating === 1) {
      const requeuePosition = Math.min(4, this.queue.length);
      this.queue.splice(requeuePosition, 0, card);
    }
    this.reviewActions += 1;
    this.revealStep = 0;
    this.activeQuestionId = null;
    this.questionResult = null;
    this.timedReviewId = null;
    await this.persistSession();
    await this.renderView();
  }

  private syncCardTimer(card: ReviewCard): void {
    if (this.timedReviewId === card.reviewId) return;
    this.timedReviewId = card.reviewId;
    this.cardStartedAt = Date.now();
  }

  private queueReasonLabel(reason: QueueReason): string {
    const labels: Record<QueueReason, string> = {
      overdue: "逾期旧卡",
      wrong: "薄弱答错",
      exam: "真题优先",
      "high-frequency": "高频优先",
      due: "普通到期",
      new: "新卡"
    };
    return labels[reason];
  }
}

class RecallGardenCalendarView extends ItemView {
  private displayYear: number;
  private displayMonthIndex: number;
  private selectedDateKey: string;

  constructor(leaf: WorkspaceLeaf, private plugin: RecallGardenPlugin) {
    super(leaf);
    const today = new Date();
    this.displayYear = today.getFullYear();
    this.displayMonthIndex = today.getMonth();
    this.selectedDateKey = calendarDateKey(today);
  }

  getViewType(): string {
    return VIEW_TYPE_RECALL_GARDEN_CALENDAR;
  }

  getDisplayText(): string {
    return "忆园学习日历";
  }

  getIcon(): string {
    return "calendar-days";
  }

  async onOpen(): Promise<void> {
    await this.renderView();
  }

  applySkin(): void {
    applyUiSkin(
      this.contentEl,
      this.plugin.data.settings.uiSkin,
      this.plugin.data.settings.enableVisualEffects
    );
  }

  async renderView(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("recall-garden-view", "recall-garden-calendar");
    this.applySkin();

    const now = new Date();
    const month = this.plugin.getStudyCalendarMonth(this.displayYear, this.displayMonthIndex, now);
    let selectedDay = month.days.find((day) => day.dateKey === this.selectedDateKey);
    if (!selectedDay) {
      selectedDay = month.days.find((day) => day.inMonth) ?? month.days[0];
      this.selectedDateKey = selectedDay.dateKey;
    }

    const header = container.createDiv({ cls: "recall-garden-header recall-garden-calendar-header" });
    const brand = header.createDiv({ cls: "recall-garden-brand" });
    const mark = brand.createDiv({ cls: "recall-garden-brand-mark" });
    setIcon(mark, "calendar-days");
    const copy = brand.createDiv({ cls: "recall-garden-brand-copy" });
    copy.createDiv({ text: "STUDY CALENDAR", cls: "recall-garden-eyebrow" });
    copy.createEl("h2", { text: "学习日历" });
    copy.createDiv({ text: "把历史证据、今日债务和未来到期量放回时间里。", cls: "recall-garden-subtitle" });
    const headerActions = header.createDiv({ cls: "recall-garden-header-actions" });
    const diagnostics = headerActions.createEl("button", { text: "诊断" });
    diagnostics.addEventListener("click", () => void this.plugin.activateDiagnosticsView());
    const review = headerActions.createEl("button", { text: "返回复习", cls: "mod-cta" });
    review.addEventListener("click", () => void this.plugin.activateView());

    const stats = container.createDiv({ cls: "recall-garden-stats recall-garden-calendar-stats" });
    this.renderStat(stats, String(month.summary.completed), "本月复习");
    this.renderStat(stats, String(month.summary.activeDays), "活跃天数");
    this.renderStat(stats, String(month.streak), "连续学习");
    this.renderStat(stats, `${month.summary.againRate}%`, "本月重来率");

    const layout = container.createDiv({ cls: "recall-garden-calendar-layout" });
    const calendarPanel = layout.createEl("section", { cls: "recall-garden-calendar-panel" });
    const toolbar = calendarPanel.createDiv({ cls: "recall-garden-calendar-toolbar" });
    const title = toolbar.createDiv();
    title.createEl("h3", { text: month.label });
    title.createSpan({ text: `计划到期 ${month.summary.scheduled} 张`, cls: "setting-item-description" });
    const navigation = toolbar.createDiv({ cls: "recall-garden-calendar-navigation" });
    const previous = navigation.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "上个月" } });
    setIcon(previous, "chevron-left");
    previous.addEventListener("click", () => void this.shiftMonth(-1));
    const today = navigation.createEl("button", { text: "今天" });
    today.addEventListener("click", () => void this.goToday());
    const next = navigation.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "下个月" } });
    setIcon(next, "chevron-right");
    next.addEventListener("click", () => void this.shiftMonth(1));

    const weekday = calendarPanel.createDiv({ cls: "recall-garden-calendar-weekdays" });
    for (const label of ["一", "二", "三", "四", "五", "六", "日"]) weekday.createSpan({ text: label });
    const grid = calendarPanel.createDiv({ cls: "recall-garden-calendar-grid" });
    for (const day of month.days) this.renderDay(grid, day);

    const legend = calendarPanel.createDiv({ cls: "recall-garden-calendar-legend" });
    legend.createSpan({ text: "复习热力", cls: "recall-garden-calendar-legend-label" });
    for (let level = 0; level <= 4; level += 1) legend.createSpan({ cls: `recall-garden-calendar-heat is-${level}` });
    legend.createSpan({ text: "紫 · 真题到期" });
    legend.createSpan({ text: "红 · 仍有债务" });

    this.renderDayDetail(layout, selectedDay);
  }

  private renderDay(parent: HTMLElement, day: StudyCalendarDay): void {
    const classes = [
      "recall-garden-calendar-day",
      `is-heat-${day.heatLevel}`,
      day.inMonth ? "" : "is-outside",
      day.isToday ? "is-today" : "",
      day.dateKey === this.selectedDateKey ? "is-selected" : "",
      day.debtCount > 0 ? "has-debt" : "",
      day.examDueCount > 0 ? "has-exam" : ""
    ].filter(Boolean).join(" ");
    const button = parent.createEl("button", {
      cls: classes,
      attr: {
        "aria-label": `${day.dateKey}，完成 ${day.completedCount}，到期 ${day.scheduledCount}，债务 ${day.debtCount}`
      }
    });
    const top = button.createDiv({ cls: "recall-garden-calendar-day-top" });
    top.createSpan({ text: String(day.dayNumber), cls: "recall-garden-calendar-day-number" });
    if (day.isToday) top.createSpan({ text: "今", cls: "recall-garden-calendar-today-pill" });
    const metrics = button.createDiv({ cls: "recall-garden-calendar-day-metrics" });
    if (day.completedCount > 0) metrics.createSpan({ text: `✓ ${day.completedCount}`, cls: "is-completed" });
    if (day.scheduledCount > 0) metrics.createSpan({ text: `到 ${day.scheduledCount}`, cls: "is-due" });
    if (day.debtCount > 0) metrics.createSpan({ text: `债 ${day.debtCount}`, cls: "is-debt" });
    if (day.examDueCount > 0) button.createSpan({ text: "真题", cls: "recall-garden-calendar-exam-dot" });
    button.addEventListener("click", () => {
      this.selectedDateKey = day.dateKey;
      if (!day.inMonth) {
        const date = parseCalendarDateKey(day.dateKey);
        this.displayYear = date.getFullYear();
        this.displayMonthIndex = date.getMonth();
      }
      void this.renderView();
    });
  }

  private renderDayDetail(parent: HTMLElement, day: StudyCalendarDay): void {
    const panel = parent.createEl("aside", { cls: "recall-garden-calendar-detail" });
    const header = panel.createDiv({ cls: "recall-garden-calendar-detail-header" });
    const copy = header.createDiv();
    copy.createDiv({ text: dayStatusLabel(day), cls: "recall-garden-eyebrow" });
    copy.createEl("h3", { text: formatCalendarDay(day.dateKey) });
    copy.createDiv({
      text: day.isToday ? "今天的数据会随评分即时变化。" : day.isPast ? "历史复习证据与当日债务快照。" : "按当前 FSRS 调度预测，后续评分会改变它。",
      cls: "setting-item-description"
    });
    const metrics = panel.createDiv({ cls: "recall-garden-calendar-detail-metrics" });
    this.detailMetric(metrics, String(day.completedCount), "已完成");
    this.detailMetric(metrics, String(day.scheduledCount), "计划到期");
    this.detailMetric(metrics, String(day.againCount), "重来");
    this.detailMetric(metrics, String(day.debtCount), "复习债务");

    const cards = this.plugin.getCardsByReviewIds(day.reviewIds);
    if (cards.length > 0) {
      const action = panel.createEl("button", {
        text: `自由复习这一天 · ${cards.length} 张`,
        cls: "mod-cta recall-garden-calendar-practice"
      });
      action.addEventListener("click", () => void this.plugin.startDiagnosticQueue(
        cards.map((card) => card.reviewId),
        `${day.dateKey} 学习日历`
      ));
    }

    const list = panel.createDiv({ cls: "recall-garden-calendar-card-list" });
    if (cards.length === 0) {
      list.createDiv({
        text: day.debtCount > 0
          ? "这一天只有历史债务快照，没有可定位的当前卡片。"
          : day.completedCount > 0
            ? "这一天有历史复习记录，但对应卡片目前已归档或不在扫描范围。"
            : "这一天暂时没有复习记录或计划到期卡。",
        cls: "recall-garden-calendar-empty-day"
      });
      return;
    }
    for (const card of cards.slice(0, 40)) {
      const row = list.createDiv({ cls: "recall-garden-calendar-card-row" });
      const source = row.createEl("button", { cls: "recall-garden-calendar-card-source" });
      source.createEl("strong", { text: card.title });
      const badges = source.createDiv({ cls: "recall-garden-calendar-card-badges" });
      if (day.completedReviewIds.includes(card.reviewId)) badges.createSpan({ text: "已复习", cls: "is-completed" });
      if (day.scheduledReviewIds.includes(card.reviewId)) badges.createSpan({ text: "当日到期", cls: "is-due" });
      if (day.debtReviewIds.includes(card.reviewId)) badges.createSpan({ text: "债务", cls: "is-debt" });
      if (card.examYears.length > 0) badges.createSpan({ text: "真题", cls: "is-exam" });
      source.createEl("small", { text: [card.subject, card.module].filter(Boolean).join(" · ") || card.sourcePath });
      source.addEventListener("click", () => void this.plugin.openSource(card));
      const practice = row.createEl("button", { text: "复习" });
      practice.addEventListener("click", () => void this.plugin.startDiagnosticQueue([card.reviewId], `${card.title}日历复习`));
    }
  }

  private renderStat(parent: HTMLElement, value: string, label: string): void {
    const item = parent.createDiv({ cls: "recall-garden-stat" });
    item.createDiv({ text: value, cls: "recall-garden-stat-value" });
    item.createDiv({ text: label, cls: "recall-garden-stat-label" });
  }

  private detailMetric(parent: HTMLElement, value: string, label: string): void {
    const item = parent.createDiv();
    item.createEl("strong", { text: value });
    item.createSpan({ text: label });
  }

  private async shiftMonth(offset: number): Promise<void> {
    const target = new Date(this.displayYear, this.displayMonthIndex + offset, 1, 12);
    this.displayYear = target.getFullYear();
    this.displayMonthIndex = target.getMonth();
    this.selectedDateKey = calendarDateKey(target);
    await this.renderView();
  }

  private async goToday(): Promise<void> {
    const today = new Date();
    this.displayYear = today.getFullYear();
    this.displayMonthIndex = today.getMonth();
    this.selectedDateKey = calendarDateKey(today);
    await this.renderView();
  }
}

class RecallGardenDiagnosticsView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: RecallGardenPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_RECALL_GARDEN_DIAGNOSTICS;
  }

  getDisplayText(): string {
    return "忆园诊断中心";
  }

  getIcon(): string {
    return "chart-no-axes-combined";
  }

  async onOpen(): Promise<void> {
    await this.renderView();
  }

  applySkin(): void {
    applyUiSkin(
      this.contentEl,
      this.plugin.data.settings.uiSkin,
      this.plugin.data.settings.enableVisualEffects
    );
  }

  async renderView(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("recall-garden-diagnostics");
    this.applySkin();
    const report = this.plugin.getDiagnosticReport();
    const health = this.plugin.getHealthIssues();

    const header = container.createDiv({ cls: "recall-garden-diagnostic-header" });
    const copy = header.createDiv();
    copy.createDiv({ text: "LEARNING DIAGNOSTICS", cls: "recall-garden-eyebrow" });
    copy.createEl("h2", { text: "今天学什么" });
    copy.createDiv({ text: "从复习证据定位薄弱点，再直接进入对应自由复习队列。", cls: "setting-item-description" });
    const actions = header.createDiv({ cls: "recall-garden-header-actions" });
    const calendar = actions.createEl("button", { text: "学习日历" });
    calendar.addEventListener("click", () => void this.plugin.activateCalendarView());
    const review = actions.createEl("button", { text: "返回复习" });
    review.addEventListener("click", () => void this.plugin.activateView());
    const refresh = actions.createEl("button", { text: "重新诊断", cls: "mod-cta" });
    refresh.addEventListener("click", async () => {
      await this.plugin.scanVault();
      new Notice("诊断已刷新");
    });

    this.renderTodayActions(container, report);
    this.renderWindowMetrics(container, report);
    this.renderQualityMetrics(container, report);
    this.renderRetrievability(container, report);
    this.renderWeakness(container, report);
    this.renderForecast(container, report);
    this.renderRankings(container, report);
    this.renderHealth(container, health);
  }

  private renderTodayActions(container: HTMLElement, report: DiagnosticReport): void {
    const section = this.section(container, "今日建议", "这些按钮不会修改 FSRS；它们只生成针对性自由复习队列。");
    const grid = section.createDiv({ cls: "recall-garden-diagnostic-actions" });
    const todayDue = report.forecast30[0]?.reviewIds ?? [];
    this.actionCard(grid, `先清 ${report.debt.current} 张复习债务`, "逾期与今日到期卡", todayDue, "今日复习债务");
    const weakest = report.weakness.module[0];
    if (weakest) {
      this.actionCard(grid, `${weakest.label}薄弱卡`, `${weakest.count} 张 · 弱项指数 ${weakest.averageWeakness}`, weakest.reviewIds, `${weakest.label}薄弱卡`);
    }
    this.actionCard(
      grid,
      "完整答案依赖高",
      `${report.fullAnswerDependenceIds.length} 张需要检查评分虚高`,
      report.fullAnswerDependenceIds,
      "完整答案依赖高"
    );
  }

  private actionCard(parent: HTMLElement, title: string, detail: string, reviewIds: string[], label: string): void {
    const button = parent.createEl("button", { cls: "recall-garden-diagnostic-action-card" });
    button.createEl("strong", { text: title });
    button.createSpan({ text: detail });
    button.disabled = reviewIds.length === 0;
    button.addEventListener("click", () => void this.plugin.startDiagnosticQueue(reviewIds, label));
  }

  private renderWindowMetrics(container: HTMLElement, report: DiagnosticReport): void {
    const section = this.section(container, "复习量", "按真实评分记录统计，不把自由浏览算作复习。");
    const grid = section.createDiv({ cls: "recall-garden-diagnostic-metrics" });
    this.metric(grid, String(report.windows.today), "今日");
    this.metric(grid, String(report.windows.days7), "近 7 天");
    this.metric(grid, String(report.windows.days30), "近 30 天");
    this.metric(grid, String(report.newCards.days30), "30 天新卡");
    this.metric(grid, `${report.newCards.dailyAverage30}/天`, "新卡速度");
    this.metric(grid, debtTrendText(report.debt.change7Days), "7 天债务变化");
  }

  private renderQualityMetrics(container: HTMLElement, report: DiagnosticReport): void {
    const section = this.section(container, "回答质量", "重来、困难和完整答案依赖使用近 30 天评分；遗忘率使用 FSRS lapses / reps。");
    const grid = section.createDiv({ cls: "recall-garden-diagnostic-metrics" });
    this.metric(grid, percent(report.rates.again), "重来率");
    this.metric(grid, percent(report.rates.hard), "困难率");
    this.metric(grid, percent(report.rates.forgetting), "遗忘率");
    this.metric(grid, percent(report.rates.fullReveal), "完整答案后评分");
    this.metric(grid, report.averageDurationSeconds === null ? "暂无" : `${report.averageDurationSeconds}秒`, "平均答题时间");
    this.metric(grid, String(report.timeoutCards.length), "超时卡（>90秒）");
  }

  private renderRetrievability(container: HTMLElement, report: DiagnosticReport): void {
    const section = this.section(container, "FSRS 可提取率", "点击分布区间，立即复习该区间内的卡片。");
    const grid = section.createDiv({ cls: "recall-garden-diagnostic-bars" });
    const maximum = Math.max(1, ...report.retrievability.map((bucket) => bucket.count));
    for (const bucket of report.retrievability) {
      const button = grid.createEl("button", { cls: "recall-garden-diagnostic-bar" });
      button.createSpan({ text: bucket.label });
      const track = button.createDiv({ cls: "recall-garden-diagnostic-bar-track" });
      const fill = track.createDiv({ cls: "recall-garden-diagnostic-bar-fill" });
      fill.style.width = `${Math.max(3, bucket.count / maximum * 100)}%`;
      button.createEl("strong", { text: String(bucket.count) });
      button.disabled = bucket.count === 0;
      button.addEventListener("click", () => void this.plugin.startDiagnosticQueue(bucket.reviewIds, `可提取率 ${bucket.label}`));
    }
  }

  private renderWeakness(container: HTMLElement, report: DiagnosticReport): void {
    const section = this.section(container, "薄弱分布", "按错误、困难、完整揭示与低可提取率合成弱项指数。");
    const grid = section.createDiv({ cls: "recall-garden-diagnostic-groups" });
    this.groupColumn(grid, "科目", report.weakness.subject);
    this.groupColumn(grid, "模块", report.weakness.module);
    this.groupColumn(grid, "频次", report.weakness.frequency);
    this.groupColumn(grid, "真题年份", report.weakness.examYear);
  }

  private groupColumn(parent: HTMLElement, title: string, groups: DiagnosticGroup[]): void {
    const column = parent.createDiv({ cls: "recall-garden-diagnostic-group" });
    column.createEl("h4", { text: title });
    if (groups.length === 0) column.createDiv({ text: "暂无薄弱卡", cls: "setting-item-description" });
    for (const group of groups.slice(0, 8)) {
      const button = column.createEl("button");
      button.createSpan({ text: group.label });
      button.createEl("strong", { text: `${group.count} · ${group.averageWeakness}` });
      button.addEventListener("click", () => void this.plugin.startDiagnosticQueue(group.reviewIds, `${group.label}薄弱卡`));
    }
  }

  private renderForecast(container: HTMLElement, report: DiagnosticReport): void {
    const section = this.section(container, "未来 30 天复习负担", "柱子只包含当前已排定到期卡；点击某天查看具体卡片。");
    const chart = section.createDiv({ cls: "recall-garden-diagnostic-forecast" });
    const maximum = Math.max(1, ...report.forecast30.map((day) => day.count));
    for (const day of report.forecast30) {
      const button = chart.createEl("button", { attr: { title: `${day.dateKey} · ${day.count} 张` } });
      const bar = button.createDiv({ cls: "recall-garden-diagnostic-forecast-bar" });
      bar.style.height = `${Math.max(4, day.count / maximum * 100)}%`;
      button.createSpan({ text: day.dateKey.slice(5) });
      button.createEl("strong", { text: String(day.count) });
      button.disabled = day.count === 0;
      button.addEventListener("click", () => void this.plugin.startDiagnosticQueue(day.reviewIds, `${day.dateKey} 到期卡`));
    }
  }

  private renderRankings(container: HTMLElement, report: DiagnosticReport): void {
    const section = this.section(container, "异常卡与高频错误", "点击卡名进入原笔记；点击复习生成针对性队列。");
    const columns = section.createDiv({ cls: "recall-garden-diagnostic-rankings" });
    const visibleColumns = Number(report.errorRanking.length > 0) + Number(report.timeoutCards.length > 0);
    if (visibleColumns <= 1) columns.addClass("is-single");
    if (report.errorRanking.length > 0) {
      const errors = columns.createDiv();
      errors.createEl("h4", { text: "高频错误概念" });
      for (const item of report.errorRanking.slice(0, 12)) {
        this.rankingRow(errors, item.title, `${item.errors} 次 · ${percent(item.errorRate)}`, item.sourcePath, [item.reviewId]);
      }
    }
    if (report.timeoutCards.length > 0) {
      const timeout = columns.createDiv();
      timeout.createEl("h4", { text: "超时卡" });
      for (const item of report.timeoutCards.slice(0, 12)) {
        this.rankingRow(timeout, item.title, `平均 ${item.averageSeconds} 秒`, item.sourcePath, [item.reviewId]);
      }
    }
    if (visibleColumns === 0) {
      columns.createDiv({ text: "近 30 天没有高频错误或超时卡。", cls: "recall-garden-diagnostic-ok" });
    }
  }

  private rankingRow(parent: HTMLElement, title: string, detail: string, sourcePath: string, reviewIds: string[]): void {
    const row = parent.createDiv({ cls: "recall-garden-diagnostic-row" });
    const source = row.createEl("button", { cls: "recall-garden-diagnostic-source" });
    source.createSpan({ text: title });
    source.createEl("small", { text: detail });
    source.addEventListener("click", () => void this.plugin.openSourcePath(sourcePath));
    const practice = row.createEl("button", { text: "复习" });
    practice.addEventListener("click", () => void this.plugin.startDiagnosticQueue(reviewIds, `${title}诊断复习`));
  }

  private renderHealth(container: HTMLElement, issues: CardHealthIssue[]): void {
    const section = this.section(container, `卡片体检 · ${issues.length}`, "结构和题库问题不会自动改写；点击异常卡进入原笔记处理。");
    if (issues.length === 0) {
      section.createDiv({ text: "没有发现结构、YAML 或题库同步问题。", cls: "recall-garden-diagnostic-ok" });
      return;
    }
    const labels: Record<CardHealthIssue["code"], string> = {
      "missing-sections": "缺少八段式章节",
      "yaml-invalid": "YAML 异常",
      "short-empty": "30 秒版为空",
      "short-too-long": "30 秒版过长",
      "duplicate-title": "重复题名",
      "duplicate-source": "重复来源",
      "deleted-ai-unsynced": "已删除 AI 题未同步",
      "question-bank-version": "题库版本不一致"
    };
    const list = section.createDiv({ cls: "recall-garden-health-list" });
    for (const issue of issues.slice(0, 100)) {
      const button = list.createEl("button", { cls: "recall-garden-health-row" });
      const copy = button.createDiv();
      copy.createEl("strong", { text: issue.title });
      copy.createSpan({ text: issue.detail });
      button.createSpan({ text: labels[issue.code], cls: "recall-garden-health-code" });
      button.addEventListener("click", () => void this.plugin.openSourcePath(issue.sourcePath));
    }
  }

  private section(container: HTMLElement, title: string, description: string): HTMLElement {
    const section = container.createEl("section", { cls: "recall-garden-diagnostic-section" });
    section.createEl("h3", { text: title });
    section.createDiv({ text: description, cls: "setting-item-description" });
    return section;
  }

  private metric(parent: HTMLElement, value: string, label: string): void {
    const metric = parent.createDiv({ cls: "recall-garden-diagnostic-metric" });
    metric.createEl("strong", { text: value });
    metric.createSpan({ text: label });
  }
}

class CardCreatorModal extends Modal {
  private draft: CardDraft;
  private pathPreview!: HTMLElement;
  private templatePreview!: HTMLElement;
  private errorEl!: HTMLElement;

  constructor(
    app: App,
    private plugin: RecallGardenPlugin,
    seed: CardDraft
  ) {
    super(app);
    this.draft = { ...seed, examYears: [...seed.examYears] };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("recall-garden-card-creator");
    contentEl.createEl("h2", { text: "新建忆园卡" });
    contentEl.createEl("p", {
      text: "填写最少的结构化信息，忆园会生成可在电脑与手机继续编辑的严格八段式笔记。",
      cls: "setting-item-description"
    });

    new Setting(contentEl)
      .setName("卡片类型")
      .setDesc("概念卡建立知识单元；对比卡处理易混内容；应用迁移卡训练问题解决与跨情境使用。")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("definition", CARD_KIND_LABELS.definition)
          .addOption("comparison", CARD_KIND_LABELS.comparison)
          .addOption("exam-transfer", CARD_KIND_LABELS["exam-transfer"])
          .setValue(this.draft.kind)
          .onChange((value) => {
            this.draft.kind = value as CardKind;
            this.updatePreview();
          });
      });

    new Setting(contentEl)
      .setName("题名")
      .setDesc("例如：光合作用、供需关系比较、递归算法应用。")
      .addText((text) => {
        text
          .setPlaceholder("输入卡片题名")
          .setValue(this.draft.topic)
          .onChange((value) => {
            this.draft.topic = value;
            this.updatePreview();
          });
        window.setTimeout(() => text.inputEl.focus(), 0);
      });

    new Setting(contentEl)
      .setName("科目")
      .setDesc("填写课程、专业或知识领域，例如 Biology、Economics、Computer Science。")
      .addText((text) =>
        text.setPlaceholder("Biology").setValue(this.draft.subject).onChange((value) => {
          this.draft.subject = value;
          this.updatePreview();
        })
      );

    new Setting(contentEl)
      .setName("模块")
      .setDesc("同时作为扫描目录下的子文件夹，例如 Cell Biology。")
      .addText((text) =>
        text.setPlaceholder("Cell Biology").setValue(this.draft.module).onChange((value) => {
          this.draft.module = value;
          this.updatePreview();
        })
      );

    new Setting(contentEl)
      .setName("真题年份")
      .setDesc("可留空；支持逗号、顿号或空格，例如 2022、2024。")
      .addText((text) =>
        text.setPlaceholder("2022、2024").setValue(this.draft.examYears.join("、")).onChange((value) => {
          this.draft.examYears = parseExamYearsInput(value);
        })
      );

    new Setting(contentEl)
      .setName("频次")
      .addDropdown((dropdown) => {
        for (const value of ["高频", "中高频", "中频", "低频基础", "待判断"]) dropdown.addOption(value, value);
        dropdown.setValue(this.draft.frequency).onChange((value) => {
          this.draft.frequency = value;
        });
      });

    new Setting(contentEl)
      .setName("状态")
      .addDropdown((dropdown) => {
        for (const value of ["待完善", "待背诵", "复习中", "已掌握"]) dropdown.addOption(value, value);
        dropdown.setValue(this.draft.status).onChange((value) => {
          this.draft.status = value;
        });
      });

    new Setting(contentEl)
      .setName("复习优先级")
      .setDesc("S/A/B/C 只影响同一风险层内的排序。")
      .addDropdown((dropdown) => {
        for (const value of ["S", "A", "B", "C"] as const) dropdown.addOption(value, value);
        dropdown.setValue(this.draft.reviewPriority).onChange((value) => {
          this.draft.reviewPriority = value as CardDraft["reviewPriority"];
        });
      });

    const preview = contentEl.createDiv({ cls: "recall-garden-authoring-preview" });
    preview.createDiv({ text: "创建位置", cls: "recall-garden-authoring-label" });
    this.pathPreview = preview.createEl("code");
    this.templatePreview = preview.createDiv({ cls: "recall-garden-authoring-template" });
    this.errorEl = contentEl.createDiv({ cls: "recall-garden-authoring-error" });

    const actions = contentEl.createDiv({ cls: "recall-garden-authoring-actions" });
    new Setting(actions)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) =>
        button.setCta().setButtonText("创建并打开").onClick(async () => {
          this.errorEl.empty();
          const error = validateCardDraft(this.draft);
          if (error) {
            this.errorEl.setText(error);
            return;
          }
          button.setDisabled(true);
          try {
            await this.plugin.createCardFromDraft(this.draft);
            this.close();
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : "创建忆园卡失败";
            this.errorEl.setText(message);
            new Notice(message, 8_000);
          } finally {
            button.setDisabled(false);
          }
        })
      );
    this.updatePreview();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private updatePreview(): void {
    if (!this.pathPreview || !this.templatePreview) return;
    this.pathPreview.setText(this.plugin.getSuggestedCardPath(this.draft));
    const descriptions: Record<CardKind, string> = {
      definition: "8段：定义 → 标准答案 → 机制 → 学科意义 → 辨析 → 30秒版 → 迁移 → 来源",
      comparison: "8段：结论 → 标准答案 → 共同点 → 差异 → 易错判断 → 30秒版 → 迁移 → 来源",
      "exam-transfer": "8段：题目 → 标准答案 → 语境 → 结构 → 案例迁移 → 30秒版 → 变式 → 来源"
    };
    this.templatePreview.setText(descriptions[this.draft.kind]);
  }
}

class SnapshotPickerModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private files: TFile[],
    private onPick: (file: TFile) => void
  ) {
    super(app);
    this.setPlaceholder("选择要恢复的忆园数据快照");
  }

  getItems(): TFile[] {
    return [...this.files].sort((left, right) => right.stat.mtime - left.stat.mtime);
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onPick(file);
  }
}

class RestorePreviewModal extends Modal {
  constructor(
    app: App,
    private file: TFile,
    private snapshot: RecallGardenSnapshot,
    private diff: SnapshotDiff,
    private onConfirmRestore: () => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("recall-garden-restore-preview");
    contentEl.createEl("h2", { text: "恢复前差异确认" });
    contentEl.createEl("p", { text: this.file.path, cls: "recall-garden-ai-model" });
    contentEl.createEl("p", {
      text: `快照导出时间：${this.snapshot.exportedAt || "未知"} · 插件版本：${this.snapshot.pluginVersion}`
    });

    const table = contentEl.createEl("table", { cls: "recall-garden-restore-table" });
    const header = table.createEl("thead").createEl("tr");
    header.createEl("th", { text: "项目" });
    header.createEl("th", { text: "当前" });
    header.createEl("th", { text: "导入后" });
    const body = table.createEl("tbody");
    this.renderDiffRow(body, "稳定ID", this.diff.current.stableIds, this.diff.incoming.stableIds);
    this.renderDiffRow(body, "活动卡片", this.diff.current.activeCards, this.diff.incoming.activeCards);
    this.renderDiffRow(body, "已复习卡", this.diff.current.reviewedCards, this.diff.incoming.reviewedCards);
    this.renderDiffRow(body, "累计评分", this.diff.current.totalRatings, this.diff.incoming.totalRatings);
    this.renderDiffRow(body, "AI题目", this.diff.current.aiQuestions, this.diff.incoming.aiQuestions);
    this.renderDiffRow(body, "归档卡片", this.diff.current.archivedCards, this.diff.incoming.archivedCards);

    const changes = contentEl.createDiv({ cls: "recall-garden-restore-changes" });
    changes.createEl("strong", {
      text: `ID差异：新增 ${this.diff.addedIds.length} · 移除 ${this.diff.removedIds.length} · 内容变化 ${this.diff.changedIds.length}`
    });
    changes.createDiv({ text: `插件设置：${this.diff.settingsChanged ? "将发生变化" : "无变化"}` });
    this.renderIdPreview(changes, "新增", this.diff.addedIds);
    this.renderIdPreview(changes, "移除", this.diff.removedIds);
    this.renderIdPreview(changes, "变化", this.diff.changedIds);

    contentEl.createEl("p", {
      text: "确认后会先自动导出当前数据，再写入快照。OAuth 与 API Key 不参与导入。",
      cls: "mod-warning"
    });
    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const restore = actions.createEl("button", { text: "自动备份并恢复", cls: "mod-warning" });
    restore.addEventListener("click", async () => {
      restore.disabled = true;
      cancel.disabled = true;
      try {
        await this.onConfirmRestore();
        this.close();
      } catch (error) {
        restore.disabled = false;
        cancel.disabled = false;
        new Notice(error instanceof Error ? error.message : "快照恢复失败", 10_000);
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderDiffRow(body: HTMLElement, label: string, current: number, incoming: number): void {
    const row = body.createEl("tr");
    row.createEl("td", { text: label });
    row.createEl("td", { text: String(current) });
    const incomingCell = row.createEl("td", { text: String(incoming) });
    if (current !== incoming) incomingCell.addClass("is-changed");
  }

  private renderIdPreview(parent: HTMLElement, label: string, ids: string[]): void {
    if (ids.length === 0) return;
    const suffix = ids.length > 8 ? ` 等 ${ids.length} 项` : "";
    parent.createDiv({ text: `${label}：${ids.slice(0, 8).join("、")}${suffix}` });
  }
}

interface NoteVerificationModalContext {
  savedAt: string | null;
  isStale: boolean;
  onReverify: (() => void) | null;
}

class AiNoteVerificationModal extends Modal {
  private isApplying = false;

  constructor(
    app: App,
    private report: NoteVerificationReport,
    private onOpenSource: () => void,
    private context: NoteVerificationModalContext
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("recall-garden-verification-shell");
    contentEl.addClass("recall-garden-verification-modal");
    const header = contentEl.createDiv({ cls: "recall-garden-verification-header" });
    const copy = header.createDiv();
    copy.createDiv({ text: "AI NOTE REVIEW", cls: "recall-garden-eyebrow" });
    copy.createEl("h2", { text: `核验报告 · ${this.report.title}` });
    copy.createDiv({ text: this.report.sourcePath, cls: "recall-garden-verification-path" });
    header.createSpan({
      text: verificationVerdictLabel(this.report.verdict),
      cls: `recall-garden-verification-verdict is-${this.report.verdict.replace("_", "-")}`
    });

    const summary = contentEl.createDiv({ cls: "recall-garden-verification-summary" });
    summary.createEl("p", { text: this.report.summary });
    summary.createDiv({
      text: `置信度 ${Math.round(this.report.confidence * 100)}% · ${this.report.provider} / ${this.report.model}`,
      cls: "recall-garden-ai-model"
    });
    if (this.report.inputTruncated) {
      summary.createDiv({ text: "笔记过长，本次只核验了清理题库后的前 24,000 字符。", cls: "recall-garden-verification-truncated" });
    }

    if (this.context.savedAt) {
      const savedMeta = contentEl.createDiv({
        cls: `recall-garden-verification-saved-meta${this.context.isStale ? " is-stale" : ""}`
      });
      const savedCopy = savedMeta.createDiv();
      savedCopy.createEl("strong", {
        text: this.context.isStale ? "已保存报告 · 原笔记已有变化" : "报告已自动保存"
      });
      savedCopy.createSpan({
        text: this.context.isStale
          ? `保存于 ${formatVerificationTimestamp(this.context.savedAt)}，建议重新核验后再应用修订。`
          : `保存于 ${formatVerificationTimestamp(this.context.savedAt)}，再次打开不会调用 AI。`
      });
      if (this.context.isStale && this.context.onReverify) {
        const reverify = savedMeta.createEl("button", { text: "重新核验", cls: "mod-cta" });
        reverify.addEventListener("click", () => {
          this.close();
          this.context.onReverify?.();
        });
      }
    }

    const issues = contentEl.createDiv({ cls: "recall-garden-verification-issues" });
    if (this.report.issues.length === 0) {
      issues.createDiv({
        text: "没有发现明确的复制残留、事实冲突或高风险表述。仍建议对关键年代和原典引文做人工抽查。",
        cls: "recall-garden-verification-pass"
      });
    } else {
      this.report.issues.forEach((issue, index) => {
        const item = issues.createEl("section", { cls: `recall-garden-verification-issue is-${issue.severity}` });
        const meta = item.createDiv({ cls: "recall-garden-verification-issue-meta" });
        meta.createSpan({ text: `${index + 1}. ${noteVerificationTypeLabel(issue.type)}` });
        meta.createSpan({ text: noteVerificationSeverityLabel(issue.severity), cls: "recall-garden-verification-severity" });
        if (issue.quote) item.createEl("blockquote", { text: issue.quote });
        item.createEl("p", { text: issue.explanation });
        const suggestion = item.createDiv({ cls: "recall-garden-verification-suggestion" });
        suggestion.createEl("strong", { text: "建议" });
        suggestion.createSpan({ text: issue.suggestion });
        const hasReplacement = Boolean(issue.quote) && issue.replacement !== null;
        const canApply = hasReplacement && !this.context.isStale;
        if (hasReplacement) {
          const replacement = item.createDiv({ cls: "recall-garden-verification-replacement" });
          replacement.createEl("strong", { text: issue.replacement === "" ? "将执行" : "将改为" });
          replacement.createEl("code", { text: issue.replacement === "" ? "删除上方原文" : issue.replacement! });
        }
        const issueActions = item.createDiv({ cls: "recall-garden-verification-issue-actions" });
        const status = issueActions.createSpan({ cls: "recall-garden-verification-apply-status" });
        const apply = issueActions.createEl("button", {
          text: this.context.isStale
            ? "重新核验后修订"
            : canApply
              ? (issue.replacement === "" ? "删除此段" : "应用此修订")
              : "打开原文处理",
          cls: `recall-garden-verification-apply${canApply ? " mod-cta" : ""}`
        });
        apply.addEventListener("click", () => {
          if (this.context.isStale) {
            this.close();
            this.context.onReverify?.();
            return;
          }
          if (!canApply) {
            new Notice("这条意见需要人工查证，AI 未提供可安全写回的替换文本");
            this.onOpenSource();
            this.close();
            return;
          }
          void this.applyIssue(issue, item, apply, status);
        });
      });
    }

    contentEl.createDiv({
      text: "AI 核验用于定位风险，不是权威事实来源。高风险条目请回到教材、原典或可靠文献复核；单条修订仅在原文唯一匹配时写回。",
      cls: "recall-garden-verification-disclaimer"
    });

    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const close = actions.createEl("button", { text: "关闭" });
    close.addEventListener("click", () => this.close());
    const copyReport = actions.createEl("button", { text: "复制修订清单" });
    copyReport.addEventListener("click", async () => {
      await navigator.clipboard.writeText(formatVerificationReport(this.report));
      new Notice("核验修订清单已复制");
    });
    const open = actions.createEl("button", { text: "打开原笔记", cls: "mod-cta" });
    open.addEventListener("click", () => {
      this.onOpenSource();
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async applyIssue(
    issue: NoteVerificationIssue,
    item: HTMLElement,
    button: HTMLButtonElement,
    status: HTMLElement
  ): Promise<void> {
    if (this.isApplying) {
      new Notice("正在写回上一条修订，请稍候");
      return;
    }
    this.isApplying = true;
    button.disabled = true;
    status.setText("正在核对原文…");
    let applied = false;

    try {
      const file = this.app.vault.getAbstractFileByPath(this.report.sourcePath);
      if (!(file instanceof TFile)) throw new Error("原笔记已移动或删除，请重新核验");

      const current = await this.app.vault.read(file);
      const preview = applyNoteVerificationReplacement(current, issue);
      if (preview.status !== "applied") {
        this.showPatchFailure(preview.status, preview.matchCount, status);
        return;
      }

      let liveStatus: NoteVerificationReplacementStatus = preview.status;
      let liveMatches = preview.matchCount;
      await this.app.vault.process(file, (latest) => {
        const result = applyNoteVerificationReplacement(latest, issue);
        liveStatus = result.status;
        liveMatches = result.matchCount;
        return result.status === "applied" ? result.markdown : latest;
      });
      if (liveStatus !== "applied") {
        this.showPatchFailure(liveStatus, liveMatches, status);
        return;
      }

      applied = true;
      item.addClass("is-applied");
      button.setText(issue.replacement === "" ? "已删除" : "已应用");
      status.setText("已写回原笔记");
      new Notice(`已修改《${this.report.title}》中的这一处内容`);
    } catch (error) {
      status.setText("写回失败");
      new Notice(error instanceof Error ? error.message : "写回原笔记失败", 8_000);
    } finally {
      this.isApplying = false;
      if (!applied) button.disabled = false;
    }
  }

  private showPatchFailure(status: string, matchCount: number, target: HTMLElement): void {
    const messages: Record<string, string> = {
      not_found: "原文已变化，请重新核验",
      ambiguous: `找到 ${matchCount} 处相同原文，已停止写回`,
      unavailable: "这条意见需要人工处理",
      unchanged: "建议文本与原文相同，无需修改"
    };
    const message = messages[status] ?? "无法安全写回这条修订";
    target.setText(message);
    new Notice(message, 8_000);
  }
}

class AiLearningPreviewModal extends Modal {
  private isWriting = false;

  constructor(
    app: App,
    private sourceMarkdown: string,
    private pack: AiLearningPack,
    private existingQuestions: readonly AiQuestion[],
    private onConfirmWrite: () => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("recall-garden-learning-shell");
    const { contentEl } = this;
    contentEl.addClass("recall-garden-learning-preview");
    contentEl.createDiv({ text: "AI LEARNING PACK · V1.0", cls: "recall-garden-eyebrow" });
    contentEl.createEl("h2", { text: `完整预览 · ${this.pack.title}` });
    contentEl.createEl("p", {
      text: `以下全部内容仅为预览。确认后才会写回 ${this.pack.sourcePath}；笔记在预览期间若发生变化，忆园会拒绝覆盖。`,
      cls: "setting-item-description"
    });

    const summary = contentEl.createDiv({ cls: "recall-garden-learning-summary" });
    this.renderSummaryChip(summary, "30秒版", "1份");
    this.renderSummaryChip(summary, "八段补全", this.pack.sections.length > 0 ? `${this.pack.sections.length}段` : "已完整");
    this.renderSummaryChip(summary, "挖空", `${this.pack.cloze.length}题`);
    this.renderSummaryChip(summary, "干扰项", "4选1");
    this.renderSummaryChip(summary, "辨析", `${this.pack.distinctions.length}题`);
    this.renderSummaryChip(summary, "原有AI题库", `${this.existingQuestions.length}题`);

    const scroller = contentEl.createDiv({ cls: "recall-garden-learning-scroll" });
    const grid = scroller.createDiv({ cls: "recall-garden-learning-grid" });
    this.renderTextCard(grid, "30秒默写版", this.pack.shortAnswer, "将替换或新增");

    if (this.pack.sections.length > 0) {
      for (const section of this.pack.sections) {
        this.renderTextCard(grid, `${section.number}. ${section.title}`, section.body, "缺失段补全");
      }
    } else {
      this.renderTextCard(grid, "八段式补全", "当前笔记的 1—8 段编号齐全，本次不会改写现有八段正文。", "无需补写");
    }

    const clozeCard = grid.createDiv({ cls: "recall-garden-learning-card is-exercise" });
    this.renderCardHeading(clozeCard, "挖空练习", `${this.pack.cloze.length}题`);
    this.pack.cloze.forEach((item, index) => {
      const itemEl = clozeCard.createDiv({ cls: "recall-garden-learning-exercise" });
      itemEl.createEl("strong", { text: `${index + 1}. ${item.prompt}` });
      itemEl.createDiv({ text: `答案：${item.answers.join(" / ")}`, cls: "recall-garden-learning-answer" });
      itemEl.createDiv({ text: item.explanation, cls: "setting-item-description" });
    });

    const choiceCard = grid.createDiv({ cls: "recall-garden-learning-card is-exercise" });
    this.renderCardHeading(choiceCard, "干扰项单选", "逐项辨析");
    choiceCard.createEl("strong", { text: this.pack.choice.prompt });
    const options = choiceCard.createEl("ol", { cls: "recall-garden-learning-options" });
    this.pack.choice.options.forEach((option, index) => {
      const item = options.createEl("li");
      if (index === this.pack.choice.answerIndex) item.addClass("is-correct");
      item.createEl("strong", { text: `${String.fromCharCode(65 + index)}. ${option}` });
      item.createDiv({ text: this.pack.choice.optionAnalysis[index], cls: "setting-item-description" });
    });
    choiceCard.createDiv({ text: this.pack.choice.explanation, cls: "recall-garden-learning-answer" });

    const distinctionCard = grid.createDiv({ cls: "recall-garden-learning-card is-exercise" });
    this.renderCardHeading(distinctionCard, "辨析题", `${this.pack.distinctions.length}题`);
    this.pack.distinctions.forEach((item, index) => {
      const itemEl = distinctionCard.createDiv({ cls: "recall-garden-learning-exercise" });
      itemEl.createEl("strong", { text: `${index + 1}. ${item.prompt}` });
      itemEl.createDiv({ text: item.answer, cls: "recall-garden-learning-answer" });
      const points = itemEl.createEl("ul");
      item.keyPoints.forEach((point) => points.createEl("li", { text: point }));
      itemEl.createDiv({ text: item.explanation, cls: "setting-item-description" });
    });

    if (this.existingQuestions.length > 0) {
      const questionBankCard = grid.createDiv({ cls: "recall-garden-learning-card is-exercise" });
      this.renderCardHeading(questionBankCard, "原有AI变式练习", `${this.existingQuestions.length}题 · 将一并写回`);
      this.existingQuestions.forEach((question, index) => {
        const itemEl = questionBankCard.createDiv({ cls: "recall-garden-learning-exercise" });
        itemEl.createEl("strong", { text: `${index + 1}. ${question.prompt}` });
        if (question.type === "choice") {
          const options = itemEl.createEl("ol", { cls: "recall-garden-learning-options" });
          question.options.forEach((option, optionIndex) => {
            const optionEl = options.createEl("li", {
              text: `${String.fromCharCode(65 + optionIndex)}. ${option}`
            });
            if (optionIndex === question.answerIndex) optionEl.addClass("is-correct");
          });
          itemEl.createDiv({
            text: `答案：${String.fromCharCode(65 + question.answerIndex)}`,
            cls: "recall-garden-learning-answer"
          });
        } else if (question.type === "fill") {
          const aliases = question.acceptedAnswers.filter((answer) => answer !== question.answer);
          itemEl.createDiv({
            text: `答案：${question.answer}${aliases.length > 0 ? `（也可：${aliases.join("、")}）` : ""}`,
            cls: "recall-garden-learning-answer"
          });
        } else {
          const pairs = itemEl.createEl("ul");
          question.pairs.forEach((pair) => pairs.createEl("li", { text: `${pair.left} → ${pair.right}` }));
        }
        if (question.explanation.trim()) {
          itemEl.createDiv({ text: question.explanation, cls: "setting-item-description" });
        }
      });
    }

    const writeback = buildAiLearningWritebackPreview(this.sourceMarkdown, this.pack, this.existingQuestions);
    const fullPreview = scroller.createEl("details", { cls: "recall-garden-learning-markdown-preview" });
    fullPreview.createEl("summary", { text: "查看写回后的完整 Markdown" });
    fullPreview.createEl("pre", { text: writeback.markdown });

    contentEl.createEl("p", {
      text: `模型：${this.pack.provider} / ${this.pack.model} · 生成：${formatVerificationTimestamp(this.pack.generatedAt)}`,
      cls: "recall-garden-ai-model"
    });
    const status = contentEl.createDiv({ cls: "recall-garden-learning-status" });
    const actions = contentEl.createDiv({ cls: "modal-button-container recall-garden-learning-actions" });
    const discard = actions.createEl("button", { text: "丢弃，不写回" });
    discard.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { text: "确认并写回全部", cls: "mod-cta" });
    confirm.addEventListener("click", async () => {
      if (this.isWriting) return;
      this.isWriting = true;
      confirm.disabled = true;
      discard.disabled = true;
      status.setText("正在安全写回…");
      try {
        await this.onConfirmWrite();
        status.setText("已写回原笔记");
        this.close();
      } catch (error) {
        status.setText(error instanceof Error ? error.message : "写回失败");
        confirm.disabled = false;
        discard.disabled = false;
      } finally {
        this.isWriting = false;
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderSummaryChip(parent: HTMLElement, label: string, value: string): void {
    const chip = parent.createDiv({ cls: "recall-garden-learning-chip" });
    chip.createSpan({ text: label });
    chip.createEl("strong", { text: value });
  }

  private renderTextCard(parent: HTMLElement, title: string, body: string, badge: string): void {
    const card = parent.createDiv({ cls: "recall-garden-learning-card" });
    this.renderCardHeading(card, title, badge);
    card.createEl("pre", { text: body, cls: "recall-garden-learning-copy" });
  }

  private renderCardHeading(parent: HTMLElement, title: string, badge: string): void {
    const header = parent.createDiv({ cls: "recall-garden-learning-card-header" });
    header.createEl("h3", { text: title });
    header.createSpan({ text: badge, cls: "recall-garden-badge" });
  }
}

class AiQuestionPreviewModal extends Modal {
  constructor(
    app: App,
    private question: AiQuestion,
    private onSaveQuestion: () => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("recall-garden-ai-preview");
    contentEl.createEl("h2", { text: `预览${questionTypeLabel(this.question.type)}` });
    contentEl.createEl("p", { text: this.question.prompt, cls: "recall-garden-ai-prompt" });
    if (this.question.type === "choice") {
      const choice = this.question;
      const list = contentEl.createEl("ol");
      choice.options.forEach((option, index) => {
        const item = list.createEl("li", { text: option });
        if (index === choice.answerIndex) item.addClass("is-correct");
      });
    } else if (this.question.type === "fill") {
      contentEl.createEl("p", { text: `答案：${this.question.answer}` });
      if (this.question.acceptedAnswers.length > 0) {
        contentEl.createEl("p", { text: `同义答案：${this.question.acceptedAnswers.join("、")}` });
      }
    } else {
      const list = contentEl.createEl("ul");
      this.question.pairs.forEach((pair) => list.createEl("li", { text: `${pair.left} → ${pair.right}` }));
    }
    if (this.question.explanation) {
      contentEl.createDiv({ text: this.question.explanation, cls: "recall-garden-ai-preview-explanation" });
    }
    contentEl.createEl("p", {
      text: `来源：${this.question.provider} / ${this.question.model}`,
      cls: "recall-garden-ai-model"
    });

    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const discard = actions.createEl("button", { text: "丢弃" });
    discard.addEventListener("click", () => this.close());
    const save = actions.createEl("button", { text: "保存到题库", cls: "mod-cta" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      await this.onSaveQuestion();
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class CodexLoginModal extends Modal {
  private cancelled = false;

  constructor(
    app: App,
    private plugin: RecallGardenPlugin,
    private onFinished: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.addClass("recall-garden-login");
    void this.beginLogin();
  }

  onClose(): void {
    this.cancelled = true;
    this.contentEl.empty();
  }

  private async beginLogin(): Promise<void> {
    const content = this.contentEl;
    content.empty();
    content.createEl("h2", { text: "登录 OpenAI Codex" });
    const status = content.createEl("p", { text: "正在申请独立登录码…" });
    try {
      const info = await this.plugin.aiService.startCodexDeviceLogin();
      if (this.cancelled) return;
      status.setText("在浏览器完成登录，忆园会自动检查状态。");
      this.renderLoginCode(content, info);
      window.open(info.verificationUrl, "_blank", "noopener,noreferrer");
      await this.pollUntilComplete(info, status);
    } catch (error) {
      if (this.cancelled) return;
      status.setText(error instanceof Error ? error.message : "Codex 登录失败");
      status.addClass("mod-warning");
    }
  }

  private renderLoginCode(content: HTMLElement, info: DeviceLoginInfo): void {
    const code = content.createDiv({ text: info.userCode, cls: "recall-garden-login-code" });
    code.setAttr("aria-label", "Codex 登录码");
    const actions = content.createDiv({ cls: "modal-button-container" });
    const copy = actions.createEl("button", { text: "复制登录码" });
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(info.userCode);
      new Notice("登录码已复制");
    });
    const open = actions.createEl("button", { text: "打开登录页", cls: "mod-cta" });
    open.addEventListener("click", () => window.open(info.verificationUrl, "_blank", "noopener,noreferrer"));
  }

  private async pollUntilComplete(info: DeviceLoginInfo, status: HTMLElement): Promise<void> {
    while (!this.cancelled && Date.now() < info.expiresAt) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, info.intervalSeconds * 1_000));
      if (this.cancelled) return;
      const result = await this.plugin.aiService.pollCodexDeviceLogin(info);
      if (result.status === "pending") continue;
      status.setText("登录成功，正在获取可用模型…");
      await this.plugin.aiService.finishCodexDeviceLogin(result);
      try {
        const models = await this.plugin.refreshCodexModels();
        status.setText(`登录成功，已发现 ${models.length} 个可用模型。`);
      } catch (error) {
        status.setText(`登录成功；${error instanceof Error ? error.message : "模型列表暂不可用"}`);
      }
      this.onFinished();
      window.setTimeout(() => this.close(), 900);
      return;
    }
    if (!this.cancelled) status.setText("登录码已过期，请关闭后重试。");
  }
}

class RecallGardenSettingTab extends PluginSettingTab {
  private plugin: RecallGardenPlugin;

  constructor(app: App, plugin: RecallGardenPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    if (this.plugin.dataReadOnlyReason) {
      containerEl.createEl("h2", { text: "Recall Garden｜忆园（只读保护）" });
      containerEl.createEl("p", {
        text: this.plugin.dataReadOnlyReason,
        cls: "recall-garden-readonly-warning"
      });
      containerEl.createEl("p", {
        text: "当前插件版本不会修改设置、调度记录或 data.json。请安装支持该数据版本的新版插件后再继续。",
        cls: "setting-item-description"
      });
      return;
    }

    containerEl.createEl("h3", { text: "外观与皮肤" });
    const skinPreview = containerEl.createDiv({ cls: "recall-garden-view recall-garden-skin-preview" });
    applyUiSkin(
      skinPreview,
      this.plugin.data.settings.uiSkin,
      this.plugin.data.settings.enableVisualEffects
    );
    const previewHeader = skinPreview.createDiv({ cls: "recall-garden-skin-preview-header" });
    const previewMark = previewHeader.createDiv({ cls: "recall-garden-brand-mark" });
    setIcon(previewMark, "sprout");
    const previewCopy = previewHeader.createDiv({ cls: "recall-garden-skin-preview-copy" });
    previewCopy.createDiv({ text: "SKIN PREVIEW", cls: "recall-garden-eyebrow" });
    const previewTitle = previewCopy.createEl("strong");
    const previewDescription = previewCopy.createDiv({ cls: "setting-item-description" });
    const previewCard = skinPreview.createDiv({ cls: "recall-garden-skin-preview-card" });
    previewCard.createSpan({ text: "真题卡 · 优先级 S", cls: "recall-garden-badge is-exam" });
    previewCard.createEl("strong", { text: "Photosynthesis" });
    const previewTrack = previewCard.createDiv({ cls: "recall-garden-progress-track" });
    const previewFill = previewTrack.createDiv({ cls: "recall-garden-progress-fill" });
    previewFill.style.width = "68%";
    const updateSkinPreview = (skin: UiSkin): void => {
      const meta = UI_SKINS[skin];
      previewTitle.setText(meta.label);
      previewDescription.setText(meta.description);
      applyUiSkin(skinPreview, skin, this.plugin.data.settings.enableVisualEffects);
    };
    updateSkinPreview(this.plugin.data.settings.uiSkin);

    new Setting(containerEl)
      .setName("界面皮肤")
      .setDesc("复习页与诊断页同步切换，保存后立即生效。")
      .addDropdown((dropdown) => {
        for (const value of Object.keys(UI_SKINS) as UiSkin[]) {
          dropdown.addOption(value, UI_SKINS[value].label);
        }
        dropdown.setValue(this.plugin.data.settings.uiSkin).onChange(async (value) => {
          const skin = normalizeUiSkin(value);
          this.plugin.data.settings.uiSkin = skin;
          await this.plugin.savePluginData();
          this.plugin.refreshUiSkin();
          updateSkinPreview(skin);
        });
      });

    new Setting(containerEl)
      .setName("视觉动效")
      .setDesc("控制极光、光带、悬停抬升和玻璃模糊；关闭后更省电，系统的“减少动态效果”仍具有最高优先级。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.data.settings.enableVisualEffects).onChange(async (value) => {
          this.plugin.data.settings.enableVisualEffects = value;
          await this.plugin.savePluginData();
          this.plugin.refreshUiSkin();
          applyUiSkin(skinPreview, this.plugin.data.settings.uiSkin, value);
        })
      );

    containerEl.createEl("h3", { text: "考试倒计时" });

    new Setting(containerEl)
      .setName("考试名称")
      .setDesc("显示在复习页倒计时卡片中。")
      .addText((text) =>
        text
          .setPlaceholder("2026 年 12 月考试")
          .setValue(this.plugin.data.settings.examName)
          .onChange(async (value) => {
            this.plugin.data.settings.examName = value.trim();
            await this.plugin.savePluginData();
            this.plugin.refreshExamCountdownViews();
          })
      );

    new Setting(containerEl)
      .setName("考试开始日期")
      .setDesc("倒计时归零后进入“考试进行中”。")
      .addText((text) => {
        text.inputEl.type = "date";
        text.setValue(this.plugin.data.settings.examStartDate).onChange(async (value) => {
          if (!value) return;
          this.plugin.data.settings.examStartDate = value;
          if (this.plugin.data.settings.examEndDate < value) this.plugin.data.settings.examEndDate = value;
          await this.plugin.savePluginData();
          this.plugin.refreshExamCountdownViews();
        });
      });

    new Setting(containerEl)
      .setName("考试结束日期")
      .setDesc("两天考试请填写最后一天；不得早于开始日期。")
      .addText((text) => {
        text.inputEl.type = "date";
        text.setValue(this.plugin.data.settings.examEndDate).onChange(async (value) => {
          if (!value) return;
          this.plugin.data.settings.examEndDate = value < this.plugin.data.settings.examStartDate
            ? this.plugin.data.settings.examStartDate
            : value;
          await this.plugin.savePluginData();
          this.plugin.refreshExamCountdownViews();
        });
      });

    containerEl.createEl("h3", { text: "制卡与资料库" });

    new Setting(containerEl)
      .setName("新建八段式复习卡")
      .setDesc("打开忆园原生制卡向导；支持概念卡、对比卡和应用迁移卡，手机端也可从丝带栏进入。")
      .addButton((button) =>
        button.setCta().setButtonText("新建卡片").onClick(() => this.plugin.openCardCreator())
      );

    new Setting(containerEl)
      .setName("忆园 Bases 资料库")
      .setDesc(`生成或更新 Vault/${BASES_DASHBOARD_PATH}，包含全部、真题、高频、S级、待处理和按科目六个视图。请先启用内置 Bases。`)
      .addButton((button) =>
        button.setButtonText("生成/更新").onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.generateBasesDashboard();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "生成忆园资料库失败", 8_000);
          } finally {
            button.setDisabled(false);
          }
        })
      );

    new Setting(containerEl)
      .setName("今日学习计划")
      .setDesc(`生成或更新 Vault/${DAILY_PLAN_FOLDER}/日期.md。任务使用 Tasks 兼容语法；未安装 Tasks 时仍是可勾选的普通 Markdown。重复更新会保留勾选和手写复盘。`)
      .addButton((button) =>
        button.setButtonText("生成/更新").onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.generateDailyStudyPlan();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "生成今日学习计划失败", 8_000);
          } finally {
            button.setDisabled(false);
          }
        })
      );

    containerEl.createEl("h3", { text: "扫描与队列" });

    new Setting(containerEl)
      .setName("扫描文件夹")
      .setDesc("相对于 Vault 根目录，例如 Recall Garden/Cards。留空表示扫描整个 Vault。")
      .addText((text) =>
        text
          .setPlaceholder("Recall Garden/Cards")
          .setValue(this.plugin.data.settings.folder)
          .onChange(async (value) => {
            this.plugin.data.settings.folder = value.trim();
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("只收录完整8段式")
      .setDesc("关闭时，只要包含标准答题版和30秒默写版即可进入队列。建议保持关闭。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.data.settings.strictEightSections).onChange(async (value) => {
          this.plugin.data.settings.strictEightSections = value;
          await this.plugin.savePluginData();
          await this.plugin.scanVault({ resetSessions: true });
        })
      );

    new Setting(containerEl)
      .setName("每日新卡上限")
      .setDesc(`当前 ${this.plugin.data.settings.dailyNewCards} 张。超过20张容易产生20分钟与次日回流高峰，插件只预警，不强制修改。`)
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(this.plugin.data.settings.dailyNewCards)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) return;
          this.plugin.data.settings.dailyNewCards = Math.max(0, Math.min(200, parsed));
          await this.plugin.savePluginData();
        });
      });

    new Setting(containerEl)
      .setName("暂停新卡，只清复习债务")
      .setDesc("开启后今日队列不再加入未学习卡，已到期旧卡仍按风险优先级出现。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.data.settings.pauseNewCards).onChange(async (value) => {
          await this.plugin.setPauseNewCards(value);
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("单轮复习上限")
      .setDesc("到期卡与新卡合计的最大数量。")
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(this.plugin.data.settings.dailyReviewLimit)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) return;
          this.plugin.data.settings.dailyReviewLimit = Math.max(1, Math.min(1_000, parsed));
          await this.plugin.savePluginData();
        });
      });

    new Setting(containerEl)
      .setName("记录答题用时")
      .setDesc("关闭后仍记录评分、揭示层级和是否看过完整答案，但用时保存为 null。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.data.settings.trackAnswerTime).onChange(async (value) => {
          this.plugin.data.settings.trackAnswerTime = value;
          await this.plugin.savePluginData();
        })
      );

    containerEl.createEl("h3", { text: "FSRS 自适应调度" });
    new Setting(containerEl)
      .setName("调度算法")
      .setDesc("当前使用 FSRS-6。旧阶段卡会在下一次评分时按原复习次数、错误次数和既有间隔生成初始记忆状态，不会清零重学。");

    new Setting(containerEl)
      .setName("目标记忆率")
      .setDesc("越高越容易记住，但复习量也越大。建议保持 90%；合理范围为 70%—97%。")
      .addSlider((slider) =>
        slider
          .setLimits(70, 97, 1)
          .setValue(Math.round(this.plugin.data.settings.desiredRetention * 100))
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.data.settings.desiredRetention = value / 100;
            await this.plugin.savePluginData();
            this.plugin.refreshOpenViews();
          })
      );

    new Setting(containerEl)
      .setName("最长复习间隔")
      .setDesc("单位为天。用于限制已高度掌握卡片的最远到期时间，默认 3650 天。")
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(this.plugin.data.settings.maximumIntervalDays)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) return;
          this.plugin.data.settings.maximumIntervalDays = Math.max(1, Math.min(36_500, parsed));
          await this.plugin.savePluginData();
        });
      });

    containerEl.createEl("h3", { text: "数据安全" });

    const shadowStatus = this.plugin.getShadowStoreStatus();
    new Setting(containerEl)
      .setName("v0.9 影子事件日志")
      .setDesc(
        shadowStatus.initialized
          ? `${shadowStatus.chainValid ? "哈希链完整" : `异常：${shadowStatus.error}`} · 本设备 ${shortDeviceId(shadowStatus.deviceId)} · ${shadowStatus.eventCount} 条评分事件。当前 Schema v5 仍是唯一主数据源。`
          : "正在初始化设备级影子日志；当前 Schema v5 仍是唯一主数据源。"
      )
      .addButton((button) =>
        button.setButtonText("检查事件链").onClick(async () => {
          button.setDisabled(true);
          await this.plugin.verifyShadowEventLog(true);
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("导出忆园数据快照")
      .setDesc(`保存到 Vault/${SNAPSHOT_FOLDER}。快照包含调度、归档和 AI 题，但不包含 OAuth 令牌或 API Key。`)
      .addButton((button) =>
        button.setButtonText("导出快照").onClick(async () => {
          try {
            await this.plugin.exportDataSnapshot();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "导出快照失败", 8_000);
          }
        })
      );

    new Setting(containerEl)
      .setName("从快照恢复")
      .setDesc("恢复前先显示数量与稳定 ID 差异；确认后自动备份当前数据，再执行恢复。")
      .addButton((button) =>
        button.setButtonText("选择快照").setWarning().onClick(() => this.plugin.openSnapshotPicker())
      );

    containerEl.createEl("h3", { text: "AI 学习、出题与核验" });
    containerEl.createEl("p", {
      text: "AI学习补全会在一次生成中提供30秒版、缺失八段、挖空、干扰项单选与辨析题，完整预览并确认后才写回；笔记核验也只在你主动点击时发送当前笔记。两者都会剔除忆园托管区块，避免旧练习干扰生成。最新核验报告保存到 Vault/Recall Garden/.data/verifications，不写入 data.json。网络使用、账户要求和数据范围详见公开仓库的隐私说明。",
      cls: "setting-item-description"
    });

    new Setting(containerEl)
      .setName("AI 提供方")
      .setDesc("关闭时保留已生成题库，但不发送任何网络请求。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("disabled", "关闭")
          .addOption("codex-oauth", "OpenAI Codex（独立登录）")
          .addOption("deepseek", "DeepSeek API")
          .setValue(this.plugin.data.settings.aiProvider)
          .onChange(async (value) => {
            this.plugin.data.settings.aiProvider = value as AiProvider;
            await this.plugin.savePluginData();
            this.display();
          })
      );

    if (!requireApiVersion("1.11.4")) {
      new Setting(containerEl)
        .setName("AI 功能不可用")
        .setDesc("安全保存 OAuth 令牌需要 Obsidian 1.11.4 或更高版本。请先升级 Obsidian。");
    } else if (this.plugin.data.settings.aiProvider === "codex-oauth") {
      const loggedIn = this.plugin.aiService.isCodexLoggedIn();
      new Setting(containerEl)
        .setName("Codex 登录")
        .setDesc(loggedIn ? "已保存本插件独立的 OAuth 会话；不会读取其他应用的令牌。" : "使用 ChatGPT/Codex 设备码登录。")
        .addButton((button) =>
          button.setButtonText(loggedIn ? "重新登录" : "登录").setCta().onClick(() => {
            new CodexLoginModal(this.app, this.plugin, () => this.display()).open();
          })
        )
        .addButton((button) => {
          button.setButtonText("退出").setDisabled(!loggedIn).onClick(() => {
            this.plugin.aiService.logoutCodex();
            this.plugin.data.settings.codexModels = [];
            this.plugin.data.settings.codexModel = "";
            void this.plugin.savePluginData();
            this.display();
          });
        });

      new Setting(containerEl)
        .setName("Codex 模型")
        .setDesc("模型清单来自当前账号的 Codex 后端；不硬编码可能失效的模型名。")
        .addDropdown((dropdown) => {
          const models = this.plugin.data.settings.codexModels;
          if (models.length === 0) dropdown.addOption("", "登录后刷新模型");
          for (const model of models) dropdown.addOption(model, model);
          const current = this.plugin.data.settings.codexModel;
          if (current && !models.includes(current)) dropdown.addOption(current, current);
          dropdown.setValue(current).onChange(async (value) => {
            this.plugin.data.settings.codexModel = value;
            await this.plugin.savePluginData();
          });
        })
        .addButton((button) =>
          button.setButtonText("刷新模型").setDisabled(!loggedIn).onClick(async () => {
            button.setDisabled(true);
            try {
              const models = await this.plugin.refreshCodexModels();
              new Notice(`已获取 ${models.length} 个 Codex 模型`);
              this.display();
            } catch (error) {
              new Notice(error instanceof Error ? error.message : "刷新模型失败", 8_000);
              button.setDisabled(false);
            }
          })
        );

      new Setting(containerEl)
        .setName("手动模型名")
        .setDesc("仅在模型列表暂时无法获取时使用；后端是否接受由当前账号决定。")
        .addText((text) =>
          text.setPlaceholder("例如当前账号可用的模型 slug").setValue(this.plugin.data.settings.codexModel).onChange(async (value) => {
            this.plugin.data.settings.codexModel = value.trim();
            await this.plugin.savePluginData();
          })
        );

      new Setting(containerEl)
        .setName("兼容性说明")
        .setDesc("该通道使用 ChatGPT Codex 的非公开稳定后端，可能因上游协议变化而失效。请勿发送敏感笔记；公开市场用户可改用自有 DeepSeek API。 ");
    } else if (this.plugin.data.settings.aiProvider === "deepseek") {
      new Setting(containerEl)
        .setName("DeepSeek API Key")
        .setDesc("密钥由 Obsidian SecretStorage 保存；data.json 只记录密钥名称。")
        .addComponent((element) =>
          new SecretComponent(this.app, element)
            .setValue(this.plugin.data.settings.deepseekSecretId)
            .onChange(async (value) => {
              this.plugin.data.settings.deepseekSecretId = value;
              await this.plugin.savePluginData();
            })
        );

      new Setting(containerEl)
        .setName("DeepSeek 模型")
        .setDesc("默认使用 deepseek-v4-flash，可按账号实际可用模型修改。")
        .addText((text) =>
          text.setValue(this.plugin.data.settings.deepseekModel).onChange(async (value) => {
            this.plugin.data.settings.deepseekModel = value.trim();
            await this.plugin.savePluginData();
          })
        );

      new Setting(containerEl)
        .setName("DeepSeek Base URL")
        .setDesc("默认 https://api.deepseek.com；兼容代理可在此修改。")
        .addText((text) =>
          text.setValue(this.plugin.data.settings.deepseekBaseUrl).onChange(async (value) => {
            this.plugin.data.settings.deepseekBaseUrl = value.trim();
            await this.plugin.savePluginData();
          })
        );
    }

    new Setting(containerEl)
      .setName("立即重新扫描")
      .setDesc("应用文件夹和识别规则，并刷新已经打开的忆园视图。")
      .addButton((button) =>
        button.setButtonText("重新扫描").onClick(async () => {
          await this.plugin.scanVault({ resetSessions: true });
          new Notice(`忆园已识别 ${this.plugin.cards.length} 张学习卡`);
        })
      );
  }
}

function renderExamCountdown(parent: HTMLElement, config: ExamCountdownConfig): (() => void) | null {
  const initialCountdown = buildExamCountdown(config);
  if (!initialCountdown) return null;

  const banner = parent.createDiv({ cls: `recall-garden-exam-countdown is-${initialCountdown.status}` });
  const identity = banner.createDiv({ cls: "recall-garden-exam-identity" });
  const icon = identity.createDiv({ cls: "recall-garden-exam-icon" });
  setIcon(icon, "alarm-clock");
  const copy = identity.createDiv({ cls: "recall-garden-exam-copy" });
  copy.createDiv({ text: "EXAM COUNTDOWN", cls: "recall-garden-eyebrow" });
  copy.createEl("h3", { text: initialCountdown.name });
  copy.createDiv({ text: initialCountdown.dateLabel, cls: "recall-garden-exam-date" });

  const metric = banner.createDiv({ cls: "recall-garden-exam-metric" });
  let renderedStatus: typeof initialCountdown.status | null = null;
  let renderedSignature = "";
  let dayValue: HTMLElement | null = null;
  let hourValue: HTMLElement | null = null;
  let minuteValue: HTMLElement | null = null;
  let secondValue: HTMLElement | null = null;

  const renderMetric = (countdown: NonNullable<ReturnType<typeof buildExamCountdown>>): void => {
    banner.classList.remove("is-upcoming", "is-active", "is-ended");
    banner.classList.add(`is-${countdown.status}`);
    metric.empty();
    dayValue = null;
    hourValue = null;
    minuteValue = null;
    secondValue = null;

    const valueLine = metric.createDiv({ cls: "recall-garden-exam-value" });
    if (countdown.status === "upcoming" && countdown.remaining) {
      valueLine.addClass("is-precise");
      const createTimePart = (label: string): HTMLElement => {
        const part = valueLine.createSpan({ cls: "recall-garden-exam-time-part" });
        const value = part.createEl("strong");
        part.createSpan({ text: label, cls: "recall-garden-exam-time-label" });
        return value;
      };
      dayValue = createTimePart("天");
      hourValue = createTimePart("时");
      minuteValue = createTimePart("分");
      secondValue = createTimePart("秒");
    } else {
      valueLine.createEl("strong", { text: countdown.value });
      valueLine.createSpan({ text: countdown.unit });
    }
    metric.createEl("small", { text: countdown.detail });
    renderedStatus = countdown.status;
    renderedSignature = `${countdown.status}|${countdown.value}|${countdown.unit}|${countdown.detail}`;
  };

  const update = (): void => {
    const countdown = buildExamCountdown(config);
    if (!countdown) return;
    const signature = `${countdown.status}|${countdown.value}|${countdown.unit}|${countdown.detail}`;
    if (renderedStatus !== countdown.status || (!countdown.remaining && renderedSignature !== signature)) {
      renderMetric(countdown);
    }

    if (countdown.remaining && dayValue && hourValue && minuteValue && secondValue) {
      dayValue.setText(String(countdown.remaining.days));
      hourValue.setText(String(countdown.remaining.hours).padStart(2, "0"));
      minuteValue.setText(String(countdown.remaining.minutes).padStart(2, "0"));
      secondValue.setText(String(countdown.remaining.seconds).padStart(2, "0"));
      banner.setAttr(
        "aria-label",
        `${countdown.name}，距离开考 ${countdown.remaining.days} 天 ${countdown.remaining.hours} 时 ${countdown.remaining.minutes} 分 ${countdown.remaining.seconds} 秒`
      );
    } else {
      banner.setAttr("aria-label", `${countdown.name}，${countdown.value}${countdown.unit}`);
    }
  };

  let timer: number | null = null;
  let stopped = false;
  const scheduleNextTick = (): void => {
    if (stopped) return;
    const delay = 1_000 - (Date.now() % 1_000) + 20;
    timer = window.setTimeout(() => {
      update();
      scheduleNextTick();
    }, delay);
  };

  renderMetric(initialCountdown);
  update();
  scheduleNextTick();
  return () => {
    stopped = true;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
}

function parseCalendarDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function formatCalendarDay(dateKey: string): string {
  const date = parseCalendarDateKey(dateKey);
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${date.getMonth() + 1}月${date.getDate()}日 · ${weekdays[date.getDay()]}`;
}

function dayStatusLabel(day: StudyCalendarDay): string {
  if (day.isToday) return "TODAY · 今日行动";
  if (day.isPast) return day.completedCount > 0 ? "HISTORY · 复习证据" : "HISTORY · 历史快照";
  return day.scheduledCount > 0 ? "FORECAST · 到期预测" : "FORECAST · 暂无负担";
}

function localDateString(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sameLocalDate(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate();
}

function shortDeviceId(deviceId: string): string {
  return deviceId.length <= 16 ? deviceId : `${deviceId.slice(0, 10)}…${deviceId.slice(-4)}`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function debtTrendText(value: number | null): string {
  if (value === null) return "待积累";
  if (value === 0) return "持平";
  return value > 0 ? `+${value}` : String(value);
}

function verificationVerdictLabel(verdict: NoteVerificationReport["verdict"]): string {
  if (verdict === "pass") return "未见明显问题";
  if (verdict === "high_risk") return "存在高风险";
  return "建议修订";
}

function formatVerificationTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatVerificationReport(report: NoteVerificationReport): string {
  const lines = [
    `# AI 笔记核验 · ${report.title}`,
    "",
    `- 结论：${verificationVerdictLabel(report.verdict)}`,
    `- 来源：${report.sourcePath}`,
    `- 模型：${report.provider} / ${report.model}`,
    `- 置信度：${Math.round(report.confidence * 100)}%`,
    "",
    report.summary
  ];
  report.issues.forEach((issue, index) => {
    lines.push(
      "",
      `## ${index + 1}. ${noteVerificationTypeLabel(issue.type)} · ${noteVerificationSeverityLabel(issue.severity)}`,
      issue.quote ? `原文：${issue.quote}` : "",
      `问题：${issue.explanation}`,
      `建议：${issue.suggestion}`
    );
  });
  lines.push("", "> AI 核验不是权威事实来源，请结合教材、原典或可靠文献复核。单条修订仅在原文唯一匹配时写回。");
  return lines.filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n");
}
