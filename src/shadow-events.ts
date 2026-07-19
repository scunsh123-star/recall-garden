import type { Rating } from "./core";
import type { ReviewRecord } from "./data";
import type { FsrsMemoryState } from "./fsrs-scheduler";

export const SHADOW_EVENT_VERSION = 1 as const;

export interface ReviewRecordProjection {
  reviewId: string;
  sourcePath: string;
  stage: number;
  introducedAt: string;
  lastReviewedAt: string;
  nextReviewAt: string;
  lastRating: Rating;
  reviewCount: number;
  errorCount: number;
  fsrs: FsrsMemoryState | null;
}

export interface ShadowReviewEvent {
  version: typeof SHADOW_EVENT_VERSION;
  eventId: string;
  deviceId: string;
  occurredAt: string;
  type: "review";
  rating: Rating;
  revealLevel: 0 | 1 | 2;
  durationSeconds: number | null;
  before: ReviewRecordProjection | null;
  after: ReviewRecordProjection;
  previousHash: string;
  hash: string;
}

export interface CreateShadowReviewEventInput {
  eventId: string;
  deviceId: string;
  previousHash: string;
  rating: Rating;
  revealLevel: 0 | 1 | 2;
  durationSeconds: number | null;
  before: ReviewRecordProjection | null;
  after: ReviewRecordProjection;
}

export interface ShadowChainVerification {
  valid: boolean;
  eventCount: number;
  lastHash: string;
  invalidIndex: number | null;
}

export function projectReviewRecord(record: ReviewRecord): ReviewRecordProjection {
  return {
    reviewId: record.reviewId,
    sourcePath: record.sourcePath,
    stage: record.stage,
    introducedAt: record.introducedAt,
    lastReviewedAt: record.lastReviewedAt,
    nextReviewAt: record.nextReviewAt,
    lastRating: record.lastRating,
    reviewCount: record.reviewCount,
    errorCount: record.errorCount,
    fsrs: record.fsrs ? { ...record.fsrs } : null
  };
}

export async function createShadowReviewEvent(input: CreateShadowReviewEventInput): Promise<ShadowReviewEvent> {
  const body = {
    version: SHADOW_EVENT_VERSION,
    eventId: input.eventId,
    deviceId: input.deviceId,
    occurredAt: input.after.lastReviewedAt,
    type: "review" as const,
    rating: input.rating,
    revealLevel: input.revealLevel,
    durationSeconds: input.durationSeconds,
    before: input.before,
    after: input.after,
    previousHash: input.previousHash
  };
  return { ...body, hash: await hashEventBody(body) };
}

export async function verifyShadowEventChain(events: readonly ShadowReviewEvent[]): Promise<ShadowChainVerification> {
  let previousHash = "";
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const { hash, ...body } = event;
    const expectedHash = await hashEventBody(body);
    if (event.previousHash !== previousHash || hash !== expectedHash) {
      return { valid: false, eventCount: events.length, lastHash: previousHash, invalidIndex: index };
    }
    previousHash = hash;
  }
  return { valid: true, eventCount: events.length, lastHash: previousHash, invalidIndex: null };
}

export function parseShadowEventLog(jsonl: string): { events: ShadowReviewEvent[]; invalidLines: number[] } {
  const events: ShadowReviewEvent[] = [];
  const invalidLines: number[] = [];
  jsonl.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isShadowReviewEvent(parsed)) events.push(parsed);
      else invalidLines.push(index + 1);
    } catch {
      invalidLines.push(index + 1);
    }
  });
  return { events, invalidLines };
}

async function hashEventBody(body: Omit<ShadowReviewEvent, "hash">): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isShadowReviewEvent(value: unknown): value is ShadowReviewEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<ShadowReviewEvent>;
  return item.version === SHADOW_EVENT_VERSION && item.type === "review" &&
    typeof item.eventId === "string" && typeof item.deviceId === "string" &&
    typeof item.occurredAt === "string" && typeof item.previousHash === "string" &&
    typeof item.hash === "string" && (item.rating === 1 || item.rating === 2 || item.rating === 3 || item.rating === 4) &&
    (item.revealLevel === 0 || item.revealLevel === 1 || item.revealLevel === 2) &&
    item.after !== null && typeof item.after === "object";
}
