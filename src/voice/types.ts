import type { ProviderAlias, OpenClawLogger } from "../shared/types.js";
import type { SpendTracker } from "../observability/costGuard.js";

export const MAX_VOICE_DURATION_SECONDS = 15;

export const VOICE_LATENCY_BUDGET_MS = 8000;

export const TRANSCRIPTION_TIMEOUT_MS = 7000;

export const TRANSCRIPTION_RETRY_DELAY_MS = 500;

export interface TranscriptionConfig {
  baseUrl: string;
  apiKey: string;
  providerAlias: ProviderAlias;
  modelAlias: string;
  languageHint: string;
  maxLatencyMs: number;
}

export interface AudioFileReader {
  (filePath: string): Promise<Uint8Array>;
}

export interface TranscriptionRequest {
  userId: string;
  requestId: string;
  telegramMessageId: string;
  audioFilePath: string;
  durationSeconds: number;
  degradeModeEnabled: boolean;
  logger: OpenClawLogger;
  spendTracker: SpendTracker;
  deleteAudioFile: () => Promise<void>;
  audioFileReader?: AudioFileReader;
}

export interface TranscriptionResult {
  providerAlias: ProviderAlias;
  modelAlias: string;
  transcriptText: string;
  confidence: number | null;
  estimatedCostUsd: number;
  outcome: TranscriptionOutcome;
  audioDeleted: boolean;
  /**
   * Structured error discriminator from the underlying voiceClient.
   * Present when outcome is "provider_failure" or "registry_error".
   * Preserves the voiceClient's typed outcome so downstream observability
   * and diagnostics can distinguish e.g. "API key missing" from "HTTP 500".
   * `undefined` on success / duration_exceeded / budget_blocked.
   */
  error_kind?: TranscriptionErrorKind;
}

export type TranscriptionOutcome =
  | "success"
  | "duration_exceeded"
  | "provider_failure"
  | "budget_blocked"
  | "registry_error"
  | "deletion_failed";

/**
 * Fine-grained error kinds from the voiceClient, carried through the
 * adapter boundary for observability without collapsing to generic
 * "provider_failure".
 */
export type TranscriptionErrorKind =
  | "provider_failure"
  | "registry_error"
  | "stall_detected";

export interface VoiceFailureState {
  consecutiveFailures: number;
}
