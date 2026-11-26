import type {
  AddAccountRequest,
  AdminUser,
  AuthMeResponse,
  AuthStatusResponse,
  AuthUser,
  ColabAccount,
  CreateInviteRequest,
  CreateJobRequest,
  CreateLoraRequest,
  ImageListResponse,
  ImageRecord,
  InviteCode,
  JobRecord,
  JobStatus,
  LoginRequest,
  LoraRecord,
  PatchAccountRequest,
  PatchUserRequest,
  ReconcileSummary,
  RegisterRequest,
  SetupRequest,
  WorkerRecord,
  WorkflowManifest,
} from "@/types/api";

export class ApiError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

function extractErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim()) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.trim()) {
      return detail;
    }
    if (Array.isArray(detail) && detail.length > 0) {
      const parts = detail.map((item) => {
        if (item && typeof item === "object") {
          const loc = Array.isArray((item as { loc?: unknown }).loc)
            ? (item as { loc: unknown[] }).loc.slice(1).join(".")
            : "";
          const msg = (item as { msg?: unknown }).msg;
          if (typeof msg === "string") {
            return loc ? `${loc}: ${msg}` : msg;
          }
        }
        return JSON.stringify(item);
      });
      return parts.join("; ");
    }
  }
  return fallback;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const resp = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });

  const text = await resp.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!resp.ok) {
    throw new ApiError(
      resp.status,
      extractErrorMessage(parsed, `Request failed with HTTP ${resp.status}`)
    );
  }

  return parsed as T;
}

export const authApi = {
  status: () => apiFetch<AuthStatusResponse>("/api/auth/status"),
  me: () => apiFetch<AuthMeResponse>("/api/auth/me"),
  setup: (body: SetupRequest) =>
    apiFetch<{ user: AuthUser }>("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  login: (body: LoginRequest) =>
    apiFetch<{ user: AuthUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  register: (body: RegisterRequest) =>
    apiFetch<{ user: AuthUser }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  logout: () =>
    apiFetch<{ ok: boolean }>("/api/auth/logout", {
      method: "POST",
    }),
};

export const workflowsApi = {
  list: () => apiFetch<{ workflows: WorkflowManifest[] }>("/api/workflows"),
};

export const lorasApi = {
  list: () => apiFetch<{ loras: LoraRecord[] }>("/api/loras"),
  create: (body: CreateLoraRequest) =>
    apiFetch<{ lora: LoraRecord }>("/api/loras", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  remove: (loraId: string) =>
    apiFetch<{ ok: boolean }>(`/api/loras/${encodeURIComponent(loraId)}`, {
      method: "DELETE",
    }),
};

export const jobsApi = {
  submit: (body: CreateJobRequest) =>
    apiFetch<{ job: JobRecord }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  list: (params?: {
    mine?: boolean;
    status?: JobStatus;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.mine !== undefined) qs.set("mine", String(params.mine));
    if (params?.status) qs.set("status", params.status);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    const q = qs.toString();
    return apiFetch<{ jobs: JobRecord[] }>(`/api/jobs${q ? `?${q}` : ""}`);
  },
  get: (jobId: string) =>
    apiFetch<{ job: JobRecord }>(`/api/jobs/${encodeURIComponent(jobId)}`),
  cancel: (jobId: string) =>
    apiFetch<{ job: JobRecord }>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
    }),
};

export const imagesApi = {
  list: (params?: {
    limit?: number;
    offset?: number;
    mine?: boolean;
    variant?: string;
    favorite?: boolean;
  }) => {
    const qs = new URLSearchParams();
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    if (params?.mine !== undefined) qs.set("mine", String(params.mine));
    if (params?.variant) qs.set("variant", params.variant);
    if (params?.favorite !== undefined) qs.set("favorite", String(params.favorite));
    const q = qs.toString();
    return apiFetch<ImageListResponse>(`/api/images${q ? `?${q}` : ""}`);
  },
  setFavorite: (imageId: string, isFavorite: boolean) =>
    apiFetch<{ image: ImageRecord }>(`/api/images/${encodeURIComponent(imageId)}`, {
      method: "PATCH",
      body: JSON.stringify({ is_favorite: isFavorite }),
    }),
  remove: (imageId: string) =>
    apiFetch<{ ok: boolean }>(`/api/images/${encodeURIComponent(imageId)}`, {
      method: "DELETE",
    }),
};

export const poolApi = {
  listAccounts: () => apiFetch<{ accounts: ColabAccount[] }>("/api/pool/accounts"),
  addAccount: (body: AddAccountRequest) =>
    apiFetch<{ account: ColabAccount }>("/api/pool/accounts", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patchAccount: (accountId: string, body: PatchAccountRequest) =>
    apiFetch<{ account: ColabAccount }>(
      `/api/pool/accounts/${encodeURIComponent(accountId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      }
    ),
  deleteAccount: (accountId: string) =>
    apiFetch<{ ok: boolean }>(`/api/pool/accounts/${encodeURIComponent(accountId)}`, {
      method: "DELETE",
    }),
  refreshAccounts: () =>
    apiFetch<{ accounts: ColabAccount[]; reconcile: ReconcileSummary }>(
      "/api/pool/accounts/refresh",
      { method: "POST" }
    ),
  listWorkers: () => apiFetch<{ workers: WorkerRecord[] }>("/api/pool/workers"),
  stopWorker: (workerId: string) =>
    apiFetch<{ worker: WorkerRecord }>(
      `/api/pool/workers/${encodeURIComponent(workerId)}/stop`,
      { method: "POST" }
    ),
};

export const adminApi = {
  listInvites: () => apiFetch<{ invites: InviteCode[] }>("/api/admin/invites"),
  createInvite: (body: CreateInviteRequest) =>
    apiFetch<{ invite: InviteCode }>("/api/admin/invites", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revokeInvite: (code: string) =>
    apiFetch<{ ok: boolean }>(`/api/admin/invites/${encodeURIComponent(code)}`, {
      method: "DELETE",
    }),
  listUsers: () => apiFetch<{ users: AdminUser[] }>("/api/admin/users"),
  patchUser: (userId: string, body: PatchUserRequest) =>
    apiFetch<{ user: AdminUser }>(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
};
