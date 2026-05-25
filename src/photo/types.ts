import type { ProviderAlias, OpenClawLogger, KBJUValues } from "../shared/types.js";
import type { SpendTracker } from "../observability/costGuard.js";

export const LOW_CONFIDENCE_THRESHOLD = 0.70;

export const LOW_CONFIDENCE_LABEL_RU = "низкая уверенность";

export const VISION_MODEL_ALIAS = "qwen3-vl-30b-a3b-instruct";

export const VISION_TIMEOUT_MS = 15000;

export const VISION_RETRY_DELAY_MS = 500;

export const VISION_LATENCY_BUDGET_MS = 12000;

export interface PhotoRecognitionConfig {
  /** Registry call-type alias (ADR-024@0.1.0) for photo recognition */
  call_type: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxLatencyMs: number;
}

export interface ImageFileReader {
  (filePath: string): Promise<Buffer>;
}

export interface PhotoRecognitionRequest {
  userId: string;
  requestId: string;
  photoFilePath: string;
  degradeModeEnabled: boolean;
  logger: OpenClawLogger;
  spendTracker: SpendTracker;
  deletePhotoFile: () => Promise<void>;
  imageFileReader?: ImageFileReader;
}

export interface PhotoItemCandidate {
  itemNameRu: string;
  portionTextRu: string;
  portionGrams: number | null;
  caloriesKcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  confidence01: number;
}

export interface PhotoRecognitionResult {
  providerAlias: ProviderAlias;
  modelAlias: string;
  items: PhotoItemCandidate[];
  totalKBJU: KBJUValues;
  confidence01: number;
  lowConfidenceLabelShown: boolean;
  needsUserConfirmation: boolean;
  estimatedCostUsd: number;
  outcome: PhotoRecognitionOutcome;
  photoDeleted: boolean;
  transientFailure: boolean;
}

export type PhotoRecognitionOutcome =
  | "success"
  | "no_photo_path"
  | "provider_failure"
  | "budget_blocked"
  | "validation_blocked"
  | "deletion_failed";

export interface VisionStructuredResponse {
  items: VisionResponseItem[];
  confidence_0_1: number;
  needs_user_confirmation: boolean;
}

export interface VisionResponseItem {
  item_name_ru: string;
  portion_text_ru: string;
  portion_grams: number | null;
  calories_kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  confidence_0_1: number;
}
