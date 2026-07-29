import type {
  OfficialQualityConsentReceipt,
  OfficialQualityConsentSettings,
  OfficialQualityFeedbackEligibility,
  OfficialQualityFeedbackSubmission,
  OfficialQualityFeedbackSubmissionResult,
  OfficialQualityPurpose,
} from "../../shared/agentera-official-quality";
import type {
  CollectOfficialQualityMetricInput,
  OfficialQualityFeedbackCandidate,
  OfficialQualityMetricCollector,
  OfficialQualityPrincipal,
} from "./collector";
import {
  AgenteraOfficialQualityClientError,
  type OfficialQualityClient,
} from "./client";
import type { AgenteraOfficialQualityDatabase } from "./db";

const MAXIMUM_RETRY_MILLISECONDS = 6 * 60 * 60 * 1_000;
const UPLOAD_BATCH_SIZE = 25;
const MAXIMUM_FEEDBACK_CANDIDATES = 128;
const FEEDBACK_CANDIDATE_TTL_MILLISECONDS = 30 * 60 * 1_000;

export interface AgenteraOfficialQualityManagerOptions {
  database: AgenteraOfficialQualityDatabase;
  client: OfficialQualityClient;
  collector: OfficialQualityMetricCollector;
  getPrincipal: () => OfficialQualityPrincipal | null;
  now?: () => Date;
  random?: () => number;
}

function retryDelay(attemptCount: number, random: () => number): number {
  const exponent = Math.min(Math.max(attemptCount, 0), 15);
  const base = Math.min(1_000 * 2 ** exponent, MAXIMUM_RETRY_MILLISECONDS);
  const sample = random();
  const boundedSample = Number.isFinite(sample)
    ? Math.min(Math.max(sample, 0), 1)
    : 0.5;
  return Math.min(
    Math.round(base * (1 + boundedSample * 0.5)),
    MAXIMUM_RETRY_MILLISECONDS,
  );
}

function samePrincipal(
  left: OfficialQualityPrincipal | null,
  right: OfficialQualityPrincipal | null,
): boolean {
  return (
    left?.accountId === right?.accountId && left?.deviceId === right?.deviceId
  );
}

export class AgenteraOfficialQualityManager {
  private readonly database: AgenteraOfficialQualityDatabase;
  private readonly client: OfficialQualityClient;
  private readonly collector: OfficialQualityMetricCollector;
  private readonly getPrincipal: () => OfficialQualityPrincipal | null;
  private readonly now: () => Date;
  private readonly random: () => number;
  private activeUpload: Promise<void> | null = null;
  private previousPrincipal: OfficialQualityPrincipal | null;
  private readonly feedbackCandidates = new Map<
    string,
    OfficialQualityFeedbackCandidate
  >();

  constructor(options: AgenteraOfficialQualityManagerOptions) {
    if (
      !options?.database ||
      !options.client ||
      !options.collector ||
      typeof options.collector.collectMetric !== "function" ||
      typeof options.collector.prepareFeedbackCandidate !== "function" ||
      typeof options.collector.collectFeedback !== "function" ||
      typeof options.getPrincipal !== "function"
    ) {
      throw new Error(
        "Invalid Aera official quality manager configuration.",
      );
    }
    this.database = options.database;
    this.client = options.client;
    this.collector = options.collector;
    this.getPrincipal = options.getPrincipal;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.previousPrincipal = this.getPrincipal();
  }

  recordMetric(
    input: CollectOfficialQualityMetricInput,
  ): OfficialQualityFeedbackEligibility | null {
    const metric = this.collector.collectMetric(input);
    const candidate = this.collector.prepareFeedbackCandidate(input);
    if (metric) {
      void this.uploadPending();
    }
    if (!candidate) return null;
    this.purgeExpiredFeedbackCandidates();
    this.feedbackCandidates.set(candidate.candidateId, candidate);
    while (this.feedbackCandidates.size > MAXIMUM_FEEDBACK_CANDIDATES) {
      const oldest = this.feedbackCandidates.keys().next().value as
        | string
        | undefined;
      if (!oldest) break;
      this.feedbackCandidates.delete(oldest);
    }
    return {
      eventId: candidate.candidateId,
      result: candidate.result,
      latencyBucket: candidate.latencyBucket,
      totalTokenBucket: candidate.totalTokenBucket,
      crashCode: candidate.crashCode,
    };
  }

  getConsent(): OfficialQualityConsentSettings {
    const principal = this.getPrincipal();
    if (!principal) return { passive: false, explicitFeedback: false };
    return this.database.readConsent(principal.accountId, principal.deviceId);
  }

