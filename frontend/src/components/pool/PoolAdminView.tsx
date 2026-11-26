import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Cpu,
  Eye,
  KeyRound,
  Layers,
  Lock,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  Square,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { adminApi, ApiError, lorasApi, poolApi } from "@/lib/api";
import { cn, formatBytes, formatRelativeTime } from "@/lib/utils";
import {
  ALLOWED_GPU_TIERS,
  sanitizeGpuTiers,
  type AdminUser,
  type AuthUser,
  type ColabAccount,
  type GpuTier,
  type InviteCode,
  type LoraRecord,
  type ReconcileSummary,
  type UserRole,
  type WorkerRecord,
  type WorkerStatus,
} from "@/types/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface PoolAdminViewProps {
  user: AuthUser;
  workers: WorkerRecord[];
  accounts: ColabAccount[];
  loras: LoraRecord[];
  onPoolChanged: () => Promise<void>;
  onLorasChanged: () => Promise<void>;
}

function workerStatusBadge(status: WorkerStatus) {
  switch (status) {
    case "ready":
      return <Badge variant="sage">ready</Badge>;
    case "assigning":
    case "bootstrapping":
      return <Badge variant="ochre">{status}</Badge>;
    case "stopping":
      return <Badge variant="ochre">stopping</Badge>;
    case "stopped":
      return <Badge variant="neutral">stopped</Badge>;
    case "error":
      return <Badge variant="vermilion">error</Badge>;
  }
}

