import type {
  OfficialQualityConsentReceipt,
  OfficialQualityPurpose,
  OfficialQualityEnvelope,
} from "../../shared/agentera-official-quality";
import type {
  CollectOfficialQualityMetricInput,
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

  constructor(options: AgenteraOfficialQualityManagerOptions) {
    if (
      !options?.database ||
      !options.client ||
      !options.collector ||
      typeof options.getPrincipal !== "function"
    ) {
      throw new Error(
        "Invalid AgentEra official quality manager configuration.",
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
  ): OfficialQualityEnvelope | null {
    const event = this.collector.collectMetric(input);
    if (event) {
      void this.uploadPending();
    }
    return event;
  }

  async setConsent(
    purpose: OfficialQualityPurpose,
    enabled: boolean,
  ): Promise<OfficialQualityConsentReceipt> {
    const principal = this.getPrincipal();
    if (!principal) {
      throw new Error("AgentEra product sign-in is required.");
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
