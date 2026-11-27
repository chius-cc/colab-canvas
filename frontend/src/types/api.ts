export type AuthMode = "hybrid" | "cloudflare" | "local";
export type UserRole = "admin" | "member";
export type GpuTier = "L4" | "A100" | "G4";

export const ALLOWED_GPU_TIERS: readonly GpuTier[] = ["L4", "A100", "G4"] as const;

export const GPU_TIER_META: Record<
  GpuTier,
  { label: string; vram: string }
> = {
  L4: {
    label: "NVIDIA L4",
    vram: "24 GB",
  },
  A100: {
    label: "NVIDIA A100",
    vram: "40/80 GB",
  },
  G4: {
    label: "NVIDIA G4",
    vram: "24+ GB",
  },
};

export function sanitizeGpuTiers(gpus: readonly string[] | undefined): GpuTier[] {
  if (!gpus) return ["L4"];
  const filtered: GpuTier[] = [];
  for (const raw of gpus) {
    const upper = raw.trim().toUpperCase();
    if (
      (upper === "L4" || upper === "A100" || upper === "G4") &&
      !filtered.includes(upper)
    ) {
      filtered.push(upper);
    }
  }
  return filtered.length > 0 ? filtered : ["L4"];
}

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  role: UserRole;
  daily_quota: number;
  used_today: number;
  max_queued: number;
  active_queued: number;
  allowed_gpus: GpuTier[];
  has_password?: boolean;
  created_at: string;
}

export interface AdminUser {
  id: string;
  email: string;
  username: string;
  role: UserRole;
  daily_quota: number;
  max_queued: number;
  allowed_gpus: GpuTier[];
  has_password?: boolean;
  created_at: string;
}

export interface AuthStatusResponse {
  auth_mode: AuthMode;
  needs_setup: boolean;
}

export interface AuthMeResponse {
  auth_mode: AuthMode;
  user: AuthUser;
}

export interface SetupRequest {
  email: string;
  username: string;
  password: string;
}

export interface LoginRequest {
  identifier: string;
  password: string;
}

export interface RegisterRequest {
  invite_code: string;
  email: string;
  username: string;
  password: string;
}

export interface WeightSpec {
  repo_id: string;
  repo_path: string;
  target_path: string;
  sha256: string;
  size_bytes: number;
}

export interface VariantDefaults {
  steps: number;
  cfg: number;
  sampler_name: string;
  scheduler: string;
  positive_prefix: string;
  negative_prompt: string;
}

export interface VariantSpec {
  label: string;
  description: string;
  admin_only: boolean;
  weight: WeightSpec;
  defaults: VariantDefaults;
}

export interface ResolutionPreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

export interface ParamBounds {
  min_dimension: number;
  max_dimension: number;
  dimension_step: number;
  min_steps: number;
  max_steps: number;
  min_cfg: number;
  max_cfg: number;
  max_batch_size: number;
  allowed_samplers: string[];
  allowed_schedulers: string[];
}

export interface WorkflowManifest {
  id: string;
  name: string;
  description: string;
  comfyui_commit: string;
  default_gpu: string;
  prompt_hint: string;
  supports_loras: boolean;
  max_loras: number;
  shared_weights: WeightSpec[];
  default_variant: string;
  variants: Record<string, VariantSpec>;
  resolution_presets: ResolutionPreset[];
  bounds: ParamBounds;
}

export interface LoraRecord {
  id: string;
  name: string;
  source_type: "hf" | "civitai";
  source_url: string;
  filename: string;
  sha256: string | null;
  size_bytes: number | null;
  default_weight: number;
  trigger_words: string;
  created_by: string;
  created_at: string;
}

export interface CreateLoraRequest {
  name: string;
  source_type: "hf" | "civitai";
  source_url: string;
  filename: string;
  sha256?: string | null;
  size_bytes?: number | null;
  default_weight?: number;
  trigger_words?: string;
}

export interface LoraInput {
  id: string;
  strength: number;
}

export interface StoredLoraMeta {
  id: string;
  name: string;
  filename: string;
  strength: number;
}

export type JobStatus =
  | "queued"
  | "booting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobParams {
  prompt: string;
  negative_prompt?: string | null;
  width: number;
  height: number;
  batch_size: number;
  steps?: number | null;
  cfg?: number | null;
  sampler_name?: string | null;
  scheduler?: string | null;
  seed: number;
  loras?: StoredLoraMeta[];
  gpu_type: string;
  is_admin?: boolean;
}

export interface CreateJobRequest {
  workflow_id: string;
  variant: string;
  prompt: string;
  negative_prompt?: string | null;
  width: number;
  height: number;
  batch_size: number;
  steps?: number | null;
  cfg?: number | null;
  sampler_name?: string | null;
  scheduler?: string | null;
  seed?: number | null;
  lora_ids: LoraInput[];
  gpu_type: GpuTier;
}

export interface JobRecord {
  id: string;
  user_id: string;
  username: string;
  worker_id: string | null;
  workflow_id: string;
  variant: string;
  params: JobParams;
  status: JobStatus;
  stage?: string | null;
  stage_detail?: string | null;
  comfy_prompt_id: string | null;
  progress: number;
  error_msg: string | null;
  image_ids: string[];
  created_at: string;
  finished_at: string | null;
}

export type UploadState = "pending" | "uploaded" | "failed";