export function PoolAdminView({
  user,
  workers,
  accounts,
  loras,
  onPoolChanged,
  onLorasChanged,
}: PoolAdminViewProps) {
  const isAdmin = user.role === "admin";

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);
  const [reconcileSummary, setReconcileSummary] =
    useState<ReconcileSummary | null>(null);

  // Account onboarding modal state
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [accLabel, setAccLabel] = useState("");
  const [accPriority, setAccPriority] = useState(100);
  const [accMinBalance, setAccMinBalance] = useState(5.0);
  const [accAdcText, setAccAdcText] = useState("");
  const [onboardError, setOnboardError] = useState<string | null>(null);

  // Account edit modal state
  const [editingAccount, setEditingAccount] = useState<ColabAccount | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editPriority, setEditPriority] = useState(100);
  const [editMinBalance, setEditMinBalance] = useState(5.0);
  const [editEnabled, setEditEnabled] = useState(true);
  const [editResetUnsupported, setEditResetUnsupported] = useState(false);

  // Admin: Invites & Users
  const [invites, setInvites] = useState<InviteCode[]>([]);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [userDrafts, setUserDrafts] = useState<
    Record<
      string,
      {
        role: UserRole;
        daily_quota: number;
        max_queued: number;
        allowed_gpus: GpuTier[];
      }
    >
  >({});

  // Create Invite form
  const [inviteMaxUses, setInviteMaxUses] = useState(1);
  const [inviteExpiryHours, setInviteExpiryHours] = useState("");
  const [copiedInvite, setCopiedInvite] = useState<string | null>(null);

  // Create LoRA form
  const [loraName, setLoraName] = useState("");
  const [loraSourceType, setLoraSourceType] = useState<"hf" | "civitai">("hf");
  const [loraSourceUrl, setLoraSourceUrl] = useState("");
  const [loraFilename, setLoraFilename] = useState("");
  const [loraWeight, setLoraWeight] = useState(0.8);
  const [loraTriggers, setLoraTriggers] = useState("");
  const [loraSha256, setLoraSha256] = useState("");

  const loadAdminData = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const [invRes, usrRes] = await Promise.all([
        adminApi.listInvites(),
        adminApi.listUsers(),
      ]);
      setInvites(invRes.invites);
      setAdminUsers(usrRes.users);
      const nextDrafts: typeof userDrafts = {};
      for (const u of usrRes.users) {
        nextDrafts[u.id] = {
          role: u.role,
          daily_quota: u.daily_quota,
          max_queued: u.max_queued,
          allowed_gpus: sanitizeGpuTiers(u.allowed_gpus),
        };
      }
      setUserDrafts(nextDrafts);
    } catch (err) {
      setBannerError(
        err instanceof ApiError ? err.detail : "Failed to load admin records."
      );
    }
  }, [isAdmin]);

  useEffect(() => {
    void loadAdminData();
  }, [loadAdminData]);

  // Strict separation: managed vs external workers
  const managedWorkers = useMemo(
    () => workers.filter((w) => w.origin === "managed"),
    [workers]
  );
  const externalWorkers = useMemo(
    () => workers.filter((w) => w.origin === "external"),
    [workers]
  );

  const handleStopWorker = async (worker: WorkerRecord) => {
    // Hard invariant: NEVER stop external workers
    if (worker.origin !== "managed") return;
    setBannerError(null);
    setBannerSuccess(null);
    setBusyAction(`stop:${worker.id}`);
    try {
      await poolApi.stopWorker(worker.id);
      setBannerSuccess(
        `Emergency stop executed for managed worker ${worker.session_name}.`
      );
      await onPoolChanged();
    } catch (err) {
      setBannerError(
        err instanceof ApiError ? err.detail : "Failed to stop managed worker."
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleRefreshAndReconcile = async () => {
    setBannerError(null);
    setBannerSuccess(null);
    setBusyAction("refresh");
    try {
      const res = await poolApi.refreshAccounts();
      setReconcileSummary(res.reconcile);
      setBannerSuccess("Refreshed account CU balances and reconciled Colab runtimes.");
      await onPoolChanged();
    } catch (err) {
      setBannerError(
        err instanceof ApiError
          ? err.detail
          : "Failed to refresh balances & reconcile."
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleAdcFileUpload = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setAccAdcText(text);
  };

  const handleOnboardAccount = async (e: FormEvent) => {
    e.preventDefault();
    setOnboardError(null);
    if (!accLabel.trim()) {
      setOnboardError("Account label is required.");
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(accAdcText) as Record<string, unknown>;
    } catch {
      setOnboardError("ADC JSON is not valid JSON.");
      return;
    }
    if (parsed.type !== "authorized_user") {
      setOnboardError('ADC JSON must have "type": "authorized_user".');
      return;
    }
    for (const key of ["client_id", "client_secret", "refresh_token"]) {
      if (typeof parsed[key] !== "string" || !(parsed[key] as string).trim()) {
        setOnboardError(`ADC JSON is missing non-empty "${key}".`);
        return;
      }
    }

    setBusyAction("onboard");
    try {
      await poolApi.addAccount({
        label: accLabel.trim(),
        adc_json: parsed,
        priority: accPriority,
        min_balance_cu: accMinBalance,
      });
      setAccLabel("");
      setAccAdcText("");
      setOnboardOpen(false);
      setBannerSuccess("Colab account encrypted and onboarded.");
      await onPoolChanged();
    } catch (err) {
      setOnboardError(
        err instanceof ApiError ? err.detail : "Failed to onboard account."
      );
    } finally {
      setBusyAction(null);
    }
  };

  const openEditAccount = (acc: ColabAccount) => {
    setEditingAccount(acc);
    setEditLabel(acc.label);
    setEditPriority(acc.priority);
    setEditMinBalance(acc.min_balance_cu);
    setEditEnabled(acc.enabled);
    setEditResetUnsupported(false);
  };

  const handleSaveAccount = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingAccount) return;
    setBannerError(null);
    setBusyAction(`edit:${editingAccount.id}`);
    try {
      await poolApi.patchAccount(editingAccount.id, {
        label: editLabel.trim(),
        priority: editPriority,
        min_balance_cu: editMinBalance,
        enabled: editEnabled,
        reset_unsupported_gpus: editResetUnsupported,
      });
      setEditingAccount(null);
      setBannerSuccess("Account settings updated.");
      await onPoolChanged();
    } catch (err) {
      setBannerError(
        err instanceof ApiError ? err.detail : "Failed to update account."
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteAccount = async (accId: string) => {
    setBannerError(null);
    setBusyAction(`del-acc:${accId}`);
    try {
      await poolApi.deleteAccount(accId);
      setBannerSuccess("Colab account removed from pool.");
      await onPoolChanged();
    } catch (err) {
      setBannerError(
        err instanceof ApiError ? err.detail : "Cannot delete account."
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleCreateInvite = async (e: FormEvent) => {
    e.preventDefault();
    setBannerError(null);
    setBusyAction("create-invite");
    try {
      const exp = inviteExpiryHours.trim()
        ? Number(inviteExpiryHours.trim())
        : null;
      await adminApi.createInvite({
        max_uses: inviteMaxUses,
        expires_in_hours: exp,
      });
      setInviteExpiryHours("");
      await loadAdminData();
      setBannerSuccess("Invite code generated.");
    } catch (err) {
      setBannerError(
        err instanceof ApiError ? err.detail : "Failed to create invite."
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleRevokeInvite = async (code: string) => {
    setBannerError(null);
    setBusyAction(`rev-inv:${code}`);
    try {
      await adminApi.revokeInvite(code);
      await loadAdminData();
    } catch (err) {
      setBannerError(
        err instanceof ApiError ? err.detail : "Failed to revoke invite."
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveUser = async (userId: string) => {
    const draft = userDrafts[userId];
    if (!draft) return;
    if (draft.allowed_gpus.length === 0) {
      setBannerError("At least one GPU tier must remain allowed.");
      return;
    }
    setBannerError(null);
    setBannerSuccess(null);
    setBusyAction(`user:${userId}`);
    try {
      await adminApi.patchUser(userId, {
        role: draft.role,
        daily_quota: draft.daily_quota,
        max_queued: draft.max_queued,
        allowed_gpus: draft.allowed_gpus,
      });
      await loadAdminData();
      setBannerSuccess("User permissions and quotas saved.");
    } catch (err) {
      setBannerError(
        err instanceof ApiError ? err.detail : "Failed to update user."
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleCreateLora = async (e: FormEvent) => {
    e.preventDefault();
    setBannerError(null);
    setBannerSuccess(null);
    setBusyAction("create-lora");
    try {
      await lorasApi.create({
        name: loraName.trim(),
        source_type: loraSourceType,
        source_url: loraSourceUrl.trim(),
        filename: loraFilename.trim(),
        default_weight: loraWeight,
        trigger_words: loraTriggers.trim(),
        sha256: loraSha256.trim() ? loraSha256.trim() : null,
      });
      setLoraName("");
      setLoraSourceUrl("");
      setLoraFilename("");
      setLoraTriggers("");
      setLoraSha256("");
      setBannerSuccess("LoRA registered in studio catalog.");
      await onLorasChanged();
    } catch (err) {
      setBannerError(
        err instanceof ApiError ? err.detail : "Failed to register LoRA."
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteLora = async (loraId: string) => {
    setBannerError(null);
    setBusyAction(`del-lora:${loraId}`);
    try {
      await lorasApi.remove(loraId);
      await onLorasChanged();
      setBannerSuccess("LoRA removed.");
    } catch (err) {
      setBannerError(
        err instanceof ApiError ? err.detail : "Failed to remove LoRA."
      );
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="space-y-6">
      {bannerError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-[#E8C9C8] bg-[#FBF0F0] px-4 py-3 text-xs text-[#A84442]"
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{bannerError}</span>
        </div>
      )}

      {bannerSuccess && (
        <div
          role="status"
          className="flex items-start justify-between gap-2 rounded-lg border border-[#C5DFD0] bg-[#EEF6F1] px-4 py-3 text-xs text-[#3D7A5A]"
        >
          <span className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{bannerSuccess}</span>
          </span>
          <button
            type="button"
            onClick={() => setBannerSuccess(null)}
            className="underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {reconcileSummary && (
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-[#CBD7E3] bg-[#EFF3F7] p-3.5 text-xs text-[#3D546B] sm:grid-cols-4">
          <div>
            <span className="block text-[10px] uppercase">Vanished Stopped</span>
            <span className="font-mono font-semibold tabular-nums">
              {reconcileSummary.stopped_count}
            </span>
          </div>
          <div>
            <span className="block text-[10px] uppercase">Orphans Unassigned</span>
            <span className="font-mono font-semibold tabular-nums">
              {reconcileSummary.orphan_cleaned}
            </span>
          </div>
          <div>
            <span className="block text-[10px] uppercase">External Found</span>
            <span className="font-mono font-semibold tabular-nums">
              {reconcileSummary.external_discovered}
            </span>
          </div>
          <div>
            <span className="block text-[10px] uppercase">Stale Jobs Failed</span>
            <span className="font-mono font-semibold tabular-nums">
              {reconcileSummary.failed_stale_jobs}
            </span>
          </div>
        </div>
      )}

      {/* Workers Section: Strictly separated Managed vs External */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Managed Workers */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Server className="h-4 w-4 text-[#4A6580]" />
                  Managed Studio Workers
                </CardTitle>
                <CardDescription>
                  Provisioned on demand by colab-canvas. Protected by 3-layer Cost Guard and Emergency Stop.
                </CardDescription>
              </div>
              <Badge variant="slate" className="font-mono tabular-nums">
                {managedWorkers.length}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {managedWorkers.length === 0 ? (
              <div className="rounded-md border border-dashed border-[#E7E5E0] bg-[#FAF9F6] px-4 py-6 text-center text-xs text-[#78716C]">
                No managed workers recorded. A Colab VM boots automatically when a job is submitted in Studio.
              </div>
            ) : (
              managedWorkers.map((w) => {
                const isActive =
                  w.status === "assigning" ||
                  w.status === "bootstrapping" ||
                  w.status === "ready" ||
                  w.status === "stopping";
                return (
                  <div
                    key={w.id}
                    className="rounded-md border border-[#E7E5E0] bg-[#FAF9F6] p-3.5 space-y-2.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {workerStatusBadge(w.status)}
                        <Badge variant="slate">origin: managed</Badge>
                        <Badge variant="neutral" className="font-mono">
                          {w.gpu_type}
                        </Badge>
                      </div>
                      {isAdmin && (
                        <Button
                          variant="destructiveOutline"
                          size="sm"
                          disabled={!isActive || busyAction === `stop:${w.id}`}
                          onClick={() => void handleStopWorker(w)}
                          className="h-7 px-2.5 text-[11px]"
                        >
                          <Square className="h-3 w-3" />
                          {busyAction === `stop:${w.id}`
                            ? "Stopping..."
                            : "Emergency Stop"}
                        </Button>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                      <div>
                        <span className="text-[#78716C]">Account:</span>{" "}
                        <span className="font-medium text-[#1C1917]">
                          {w.account_label}
                        </span>
                      </div>
                      <div>
                        <span className="text-[#78716C]">Session:</span>{" "}
                        <span className="font-mono text-[#1C1917]">
                          {w.session_name}
                        </span>
                      </div>
                      <div className="truncate">
                        <span className="text-[#78716C]">Endpoint:</span>{" "}
                        <span className="font-mono text-[#44403C]">
                          {w.endpoint}
                        </span>
                      </div>
                      <div>
                        <span className="text-[#78716C]">Cached files:</span>{" "}
                        <span className="font-mono tabular-nums">
                          {w.cached_files.length}
                        </span>
                      </div>
                      <div>
                        <span className="text-[#78716C]">Started:</span>{" "}
                        <span>{formatRelativeTime(w.started_at)}</span>
                      </div>
                      <div>
                        <span className="text-[#78716C]">Heartbeat:</span>{" "}
                        <span>{formatRelativeTime(w.last_heartbeat_at)}</span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        {/* External Workers (Strictly Read-Only) */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Eye className="h-4 w-4 text-[#78716C]" />
                  External Colab Sessions
                </CardTitle>
                <CardDescription>
                  Manually opened notebooks discovered during reconciliation. Read-only visibility; never touched or stopped.
                </CardDescription>
              </div>
              <Badge variant="neutral" className="font-mono tabular-nums">
                {externalWorkers.length}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {externalWorkers.length === 0 ? (
              <div className="rounded-md border border-dashed border-[#E7E5E0] bg-[#FAF9F6] px-4 py-6 text-center text-xs text-[#78716C]">
                No external Colab sessions detected on onboarded accounts.
              </div>
            ) : (
              externalWorkers.map((w) => (
                <div
                  key={w.id}
                  data-worker-origin="external"
                  className="rounded-md border border-[#E7E5E0] bg-[#FFFFFF] p-3.5 space-y-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {workerStatusBadge(w.status)}
                      <Badge variant="ochre">origin: external · read-only</Badge>
                      <Badge variant="neutral" className="font-mono">
                        {w.gpu_type}
                      </Badge>
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span tabIndex={0} className="inline-flex">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled
                            aria-disabled="true"
                            className="h-7 px-2.5 text-[11px] opacity-55 cursor-not-allowed"
                          >
                            <Lock className="h-3 w-3" />
                            Stop Disabled (External)
                          </Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        Read-only session: external Colab notebooks cannot be stopped or unassigned by colab-canvas.
                      </TooltipContent>
                    </Tooltip>
                  </div>

                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                    <div>
                      <span className="text-[#78716C]">Account:</span>{" "}
                      <span className="font-medium text-[#1C1917]">
                        {w.account_label}
                      </span>
                    </div>
                    <div>
                      <span className="text-[#78716C]">Session:</span>{" "}
                      <span className="font-mono text-[#1C1917]">
                        {w.session_name}
                      </span>
                    </div>
                    <div className="truncate col-span-2">
                      <span className="text-[#78716C]">Endpoint:</span>{" "}
                      <span className="font-mono text-[#44403C]">
                        {w.endpoint}
                      </span>
                    </div>
                    <div>
                      <span className="text-[#78716C]">Seen:</span>{" "}
                      <span>{formatRelativeTime(w.last_activity_at)}</span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Account Pool Section */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-[#4A6580]" />
                Colab Account Pool (Rollover Scheduling)
              </CardTitle>
              <CardDescription>
                Accounts rotate sequentially by priority when CU balance falls below the floor. Credentials are Fernet-encrypted and never returned by API.
              </CardDescription>
            </div>
            {isAdmin && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyAction === "refresh"}
                  onClick={() => void handleRefreshAndReconcile()}
                >
                  <RefreshCw
                    className={cn(
                      "h-3.5 w-3.5",
                      busyAction === "refresh" && "animate-spin"
                    )}
                  />
                  Refresh &amp; Reconcile
                </Button>
                <Button size="sm" onClick={() => setOnboardOpen(true)}>
                  <Plus className="h-3.5 w-3.5" />
                  Onboard Account
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {accounts.length === 0 ? (
            <div className="rounded-md border border-dashed border-[#E7E5E0] bg-[#FAF9F6] px-4 py-8 text-center text-xs text-[#78716C]">
              No Colab accounts onboarded yet.{" "}
              {isAdmin
                ? "Click 'Onboard Account' to add an authorized_user ADC JSON credential."
                : "Ask an administrator to onboard paid Colab accounts."}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {accounts.map((acc) => {
                const lowBalance =
                  acc.last_balance_cu !== null &&
                  acc.last_balance_cu < acc.min_balance_cu;
                return (
                  <div
                    key={acc.id}
                    className="flex flex-col justify-between rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] p-4 space-y-3"
                  >
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-[#1C1917]">
                            {acc.label}
                          </div>
                          <div className="truncate text-xs text-[#78716C]">
                            {acc.email}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Badge variant={acc.enabled ? "sage" : "neutral"}>
                            {acc.enabled ? "enabled" : "disabled"}
                          </Badge>
                          <Badge variant="neutral" className="font-mono tabular-nums">
                            P{acc.priority}
                          </Badge>
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-2 rounded-md border border-[#E7E5E0] bg-[#FFFFFF] p-2.5 text-xs">
                        <div>
                          <span className="block text-[10px] text-[#78716C]">
                            Balance
                          </span>
                          <span
                            className={cn(
                              "font-mono font-semibold tabular-nums",
                              lowBalance ? "text-[#A84442]" : "text-[#1C1917]"
                            )}
                          >
                            {acc.last_balance_cu !== null
                              ? `${acc.last_balance_cu.toFixed(1)} CU`
                              : "—"}
                          </span>
                        </div>
                        <div>
                          <span className="block text-[10px] text-[#78716C]">
                            Burn Rate
                          </span>
                          <span className="font-mono font-medium tabular-nums">
                            {acc.last_rate_hr !== null
                              ? `${acc.last_rate_hr.toFixed(2)}/h`
                              : "—"}
                          </span>
                        </div>
                        <div>
                          <span className="block text-[10px] text-[#78716C]">
                            Active VMs
                          </span>
                          <span className="font-mono font-medium tabular-nums">
                            {acc.last_assignments ?? "—"}
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#78716C]">
                        <span className="font-mono tabular-nums">
                          Floor: {acc.min_balance_cu.toFixed(1)} CU
                        </span>
                        <span>
                          Checked: {formatRelativeTime(acc.last_checked_at)}
                        </span>
                      </div>

                      {acc.unsupported_gpus.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1 text-[10px] text-[#9C6D2E]">
                          <span>Unsupported:</span>
                          {acc.unsupported_gpus.map((g) => (
                            <Badge key={g} variant="ochre" className="font-mono">
                              {g}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>

                    {isAdmin && (
                      <div className="flex items-center justify-end gap-2 border-t border-[#E7E5E0] pt-2.5">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openEditAccount(acc)}
                          className="h-7 px-2.5 text-[11px]"
                        >
                          Configure
                        </Button>
                        <Button
                          variant="destructiveOutline"
                          size="sm"
                          disabled={busyAction === `del-acc:${acc.id}`}
                          onClick={() => void handleDeleteAccount(acc.id)}
                          className="h-7 px-2.5 text-[11px]"
                        >
                          <Trash2 className="h-3 w-3" />
                          Remove
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Admin-only sections */}
      {!isAdmin ? (
        <Card className="p-4">
          <div className="flex items-center gap-2.5 text-xs text-[#78716C]">
            <ShieldAlert className="h-4 w-4 text-[#4A6580]" />
            <span>
              Signed in as <strong>member</strong>. LoRA registration, invite codes, user quotas, and worker controls are restricted to administrators.
            </span>
          </div>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* LoRA Registry Management */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Layers className="h-4 w-4 text-[#4A6580]" />
                LoRA Registry (Admin)
              </CardTitle>
              <CardDescription>
                Register verified Hugging Face or Civitai `.safetensors` LoRAs for Studio users.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              <form
                onSubmit={handleCreateLora}
                className="space-y-3 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] p-4 lg:col-span-5"
              >
                <div className="text-xs font-semibold text-[#1C1917]">
                  Register New LoRA
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="space-y-1">
                    <Label htmlFor="lora-name">Display Name</Label>
                    <Input
                      id="lora-name"
                      placeholder="Highres Aesthetic Boost"
                      value={loraName}
                      onChange={(e) => setLoraName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Source Host</Label>
                    <Select
                      value={loraSourceType}
                      onValueChange={(v) =>
                        setLoraSourceType(v as "hf" | "civitai")
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="hf">Hugging Face</SelectItem>
                        <SelectItem value="civitai">Civitai</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="lora-url">Direct HTTPS Download URL</Label>
                  <Input
                    id="lora-url"
                    type="url"
                    placeholder="https://huggingface.co/.../resolve/main/model.safetensors"
                    value={loraSourceUrl}
                    onChange={(e) => setLoraSourceUrl(e.target.value)}
                    required
                  />
                </div>
                <div className="grid grid-cols-3 gap-2.5">
                  <div className="col-span-2 space-y-1">
                    <Label htmlFor="lora-filename">Safe Filename (.safetensors)</Label>
                    <Input
                      id="lora-filename"
                      placeholder="anima-style-v1.safetensors"
                      className="font-mono text-xs"
                      value={loraFilename}
                      onChange={(e) => setLoraFilename(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="lora-weight">Default Weight</Label>
                    <Input
                      id="lora-weight"
                      type="number"
                      min={-2}
                      max={2}
                      step={0.05}
                      value={loraWeight}
                      onChange={(e) => setLoraWeight(Number(e.target.value))}
                      className="font-mono text-xs tabular-nums"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="space-y-1">
                    <Label htmlFor="lora-triggers">Trigger Words</Label>
                    <Input
                      id="lora-triggers"
                      placeholder="optional tags"
                      value={loraTriggers}
                      onChange={(e) => setLoraTriggers(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="lora-sha">SHA256 (optional)</Label>
                    <Input
                      id="lora-sha"
                      placeholder="64-hex chars"
                      className="font-mono text-xs"
                      value={loraSha256}
                      onChange={(e) => setLoraSha256(e.target.value)}
                    />
                  </div>
                </div>
                <Button
                  type="submit"
                  size="sm"
                  disabled={busyAction === "create-lora"}
                  className="w-full"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {busyAction === "create-lora"
                    ? "Registering..."
                    : "Register LoRA"}
                </Button>
              </form>

              <div className="space-y-2 lg:col-span-7">
                {loras.length === 0 ? (
                  <div className="flex h-full min-h-[160px] items-center justify-center rounded-lg border border-dashed border-[#E7E5E0] text-xs text-[#78716C]">
                    No LoRAs registered yet.
                  </div>
                ) : (
                  <div className="divide-y divide-[#E7E5E0] rounded-lg border border-[#E7E5E0]">
                    {loras.map((l) => (
                      <div
                        key={l.id}
                        className="flex items-center justify-between gap-3 px-4 py-3"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-[#1C1917]">
                              {l.name}
                            </span>
                            <Badge variant="slate" className="uppercase text-[10px]">
                              {l.source_type}
                            </Badge>
                            <span className="font-mono text-[11px] text-[#78716C] tabular-nums">
                              w={l.default_weight}
                            </span>
                            {l.size_bytes && (
                              <span className="font-mono text-[10px] text-[#78716C]">
                                {formatBytes(l.size_bytes)}
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 truncate font-mono text-[11px] text-[#44403C]">
                            {l.filename}
                          </div>
                          {l.trigger_words && (
                            <div className="mt-0.5 truncate text-[11px] text-[#78716C]">
                              Triggers: {l.trigger_words}
                            </div>
                          )}
                        </div>
                        <Button
                          variant="destructiveOutline"
                          size="sm"
                          disabled={busyAction === `del-lora:${l.id}`}
                          onClick={() => void handleDeleteLora(l.id)}
                          className="h-7 px-2.5 text-[11px] shrink-0"
                        >
                          <Trash2 className="h-3 w-3" />
                          Delete
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Invite Codes & User Quotas */}
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
            {/* Invite Codes */}
            <Card className="xl:col-span-5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-[#4A6580]" />
                  Invite Codes
                </CardTitle>
                <CardDescription>
                  Issue or revoke local/hybrid member registration codes.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <form
                  onSubmit={handleCreateInvite}
                  className="grid grid-cols-3 gap-2 rounded-md border border-[#E7E5E0] bg-[#FAF9F6] p-3"
                >
                  <div className="space-y-1">
                    <Label htmlFor="inv-uses" className="text-[11px]">
                      Max Uses
                    </Label>
                    <Input
                      id="inv-uses"
                      type="number"
                      min={1}
                      max={100}
                      value={inviteMaxUses}
                      onChange={(e) =>
                        setInviteMaxUses(Number(e.target.value) || 1)
                      }
                      className="h-8 font-mono text-xs tabular-nums"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="inv-exp" className="text-[11px]">
                      TTL (hours)
                    </Label>
                    <Input
                      id="inv-exp"
                      type="number"
                      min={1}
                      max={8760}
                      placeholder="Never"
                      value={inviteExpiryHours}
                      onChange={(e) => setInviteExpiryHours(e.target.value)}
                      className="h-8 font-mono text-xs tabular-nums"
                    />
                  </div>
                  <div className="flex items-end">
                    <Button
                      type="submit"
                      size="sm"
                      disabled={busyAction === "create-invite"}
                      className="h-8 w-full text-xs"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Issue
                    </Button>
                  </div>
                </form>

                <div className="divide-y divide-[#E7E5E0] rounded-md border border-[#E7E5E0]">
                  {invites.length === 0 ? (
                    <div className="px-4 py-6 text-center text-xs text-[#78716C]">
                      No invite codes created yet.
                    </div>
                  ) : (
                    invites.map((inv) => {
                      const disabled = Boolean(inv.disabled);
                      const exhausted = inv.used_count >= inv.max_uses;
                      const expired =
                        Boolean(inv.expires_at) &&
                        Date.parse(inv.expires_at as string) <= Date.now();
                      const active = !disabled && !exhausted && !expired;
                      return (
                        <div
                          key={inv.code}
                          className="flex items-center justify-between gap-2 px-3 py-2.5 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <code className="font-mono font-medium text-[#1C1917]">
                                {inv.code}
                              </code>
                              <button
                                type="button"
                                aria-label="Copy invite code"
                                onClick={() => {
                                  void navigator.clipboard.writeText(inv.code);
                                  setCopiedInvite(inv.code);
                                  window.setTimeout(
                                    () => setCopiedInvite(null),
                                    1400
                                  );
                                }}
                                className="text-[#78716C] hover:text-[#1C1917]"
                              >
                                {copiedInvite === inv.code ? (
                                  <Check className="h-3 w-3 text-[#3D7A5A]" />
                                ) : (
                                  <Copy className="h-3 w-3" />
                                )}
                              </button>
                            </div>
                            <div className="mt-0.5 text-[10px] text-[#78716C] tabular-nums">
                              Uses: {inv.used_count}/{inv.max_uses} ·{" "}
                              {inv.expires_at
                                ? `Expires ${formatRelativeTime(inv.expires_at)}`
                                : "No expiry"}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <Badge
                              variant={
                                active
                                  ? "sage"
                                  : disabled
                                  ? "vermilion"
                                  : "neutral"
                              }
                            >
                              {disabled
                                ? "revoked"
                                : exhausted
                                ? "used"
                                : expired
                                ? "expired"
                                : "active"}
                            </Badge>
                            {!disabled && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busyAction === `rev-inv:${inv.code}`}
                                onClick={() => void handleRevokeInvite(inv.code)}
                                className="h-7 px-2 text-[11px] text-[#A84442]"
                              >
                                Revoke
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </CardContent>
            </Card>

            {/* User Quota & GPU Permissions */}
            <Card className="xl:col-span-7">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-[#4A6580]" />
                  Users &amp; Quotas
                </CardTitle>
                <CardDescription>
                  Manage roles, daily limits (0 = unlimited), queue depth, and allowed BF16 GPU tiers.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {adminUsers.map((u) => {
                  const draft = userDrafts[u.id];
                  if (!draft) return null;
                  return (
                    <div
                      key={u.id}
                      className="rounded-md border border-[#E7E5E0] bg-[#FAF9F6] p-3.5 space-y-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-[#1C1917]">
                              {u.username}
                            </span>
                            {u.id === user.id && (
                              <Badge variant="sakura" className="text-[10px]">
                                you
                              </Badge>
                            )}
                          </div>
                          <div className="text-[11px] text-[#78716C]">
                            {u.email}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyAction === `user:${u.id}`}
                          onClick={() => void handleSaveUser(u.id)}
                          className="h-7 px-3 text-xs"
                        >
                          {busyAction === `user:${u.id}` ? "Saving..." : "Save"}
                        </Button>
                      </div>

                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <div className="space-y-1">
                          <Label className="text-[10px] text-[#78716C]">
                            Role
                          </Label>
                          <Select
                            value={draft.role}
                            onValueChange={(val) =>
                              setUserDrafts((prev) => ({
                                ...prev,
                                [u.id]: {
                                  ...prev[u.id],
                                  role: val as UserRole,
                                },
                              }))
                            }
                          >
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="member">member</SelectItem>
                              <SelectItem value="admin">admin</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-1">
                          <Label className="text-[10px] text-[#78716C]">
                            Daily Quota (0=∞)
                          </Label>
                          <Input
                            type="number"
                            min={0}
                            max={10000}
                            value={draft.daily_quota}
                            onChange={(e) =>
                              setUserDrafts((prev) => ({
                                ...prev,
                                [u.id]: {
                                  ...prev[u.id],
                                  daily_quota: Number(e.target.value) || 0,
                                },
                              }))
                            }
                            className="h-8 font-mono text-xs tabular-nums"
                          />
                        </div>

                        <div className="space-y-1">
                          <Label className="text-[10px] text-[#78716C]">
                            Max Queued
                          </Label>
                          <Input
                            type="number"
                            min={1}
                            max={20}
                            value={draft.max_queued}
                            onChange={(e) =>
                              setUserDrafts((prev) => ({
                                ...prev,
                                [u.id]: {
                                  ...prev[u.id],
                                  max_queued: Math.max(
                                    1,
                                    Number(e.target.value) || 1
                                  ),
                                },
                              }))
                            }
                            className="h-8 font-mono text-xs tabular-nums"
                          />
                        </div>

                        <div className="space-y-1">
                          <Label className="text-[10px] text-[#78716C]">
                            Allowed GPUs
                          </Label>
                          <div className="flex flex-wrap gap-1 pt-0.5">
                            {ALLOWED_GPU_TIERS.map((tier) => {
                              const checked = draft.allowed_gpus.includes(tier);
                              return (
                                <button
                                  key={tier}
                                  type="button"
                                  onClick={() =>
                                    setUserDrafts((prev) => {
                                      const cur = prev[u.id].allowed_gpus;
                                      const next = checked
                                        ? cur.filter((g) => g !== tier)
                                        : [...cur, tier];
                                      return {
                                        ...prev,
                                        [u.id]: {
                                          ...prev[u.id],
                                          allowed_gpus: next,
                                        },
                                      };
                                    })
                                  }
                                  className={cn(
                                    "rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium transition-colors",
                                    checked
                                      ? "border-[#4A6580] bg-[#EFF3F7] text-[#3D546B]"
                                      : "border-[#E7E5E0] bg-[#FFFFFF] text-[#78716C]"
                                  )}
                                >
                                  {tier}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* Account Onboard Dialog */}
      <Dialog open={onboardOpen} onOpenChange={setOnboardOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Onboard Paid Colab Account</DialogTitle>
            <DialogDescription>
              Provide an authorized_user ADC JSON credential. It is verified via Google OAuth &amp; Colab CCU API and stored Fernet-encrypted.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleOnboardAccount} className="space-y-4 p-5">
            {onboardError && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-[#E8C9C8] bg-[#FBF0F0] px-3 py-2 text-xs text-[#A84442]"
              >
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{onboardError}</span>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="acc-label">Account Label</Label>
              <Input
                id="acc-label"
                placeholder="Primary Colab Pro+"
                value={accLabel}
                onChange={(e) => setAccLabel(e.target.value)}
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="acc-prio">Priority (lower runs first)</Label>
                <Input
                  id="acc-prio"
                  type="number"
                  min={1}
                  max={1000}
                  value={accPriority}
                  onChange={(e) => setAccPriority(Number(e.target.value) || 100)}
                  className="font-mono tabular-nums"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="acc-floor">Min Balance Floor (CU)</Label>
                <Input
                  id="acc-floor"
                  type="number"
                  min={0}
                  max={10000}
                  step={0.5}
                  value={accMinBalance}
                  onChange={(e) => setAccMinBalance(Number(e.target.value) || 0)}
                  className="font-mono tabular-nums"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="acc-adc">ADC JSON Payload</Label>
                <label className="inline-flex cursor-pointer items-center gap-1 text-[11px] font-medium text-[#4A6580] hover:underline">
                  <Upload className="h-3 w-3" />
                  Load .json file
                  <input
                    type="file"
                    accept=".json,application/json"
                    className="sr-only"
                    onChange={(e) => void handleAdcFileUpload(e.target.files?.[0])}
                  />
                </label>
              </div>
              <Textarea
                id="acc-adc"
                rows={6}
                placeholder='{"type": "authorized_user", "client_id": "...", "client_secret": "...", "refresh_token": "..."}'
                value={accAdcText}
                onChange={(e) => setAccAdcText(e.target.value)}
                className="font-mono text-xs"
                required
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOnboardOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busyAction === "onboard"}>
                {busyAction === "onboard" ? "Verifying & Encrypting..." : "Onboard Account"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Account Edit Dialog */}
      <Dialog
        open={editingAccount !== null}
        onOpenChange={(open) => !open && setEditingAccount(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Configure Account</DialogTitle>
            <DialogDescription>
              {editingAccount?.email}
            </DialogDescription>
          </DialogHeader>
          {editingAccount && (
            <form onSubmit={handleSaveAccount} className="space-y-4 p-5">
              <div className="space-y-1.5">
                <Label htmlFor="edit-acc-label">Label</Label>
                <Input
                  id="edit-acc-label"
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="edit-acc-prio">Priority</Label>
                  <Input
                    id="edit-acc-prio"
                    type="number"
                    min={1}
                    max={1000}
                    value={editPriority}
                    onChange={(e) =>
                      setEditPriority(Number(e.target.value) || 100)
                    }
                    className="font-mono tabular-nums"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-acc-floor">Min Balance (CU)</Label>
                  <Input
                    id="edit-acc-floor"
                    type="number"
                    min={0}
                    max={10000}
                    step={0.5}
                    value={editMinBalance}
                    onChange={(e) =>
                      setEditMinBalance(Number(e.target.value) || 0)
                    }
                    className="font-mono tabular-nums"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between rounded-md border border-[#E7E5E0] bg-[#FAF9F6] px-3 py-2">
                <Label htmlFor="edit-acc-enabled" className="cursor-pointer">
                  Account enabled for scheduling
                </Label>
                <Switch
                  id="edit-acc-enabled"
                  checked={editEnabled}
                  onCheckedChange={setEditEnabled}
                />
              </div>
              {editingAccount.unsupported_gpus.length > 0 && (
                <div className="flex items-center justify-between rounded-md border border-[#E8D7B8] bg-[#FBF5EA] px-3 py-2">
                  <Label htmlFor="edit-acc-reset" className="cursor-pointer text-[#9C6D2E]">
                    Clear unsupported GPU flags ({editingAccount.unsupported_gpus.join(", ")})
                  </Label>
                  <Switch
                    id="edit-acc-reset"
                    checked={editResetUnsupported}
                    onCheckedChange={setEditResetUnsupported}
                  />
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditingAccount(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={busyAction === `edit:${editingAccount.id}`}
                >
                  Save Settings
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