  async submitFeedback(
    input: OfficialQualityFeedbackSubmission,
  ): Promise<OfficialQualityFeedbackSubmissionResult> {
    const principal = this.getPrincipal();
    if (!principal) throw new Error("Aera product sign-in is required.");
    this.purgeExpiredFeedbackCandidates();
    const candidate = this.feedbackCandidates.get(input.eventId);
    if (
      !candidate ||
      candidate.accountId !== principal.accountId ||
      candidate.deviceId !== principal.deviceId
    ) {
      throw new Error("Official quality feedback is no longer eligible.");
    }
    const event = this.collector.collectFeedback(candidate, {
      rating: input.rating,
      reasonCodes: [...input.reasonCodes],
    });
    this.feedbackCandidates.delete(input.eventId);
    if (!event) {
      throw new Error("Official quality feedback is no longer eligible.");
    }
    void this.uploadPending();
    return { accepted: true };
  }

  async setConsent(
    purpose: OfficialQualityPurpose,
    enabled: boolean,
  ): Promise<OfficialQualityConsentReceipt> {
    const principal = this.getPrincipal();
    if (!principal) {
      throw new Error("Aera product sign-in is required.");
    }
    const receipt = this.database.setConsent(
      principal.accountId,
      principal.deviceId,
      purpose,
      enabled,
      this.now(),
    );
    if (!enabled) {
      this.database.purgePurpose(
        principal.accountId,
        principal.deviceId,
        purpose,
      );
      if (purpose === "official_explicit_feedback") {
        this.purgeFeedbackCandidates(principal);
      }
    }
    try {
      await this.client.setConsent(purpose, enabled, receipt.version);
    } catch {
      // Local consent takes effect immediately; Cloud reconciliation retries.
    }
    if (enabled) void this.uploadPending();
    return receipt;
  }

  notifyPrincipalChanged(next: OfficialQualityPrincipal | null): void {
    const previous = this.previousPrincipal;
    if (
      previous !== null &&
      (next === null || previous.accountId !== next.accountId)
    ) {
      this.database.purgeAccount(previous.accountId);
      this.purgeFeedbackCandidates(previous);
    }
    this.previousPrincipal = next;
    if (next !== null && !samePrincipal(previous, next)) {
      void this.uploadPending();
    }
  }

  uploadPending(): Promise<void> {
    if (this.activeUpload) return this.activeUpload;
    this.activeUpload = this.performUpload().finally(() => {
      this.activeUpload = null;
    });
    return this.activeUpload;
  }

  private purgeFeedbackCandidates(principal: OfficialQualityPrincipal): void {
    for (const [eventId, candidate] of this.feedbackCandidates) {
      if (
        candidate.accountId === principal.accountId &&
        candidate.deviceId === principal.deviceId
      ) {
        this.feedbackCandidates.delete(eventId);
      }
    }
  }

  private purgeExpiredFeedbackCandidates(): void {
    const now = this.now().getTime();
    for (const [eventId, candidate] of this.feedbackCandidates) {
      const preparedAt = new Date(candidate.preparedAt).getTime();
      if (
        !Number.isFinite(preparedAt) ||
        preparedAt > now ||
        now - preparedAt > FEEDBACK_CANDIDATE_TTL_MILLISECONDS
      ) {
        this.feedbackCandidates.delete(eventId);
      }
    }
  }

  private async performUpload(): Promise<void> {
    try {
      const principal = this.getPrincipal();
      if (!principal) return;
      const now = this.now();
      this.database.purgeExpired(now);
      for (const purpose of [
        "official_quality_metrics",
        "official_explicit_feedback",
      ] as const) {
        const receipt = this.database.readConsentReceipt(
          principal.accountId,
          principal.deviceId,
          purpose,
        );
        if (receipt.version < 1) continue;
        try {
          await this.client.setConsent(
            purpose,
            receipt.enabled,
            receipt.version,
          );
        } catch {
          return;
        }
      }
      const entries = this.database.listDue(
        principal.accountId,
        principal.deviceId,
        now,
        UPLOAD_BATCH_SIZE,
      );
      for (const entry of entries) {
        try {
          const receipt = await this.client.uploadEvent(entry.envelopeJson);
          if (receipt.eventId !== entry.eventId) {
            throw new AgenteraOfficialQualityClientError(
              202,
              "invalid_response",
              true,
            );
          }
          this.database.acknowledge(
            principal.accountId,
            principal.deviceId,
            entry.eventId,
          );
        } catch (error) {
          if (
            error instanceof AgenteraOfficialQualityClientError &&
            !error.retryable
          ) {
            this.database.acknowledge(
              principal.accountId,
              principal.deviceId,
              entry.eventId,
            );
            continue;
          }
          this.database.recordRetry(
            principal.accountId,
            principal.deviceId,
            entry.eventId,
            new Date(
              now.getTime() + retryDelay(entry.attemptCount, this.random),
            ),
          );
        }
      }
    } catch {
      // Quality delivery is isolated from conversations and local learning.
    }
  }
}