export interface ImageRecord {
  id: string;
  job_id: string | null;
  user_id: string;
  username: string;
  workflow_id: string;
  variant: string;
  thumb_url: string;
  original_url: string;
  upload_state: UploadState;
  upload_attempts: number;
  upload_error: string | null;
  storage_backend: string;
  width: number;
  height: number;
  seed: number;
  meta: JobParams;
  is_favorite: boolean;
  created_at: string;
}

export interface ImageListResponse {
  total: number;
  limit: number;
  offset: number;
  images: ImageRecord[];
}

export interface ColabAccount {
  id: string;
  label: string;
  email: string;
  priority: number;
  min_balance_cu: number;
  unsupported_gpus: string[];
  last_balance_cu: number | null;
  last_rate_hr: number | null;
  last_assignments: number | null;
  enabled: boolean;
  last_checked_at: string | null;
  created_at: string;
}

export interface AddAccountRequest {
  label: string;
  adc_json: Record<string, unknown>;
  priority: number;
  min_balance_cu: number;
}

export interface PatchAccountRequest {
  label?: string;
  priority?: number;
  min_balance_cu?: number;
  enabled?: boolean;
  reset_unsupported_gpus?: boolean;
}

export type WorkerOrigin = "managed" | "external";
export type WorkerStatus =
  | "assigning"
  | "bootstrapping"
  | "ready"
  | "stopping"
  | "stopped"
  | "error";

export interface WorkerRecord {
  id: string;
  account_id: string;
  account_label: string;
  endpoint: string;
  session_name: string;
  origin: WorkerOrigin;
  gpu_type: string;
  status: WorkerStatus;
  comfy_port: number | null;
  watchdog_port: number | null;
  cached_files: string[];
  started_at: string;
  last_heartbeat_at: string | null;
  last_activity_at: string | null;
  stopped_at: string | null;
}

export interface ReconcileSummary {
  stopped_count: number;
  orphan_cleaned: number;
  external_discovered: number;
  failed_stale_jobs: number;
}

export interface InviteCode {
  code: string;
  created_by: string;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  disabled: number | boolean;
  created_at: string;
}

export interface CreateInviteRequest {
  max_uses: number;
  expires_in_hours?: number | null;
}

export interface PatchUserRequest {
  role?: UserRole;
  daily_quota?: number;
  max_queued?: number;
  allowed_gpus?: GpuTier[];
}

export interface StudioDraft {
  workflow_id?: string;
  variant?: string;
  prompt: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  sampler_name?: string;
  scheduler?: string;
  seed?: number | null;
  loras?: Array<{ id?: string; filename?: string; name?: string; strength: number }>;
  gpu_type?: string;
  sourceLabel?: string;
}

export interface StudioContextSnapshot {
  workflow_id: string;
  variant: string;
  prompt: string;
  negative_prompt: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler_name: string;
  scheduler: string;
  batch_size: number;
  gpu_type: GpuTier;
  loras: LoraInput[];
}

export type SseConnectionState = "connecting" | "live" | "reconnecting" | "offline";

export interface JobUpdatedEvent {
  job_id: string;
  status: JobStatus;
  progress?: number;
  stage?: string | null;
  stage_detail?: string | null;
  image_ids?: string[];
  error?: string;
}

export interface WorkerUpdatedEvent {
  worker_id: string;
  status: WorkerStatus;
  gpu_type?: string;
  reason?: string;
}

export interface PoolUpdatedEvent {
  reason: string;
  stopped_count?: number;
  orphan_cleaned?: number;
  external_discovered?: number;
  failed_stale_jobs?: number;
}

export interface PoolGpuUnavailableEvent {
  gpu_type: string;
  job_id: string;
}

export interface ImageCreatedEvent {
  image_id: string;
  job_id: string | null;
  workflow_id: string;
  variant: string;
  width: number;
  height: number;
  upload_state: UploadState;
}

export interface ImageUploadedEvent {
  image_id: string;
  storage_backend: string;
}

export interface ImageUploadFailedEvent {
  image_id: string;
  error: string;
}

// Assistant / Copilot API types
export interface AssistantStatusResponse {
  enabled: boolean;
  configured: boolean;
  model: string | null;
}

export interface AssistantConfig {
  enabled: boolean;
  base_url: string;
  has_api_key: boolean;
  api_key_masked: string | null;
  model: string;
  system_prompt: string;
  temperature: number;
  max_tokens: number;
  updated_at: string | null;
}

export interface UpdateAssistantConfigRequest {
  enabled: boolean;
  base_url: string;
  api_key?: string;
  clear_api_key?: boolean;
  model: string;
  system_prompt?: string;
  temperature?: number;
  max_tokens?: number;
}

export interface FetchAssistantModelsRequest {
  base_url?: string;
  api_key?: string;
  clear_api_key?: boolean;
}

export type FetchAssistantModelsResponse =
  | { ok: true; latency_ms: number; models: string[] }
  | { ok: false; status_code: number | null; error: string };

export type AssistantChatMode = "chat" | "polish" | "variations" | "diagnose";

export interface AssistantChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantChatRequest {
  messages: AssistantChatMessage[];
  locale: "zh" | "en";
  mode: AssistantChatMode;
  studio_context?: Record<string, unknown> | null;
}

export interface CanvasRecipe {
  title?: string;
  prompt: string;
  negative_prompt?: string;
  variant?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  loras?: Array<{ id: string; strength?: number }>;
}

export interface ChatThreadMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  error?: string;
  streaming?: boolean;
  generatedJobs?: Record<number, string>;
}
