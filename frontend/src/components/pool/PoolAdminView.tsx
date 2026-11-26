import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  Copy,
  Cpu,
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
import { interpolate, useI18n } from "@/i18n";
import { adminApi, ApiError, assistantApi, lorasApi, poolApi } from "@/lib/api";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type ConsoleTab = "compute" | "assistant" | "loras" | "access";

interface PoolAdminViewProps {
  user: AuthUser;
  workers: WorkerRecord[];
  accounts: ColabAccount[];
  loras: LoraRecord[];
  activeTab: ConsoleTab;
  onTabChange: (tab: ConsoleTab) => void;
  onPoolChanged: () => Promise<void>;
  onLorasChanged: () => Promise<void>;
  onAssistantConfigSaved: () => Promise<void>;
}

export function PoolAdminView({
  user,
  workers,
  accounts,
  loras,
  activeTab,
  onTabChange,
  onPoolChanged,
  onLorasChanged,
  onAssistantConfigSaved,
}: PoolAdminViewProps) {
  const { dict } = useI18n();
  const isAdmin = user.role === "admin";

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);
  const [reconcileSummary, setReconcileSummary] =
    useState<ReconcileSummary | null>(null);

  // Account onboarding dialog
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [accLabel, setAccLabel] = useState("");
  const [accPriority, setAccPriority] = useState(100);
  const [accMinBalance, setAccMinBalance] = useState(5.0);
  const [accAdcText, setAccAdcText] = useState("");
  const [onboardError, setOnboardError] = useState<string | null>(null);

  // Account edit dialog
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

  // Admin: AI Assistant configuration
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiBaseUrl, setAiBaseUrl] = useState("");
  const [aiApiKeyInput, setAiApiKeyInput] = useState("");
  const [aiHasKey, setAiHasKey] = useState(false);
  const [aiMaskedKey, setAiMaskedKey] = useState<string | null>(null);
  const [aiClearKey, setAiClearKey] = useState(false);
  const [aiModel, setAiModel] = useState("");
  const [aiFetchedModels, setAiFetchedModels] = useState<string[]>([]);
  const [aiTemp, setAiTemp] = useState(0.7);
  const [aiMaxTokens, setAiMaxTokens] = useState(1200);
  const [aiSystemPrompt, setAiSystemPrompt] = useState("");
  const [aiTestMessage, setAiTestMessage] = useState<string | null>(null);

  const loadAdminData = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const [invRes, usrRes, cfgRes] = await Promise.all([
        adminApi.listInvites(),
        adminApi.listUsers(),
        assistantApi.getConfig(),
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

      const c = cfgRes.config;
      setAiEnabled(c.enabled);
      setAiBaseUrl(c.base_url);
      setAiHasKey(c.has_api_key);
      setAiMaskedKey(c.api_key_masked);
      setAiClearKey(false);
      setAiApiKeyInput("");
      setAiModel(c.model);
      setAiTemp(c.temperature);
      setAiMaxTokens(c.max_tokens);
      setAiSystemPrompt(c.system_prompt);
    } catch (err) {
      setBannerError(err instanceof ApiError ? err.detail : "Load failed");
    }
  }, [isAdmin]);

  useEffect(() => {
    void loadAdminData();
  }, [loadAdminData]);

  // Keep members on compute tab
  useEffect(() => {
    if (!isAdmin && activeTab !== "compute") {
      onTabChange("compute");
    }
  }, [isAdmin, activeTab, onTabChange]);

  const managedWorkers = useMemo(
    () => workers.filter((w) => w.origin === "managed"),
    [workers]
  );
  const externalWorkers = useMemo(
    () => workers.filter((w) => w.origin === "external"),
    [workers]
  );

  const workerStatusBadge = (status: WorkerStatus) => {
    const label = dict.pool.workerStatus[status];
    switch (status) {
      case "ready":
        return <Badge variant="sage">{label}</Badge>;
      case "assigning":
      case "bootstrapping":
      case "stopping":
        return <Badge variant="ochre">{label}</Badge>;
      case "error":
        return <Badge variant="vermilion">{label}</Badge>;
      default:
        return <Badge variant="neutral">{label}</Badge>;
    }
  };

  const handleStopWorker = async (worker: WorkerRecord) => {
    if (worker.origin !== "managed") return;
    setBannerError(null);
    setBannerSuccess(null);
    setBusyAction(`stop:${worker.id}`);
    try {
      await poolApi.stopWorker(worker.id);
      setBannerSuccess(`${worker.session_name} · ${dict.pool.workerStatus.stopped}`);
      await onPoolChanged();
    } catch (err) {
      setBannerError(err instanceof ApiError ? err.detail : "Stop failed");
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
      await onPoolChanged();
    } catch (err) {
      setBannerError(err instanceof ApiError ? err.detail : "Refresh failed");
    } finally {
      setBusyAction(null);
    }
  };

  const handleAdcFileUpload = async (file: File | undefined) => {
    if (!file) return;
    setAccAdcText(await file.text());
  };

  const handleOnboardAccount = async (e: FormEvent) => {
    e.preventDefault();
    setOnboardError(null);
    if (!accLabel.trim()) {
      setOnboardError("Label required");
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(accAdcText) as Record<string, unknown>;
    } catch {
      setOnboardError("Invalid JSON");
      return;
    }
    if (parsed.type !== "authorized_user") {
      setOnboardError('type !== "authorized_user"');
      return;
    }
    for (const key of ["client_id", "client_secret", "refresh_token"]) {
      if (typeof parsed[key] !== "string" || !(parsed[key] as string).trim()) {
        setOnboardError(`Missing "${key}"`);
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
      await onPoolChanged();
    } catch (err) {
      setOnboardError(err instanceof ApiError ? err.detail : "Onboard failed");
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
      await onPoolChanged();
    } catch (err) {
      setBannerError(err instanceof ApiError ? err.detail : "Update failed");
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteAccount = async (accId: string) => {
    setBannerError(null);
    setBusyAction(`del-acc:${accId}`);
    try {
      await poolApi.deleteAccount(accId);
      await onPoolChanged();
    } catch (err) {
      setBannerError(err instanceof ApiError ? err.detail : "Delete failed");
    } finally {
      setBusyAction(null);
    }
  };

  const handleTestAssistantModels = async () => {
    setBannerError(null);
    setAiTestMessage(null);
    setBusyAction("ai-test");
    try {
      const payload: {
        base_url?: string;
        api_key?: string;
        clear_api_key?: boolean;
      } = {};
      if (aiBaseUrl.trim()) payload.base_url = aiBaseUrl.trim();
      if (aiApiKeyInput.trim()) payload.api_key = aiApiKeyInput.trim();
      if (aiClearKey) payload.clear_api_key = true;

      const res = await assistantApi.fetchModels(payload);
      if (res.ok) {
        setAiFetchedModels(res.models);
        if (!aiModel.trim() && res.models.length > 0) {
          setAiModel(res.models[0]);
        }
        setAiTestMessage(
          interpolate(dict.pool.assistantTestSuccess, {
            ms: res.latency_ms,
            count: res.models.length,
          })
        );
      } else {
        setBannerError(res.error);
      }
    } catch (err) {
      setBannerError(err instanceof ApiError ? err.detail : "Probe failed");
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveAssistantConfig = async (e: FormEvent) => {
    e.preventDefault();
    setBannerError(null);
    setBannerSuccess(null);
    setBusyAction("ai-save");
    try {
      const res = await assistantApi.saveConfig({
        enabled: aiEnabled,
        base_url: aiBaseUrl.trim(),
        api_key: aiApiKeyInput.trim() ? aiApiKeyInput.trim() : undefined,
        clear_api_key: aiClearKey,
        model: aiModel.trim(),
        system_prompt: aiSystemPrompt,
        temperature: aiTemp,
        max_tokens: aiMaxTokens,
      });
      const c = res.config;
      setAiHasKey(c.has_api_key);
      setAiMaskedKey(c.api_key_masked);
      setAiApiKeyInput("");
      setAiClearKey(false);
      setBannerSuccess(dict.pool.assistantSavedMsg);
      await onAssistantConfigSaved();
    } catch (err) {
      setBannerError(err instanceof ApiError ? err.detail : "Save failed");
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
    } catch (err) {
      setBannerError(err instanceof ApiError ? err.detail : "Invite failed");
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
      setBannerError(err instanceof ApiError ? err.detail : "Revoke failed");
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveUser = async (userId: string) => {
    const draft = userDrafts[userId];
    if (!draft) return;
    if (draft.allowed_gpus.length === 0) {
      setBannerError(dict.pool.errNeedOneGpu);
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
      setBannerSuccess(`${userDrafts[userId].role} · ${dict.app.save}`);
    } catch (err) {
      setBannerError(err instanceof ApiError ? err.detail : "Update failed");
    } finally {
      setBusyAction(null);
    }
  };

  const handleCreateLora = async (e: FormEvent) => {
    e.preventDefault();
    setBannerError(null);
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
      await onLorasChanged();
    } catch (err) {
      setBannerError(err instanceof ApiError ? err.detail : "Register failed");
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
    } catch (err) {
      setBannerError(err instanceof ApiError ? err.detail : "Delete failed");
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="space-y-5">
      {bannerError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-[#EBC1BC] bg-[#FDF0EE] px-4 py-2.5 text-xs text-[#B43B2E]"
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{bannerError}</span>
        </div>
      )}

      {bannerSuccess && (
        <div
          role="status"
          className="flex items-center justify-between gap-2 rounded-md border border-[#BBD8C9] bg-[#ECF5F0] px-4 py-2.5 text-xs text-[#2F6F52]"
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
            {dict.app.dismiss}
          </button>
        </div>
      )}

      <Tabs
        value={activeTab}
        onValueChange={(v) => onTabChange(v as ConsoleTab)}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E5E0D6] pb-3">
          <TabsList>
            <TabsTrigger value="compute">
              <Cpu className="h-3.5 w-3.5" />
              {dict.pool.tabs.compute}
            </TabsTrigger>
            {isAdmin && (
              <>
                <TabsTrigger value="assistant">
                  <Bot className="h-3.5 w-3.5" />
                  {dict.pool.tabs.assistant}
                </TabsTrigger>
                <TabsTrigger value="loras">
                  <Layers className="h-3.5 w-3.5" />
                  {dict.pool.tabs.loras}
                </TabsTrigger>
                <TabsTrigger value="access">
                  <Users className="h-3.5 w-3.5" />
                  {dict.pool.tabs.access}
                </TabsTrigger>
              </>
            )}
          </TabsList>

          {!isAdmin && (
            <span className="inline-flex items-center gap-1.5 text-xs text-[#62666F]">
              <ShieldAlert className="h-3.5 w-3.5 text-[#3E5C76]" />
              {dict.pool.memberNotice}
            </span>
          )}
        </div>

        {/* 1. Compute & Accounts */}
        <TabsContent value="compute" className="space-y-6">
          {reconcileSummary && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-[#C8D5E1] bg-[#EFF3F7] p-3 text-xs text-[#3E5C76] sm:grid-cols-4">
              <div>
                <span className="block text-[10px]">
                  {dict.pool.reconcileStopped}
                </span>
                <span className="font-mono font-semibold tabular-nums">
                  {reconcileSummary.stopped_count}
                </span>
              </div>
              <div>
                <span className="block text-[10px]">
                  {dict.pool.reconcileOrphans}
                </span>
                <span className="font-mono font-semibold tabular-nums">
                  {reconcileSummary.orphan_cleaned}
                </span>
              </div>
              <div>
                <span className="block text-[10px]">
                  {dict.pool.reconcileExternal}
                </span>
                <span className="font-mono font-semibold tabular-nums">
                  {reconcileSummary.external_discovered}
                </span>
              </div>
              <div>
                <span className="block text-[10px]">
                  {dict.pool.reconcileStaleJobs}
                </span>
                <span className="font-mono font-semibold tabular-nums">
                  {reconcileSummary.failed_stale_jobs}
                </span>
              </div>
            </div>
          )}

          {/* Workers: Managed vs External Read-Only */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Managed Workers */}
            <section className="rounded-lg border border-[#E5E0D6] bg-[#FFFFFF]">
              <div className="flex items-center justify-between border-b border-[#E5E0D6] px-4 py-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-[#1A1D24]">
                  <Server className="h-4 w-4 text-[#3E5C76]" />
                  {dict.pool.managedWorkers}
                </h2>
                <Badge variant="slate" className="font-mono tabular-nums">
                  {managedWorkers.length}
                </Badge>
              </div>

              {managedWorkers.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-[#62666F]">
                  {dict.pool.noManagedWorkers}
                </div>
              ) : (
                <ul className="divide-y divide-[#E5E0D6]">
                  {managedWorkers.map((w) => {
                    const isActive =
                      w.status === "assigning" ||
                      w.status === "bootstrapping" ||
                      w.status === "ready" ||
                      w.status === "stopping";
                    return (
                      <li key={w.id} className="p-4 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {workerStatusBadge(w.status)}
                            <Badge variant="slate">
                              {dict.pool.originManaged}
                            </Badge>
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
                                ? dict.pool.stopping
                                : dict.pool.emergencyStop}
                            </Button>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-[#4A4E58]">
                          <span>
                            {dict.pool.account}:{" "}
                            <strong className="font-medium text-[#1A1D24]">
                              {w.account_label}
                            </strong>
                          </span>
                          <span>
                            {dict.pool.session}:{" "}
                            <code className="font-mono">{w.session_name}</code>
                          </span>
                          <span className="truncate">
                            {dict.pool.endpoint}:{" "}
                            <code className="font-mono">{w.endpoint}</code>
                          </span>
                          <span>
                            {dict.pool.heartbeat}:{" "}
                            {formatRelativeTime(w.last_heartbeat_at)}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* External Workers (Strictly Read-Only) */}
            <section className="rounded-lg border border-[#E5E0D6] bg-[#FFFFFF]">
              <div className="flex items-center justify-between border-b border-[#E5E0D6] px-4 py-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-[#1A1D24]">
                  <Lock className="h-4 w-4 text-[#8D5B1B]" />
                  {dict.pool.externalWorkers}
                </h2>
                <Badge variant="neutral" className="font-mono tabular-nums">
                  {externalWorkers.length}
                </Badge>
              </div>

              {externalWorkers.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-[#62666F]">
                  {dict.pool.noExternalWorkers}
                </div>
              ) : (
                <ul className="divide-y divide-[#E5E0D6]">
                  {externalWorkers.map((w) => (
                    <li
                      key={w.id}
                      data-worker-origin="external"
                      className="p-4 space-y-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {workerStatusBadge(w.status)}
                          <Badge variant="ochre">
                            {dict.pool.originExternal}
                          </Badge>
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
                                {dict.pool.stopDisabledExternal}
                              </Button>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            {dict.pool.stopExternalTooltip}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-[#4A4E58]">
                        <span>
                          {dict.pool.account}:{" "}
                          <strong className="font-medium text-[#1A1D24]">
                            {w.account_label}
                          </strong>
                        </span>
                        <span>
                          {dict.pool.seen}:{" "}
                          {formatRelativeTime(w.last_activity_at)}
                        </span>
                        <span className="truncate col-span-2">
                          {dict.pool.endpoint}:{" "}
                          <code className="font-mono">{w.endpoint}</code>
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {/* Account Pool */}
          <section className="rounded-lg border border-[#E5E0D6] bg-[#FFFFFF]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E5E0D6] px-4 py-3">
              <h2 className="text-sm font-semibold text-[#1A1D24]">
                {dict.pool.accountsTitle}
              </h2>
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
                    {dict.pool.refreshReconcile}
                  </Button>
                  <Button size="sm" onClick={() => setOnboardOpen(true)}>
                    <Plus className="h-3.5 w-3.5" />
                    {dict.pool.onboardAccount}
                  </Button>
                </div>
              )}
            </div>

            {accounts.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-[#62666F]">
                {dict.pool.noAccounts}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
                {accounts.map((acc) => {
                  const lowBalance =
                    acc.last_balance_cu !== null &&
                    acc.last_balance_cu < acc.min_balance_cu;
                  return (
                    <div
                      key={acc.id}
                      className="flex flex-col justify-between rounded-md border border-[#E5E0D6] bg-[#FAF8F4] p-3.5 space-y-3"
                    >
                      <div className="space-y-2.5">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-[#1A1D24]">
                              {acc.label}
                            </div>
                            <div className="truncate text-xs text-[#62666F]">
                              {acc.email}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Badge variant={acc.enabled ? "sage" : "neutral"}>
                              {acc.enabled
                                ? dict.pool.enabled
                                : dict.pool.disabled}
                            </Badge>
                            <Badge variant="neutral" className="font-mono">
                              P{acc.priority}
                            </Badge>
                          </div>
                        </div>

                        <div className="grid grid-cols-3 gap-2 rounded border border-[#E5E0D6] bg-[#FFFFFF] p-2 text-xs">
                          <div>
                            <span className="block text-[10px] text-[#62666F]">
                              {dict.pool.balance}
                            </span>
                            <span
                              className={cn(
                                "font-mono font-semibold tabular-nums",
                                lowBalance ? "text-[#B43B2E]" : "text-[#1A1D24]"
                              )}
                            >
                              {acc.last_balance_cu !== null
                                ? `${acc.last_balance_cu.toFixed(1)} CU`
                                : "—"}
                            </span>
                          </div>
                          <div>
                            <span className="block text-[10px] text-[#62666F]">
                              {dict.pool.burnRate}
                            </span>
                            <span className="font-mono tabular-nums">
                              {acc.last_rate_hr !== null
                                ? `${acc.last_rate_hr.toFixed(2)}/h`
                                : "—"}
                            </span>
                          </div>
                          <div>
                            <span className="block text-[10px] text-[#62666F]">
                              {dict.pool.activeVms}
                            </span>
                            <span className="font-mono tabular-nums">
                              {acc.last_assignments ?? "—"}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center justify-between text-[11px] text-[#62666F]">
                          <span className="font-mono tabular-nums">
                            {dict.pool.floor} {acc.min_balance_cu.toFixed(1)} CU
                          </span>
                          <span>
                            {dict.pool.checked}:{" "}
                            {formatRelativeTime(acc.last_checked_at)}
                          </span>
                        </div>
                      </div>

                      {isAdmin && (
                        <div className="flex items-center justify-end gap-2 border-t border-[#E5E0D6] pt-2.5">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openEditAccount(acc)}
                            className="h-7 px-2.5 text-[11px]"
                          >
                            {dict.pool.configure}
                          </Button>
                          <Button
                            variant="destructiveOutline"
                            size="sm"
                            disabled={busyAction === `del-acc:${acc.id}`}
                            onClick={() => void handleDeleteAccount(acc.id)}
                            className="h-7 px-2.5 text-[11px]"
                          >
                            <Trash2 className="h-3 w-3" />
                            {dict.pool.remove}
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </TabsContent>

        {/* 2. AI Assistant Settings (Admin) */}
        {isAdmin && (
          <TabsContent value="assistant">
            <form
              onSubmit={handleSaveAssistantConfig}
              className="max-w-2xl rounded-lg border border-[#E5E0D6] bg-[#FFFFFF] p-5 space-y-4"
            >
              <div className="flex items-center justify-between border-b border-[#E5E0D6] pb-3">
                <h2 className="font-display text-base font-semibold text-[#1A1D24]">
                  {dict.pool.assistantTitle}
                </h2>
                <div className="flex items-center gap-2">
                  <Label htmlFor="ai-enable" className="cursor-pointer">
                    {dict.pool.assistantEnable}
                  </Label>
                  <Switch
                    id="ai-enable"
                    checked={aiEnabled}
                    onCheckedChange={setAiEnabled}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ai-base-url">{dict.pool.assistantBaseUrl}</Label>
                <Input
                  id="ai-base-url"
                  type="url"
                  placeholder={dict.pool.assistantBaseUrlHint}
                  value={aiBaseUrl}
                  onChange={(e) => setAiBaseUrl(e.target.value)}
                  className="font-mono text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="ai-api-key">{dict.pool.assistantApiKey}</Label>
                  {aiHasKey && !aiClearKey && (
                    <button
                      type="button"
                      onClick={() => {
                        setAiClearKey(true);
                        setAiApiKeyInput("");
                      }}
                      className="text-[11px] text-[#B43B2E] hover:underline"
                    >
                      {dict.pool.assistantClearKey}
                    </button>
                  )}
                </div>
                <Input
                  id="ai-api-key"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    aiHasKey && !aiClearKey && aiMaskedKey
                      ? interpolate(dict.pool.assistantApiKeySaved, {
                          masked: aiMaskedKey,
                        })
                      : dict.pool.assistantApiKeyPlaceholder
                  }
                  value={aiApiKeyInput}
                  onChange={(e) => {
                    setAiApiKeyInput(e.target.value);
                    if (e.target.value) setAiClearKey(false);
                  }}
                  className="font-mono text-xs"
                />
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busyAction === "ai-test"}
                  onClick={() => void handleTestAssistantModels()}
                >
                  <RefreshCw
                    className={cn(
                      "h-3.5 w-3.5",
                      busyAction === "ai-test" && "animate-spin"
                    )}
                  />
                  {busyAction === "ai-test"
                    ? dict.pool.assistantTesting
                    : dict.pool.assistantTestFetch}
                </Button>
                {aiTestMessage && (
                  <span className="text-xs font-medium text-[#2F6F52]">
                    {aiTestMessage}
                  </span>
                )}
              </div>

              {aiFetchedModels.length > 0 && (
                <div className="space-y-1.5">
                  <Label>{dict.pool.assistantModelSelect}</Label>
                  <Select
                    value={aiFetchedModels.includes(aiModel) ? aiModel : ""}
                    onValueChange={setAiModel}
                  >
                    <SelectTrigger className="font-mono text-xs">
                      <SelectValue
                        placeholder={dict.pool.assistantModelSelect}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {aiFetchedModels.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1.5 sm:col-span-1">
                  <Label htmlFor="ai-model">{dict.pool.assistantModel}</Label>
                  <Input
                    id="ai-model"
                    placeholder="gpt-4o-mini"
                    value={aiModel}
                    onChange={(e) => setAiModel(e.target.value)}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ai-temp">{dict.pool.assistantTemp}</Label>
                  <Input
                    id="ai-temp"
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={aiTemp}
                    onChange={(e) => setAiTemp(Number(e.target.value))}
                    className="font-mono text-xs tabular-nums"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ai-tokens">
                    {dict.pool.assistantMaxTokens}
                  </Label>
                  <Input
                    id="ai-tokens"
                    type="number"
                    min={64}
                    max={8192}
                    step={64}
                    value={aiMaxTokens}
                    onChange={(e) =>
                      setAiMaxTokens(Number(e.target.value) || 1024)
                    }
                    className="font-mono text-xs tabular-nums"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ai-sys">{dict.pool.assistantSystemPrompt}</Label>
                <Textarea
                  id="ai-sys"
                  rows={3}
                  value={aiSystemPrompt}
                  onChange={(e) => setAiSystemPrompt(e.target.value)}
                  className="text-xs"
                />
              </div>

              <div className="flex justify-end pt-1">
                <Button type="submit" disabled={busyAction === "ai-save"}>
                  {busyAction === "ai-save"
                    ? dict.app.saving
                    : dict.pool.assistantSave}
                </Button>
              </div>
            </form>
          </TabsContent>
        )}

        {/* 3. LoRAs (Admin) */}
        {isAdmin && (
          <TabsContent value="loras">
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              <form
                onSubmit={handleCreateLora}
                className="space-y-3 rounded-lg border border-[#E5E0D6] bg-[#FFFFFF] p-4 lg:col-span-5"
              >
                <h2 className="text-sm font-semibold text-[#1A1D24]">
                  {dict.pool.loraFormTitle}
                </h2>
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="space-y-1">
                    <Label htmlFor="lora-name">{dict.pool.loraName}</Label>
                    <Input
                      id="lora-name"
                      value={loraName}
                      onChange={(e) => setLoraName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>{dict.pool.loraSourceHost}</Label>
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
                  <Label htmlFor="lora-url">{dict.pool.loraUrl}</Label>
                  <Input
                    id="lora-url"
                    type="url"
                    placeholder="https://huggingface.co/..."
                    value={loraSourceUrl}
                    onChange={(e) => setLoraSourceUrl(e.target.value)}
                    required
                  />
                </div>
                <div className="grid grid-cols-3 gap-2.5">
                  <div className="col-span-2 space-y-1">
                    <Label htmlFor="lora-filename">
                      {dict.pool.loraFilename}
                    </Label>
                    <Input
                      id="lora-filename"
                      placeholder="style.safetensors"
                      className="font-mono text-xs"
                      value={loraFilename}
                      onChange={(e) => setLoraFilename(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="lora-weight">
                      {dict.pool.loraDefaultWeight}
                    </Label>
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
                    <Label htmlFor="lora-triggers">
                      {dict.pool.loraTriggers}
                    </Label>
                    <Input
                      id="lora-triggers"
                      value={loraTriggers}
                      onChange={(e) => setLoraTriggers(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="lora-sha">{dict.pool.loraSha}</Label>
                    <Input
                      id="lora-sha"
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
                    ? dict.pool.loraSubmitting
                    : dict.pool.loraSubmit}
                </Button>
              </form>

              <div className="rounded-lg border border-[#E5E0D6] bg-[#FFFFFF] lg:col-span-7">
                {loras.length === 0 ? (
                  <div className="px-4 py-12 text-center text-xs text-[#62666F]">
                    {dict.pool.loraEmpty}
                  </div>
                ) : (
                  <ul className="divide-y divide-[#E5E0D6]">
                    {loras.map((l) => (
                      <li
                        key={l.id}
                        className="flex items-center justify-between gap-3 px-4 py-3"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-[#1A1D24]">
                              {l.name}
                            </span>
                            <Badge variant="slate" className="uppercase text-[10px]">
                              {l.source_type}
                            </Badge>
                            <span className="font-mono text-[11px] text-[#62666F] tabular-nums">
                              w={l.default_weight}
                            </span>
                            {l.size_bytes && (
                              <span className="font-mono text-[10px] text-[#62666F]">
                                {formatBytes(l.size_bytes)}
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 truncate font-mono text-[11px] text-[#4A4E58]">
                            {l.filename}
                          </div>
                          {l.trigger_words && (
                            <div className="mt-0.5 truncate text-[11px] text-[#62666F]">
                              {l.trigger_words}
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
                          {dict.app.delete}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </TabsContent>
        )}

        {/* 4. Access: Invites & Users (Admin) */}
        {isAdmin && (
          <TabsContent value="access">
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
              {/* Invites */}
              <section className="rounded-lg border border-[#E5E0D6] bg-[#FFFFFF] p-4 space-y-4 xl:col-span-5">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-[#1A1D24]">
                  <KeyRound className="h-4 w-4 text-[#3E5C76]" />
                  {dict.pool.invitesTitle}
                </h2>

                <form
                  onSubmit={handleCreateInvite}
                  className="grid grid-cols-3 gap-2 rounded-md border border-[#E5E0D6] bg-[#FAF8F4] p-3"
                >
                  <div className="space-y-1">
                    <Label htmlFor="inv-uses" className="text-[11px]">
                      {dict.pool.inviteMaxUses}
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
                      {dict.pool.inviteTtlHours}
                    </Label>
                    <Input
                      id="inv-exp"
                      type="number"
                      min={1}
                      max={8760}
                      placeholder={dict.pool.inviteTtlNever}
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
                      {dict.pool.inviteIssue}
                    </Button>
                  </div>
                </form>

                <ul className="divide-y divide-[#E5E0D6] rounded-md border border-[#E5E0D6]">
                  {invites.length === 0 ? (
                    <li className="px-4 py-6 text-center text-xs text-[#62666F]">
                      {dict.pool.inviteEmpty}
                    </li>
                  ) : (
                    invites.map((inv) => {
                      const disabled = Boolean(inv.disabled);
                      const exhausted = inv.used_count >= inv.max_uses;
                      const expired =
                        Boolean(inv.expires_at) &&
                        Date.parse(inv.expires_at as string) <= Date.now();
                      const active = !disabled && !exhausted && !expired;
                      const statusLabel = disabled
                        ? dict.pool.inviteStatus.revoked
                        : exhausted
                        ? dict.pool.inviteStatus.used
                        : expired
                        ? dict.pool.inviteStatus.expired
                        : dict.pool.inviteStatus.active;
                      return (
                        <li
                          key={inv.code}
                          className="flex items-center justify-between gap-2 px-3 py-2.5 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <code className="font-mono font-medium text-[#1A1D24]">
                                {inv.code}
                              </code>
                              <button
                                type="button"
                                aria-label={dict.app.copy}
                                onClick={() => {
                                  void navigator.clipboard.writeText(inv.code);
                                  setCopiedInvite(inv.code);
                                  window.setTimeout(
                                    () => setCopiedInvite(null),
                                    1400
                                  );
                                }}
                                className="text-[#62666F] hover:text-[#1A1D24]"
                              >
                                {copiedInvite === inv.code ? (
                                  <Check className="h-3 w-3 text-[#2F6F52]" />
                                ) : (
                                  <Copy className="h-3 w-3" />
                                )}
                              </button>
                            </div>
                            <div className="mt-0.5 text-[10px] text-[#62666F] tabular-nums">
                              {interpolate(dict.pool.inviteUses, {
                                used: inv.used_count,
                                max: inv.max_uses,
                              })}{" "}
                              ·{" "}
                              {inv.expires_at
                                ? formatRelativeTime(inv.expires_at)
                                : dict.pool.inviteNoExpiry}
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
                              {statusLabel}
                            </Badge>
                            {!disabled && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busyAction === `rev-inv:${inv.code}`}
                                onClick={() => void handleRevokeInvite(inv.code)}
                                className="h-7 px-2 text-[11px] text-[#B43B2E]"
                              >
                                {dict.pool.revoke}
                              </Button>
                            )}
                          </div>
                        </li>
                      );
                    })
                  )}
                </ul>
              </section>

              {/* Users & Quotas */}
              <section className="rounded-lg border border-[#E5E0D6] bg-[#FFFFFF] p-4 space-y-3 xl:col-span-7">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-[#1A1D24]">
                  <Users className="h-4 w-4 text-[#3E5C76]" />
                  {dict.pool.usersTitle}
                </h2>
                <div className="divide-y divide-[#E5E0D6]">
                  {adminUsers.map((u) => {
                    const draft = userDrafts[u.id];
                    if (!draft) return null;
                    return (
                      <div key={u.id} className="py-3.5 first:pt-1 last:pb-1 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold text-[#1A1D24]">
                                {u.username}
                              </span>
                              {u.id === user.id && (
                                <Badge variant="seal" className="text-[10px]">
                                  {dict.pool.userYou}
                                </Badge>
                              )}
                            </div>
                            <div className="text-[11px] text-[#62666F]">
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
                            {busyAction === `user:${u.id}`
                              ? dict.app.saving
                              : dict.app.save}
                          </Button>
                        </div>

                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                          <div className="space-y-1">
                            <Label className="text-[10px] text-[#62666F]">
                              {dict.pool.userRole}
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
                            <Label className="text-[10px] text-[#62666F]">
                              {dict.pool.userDailyQuota}
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
                            <Label className="text-[10px] text-[#62666F]">
                              {dict.pool.userMaxQueued}
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
                            <Label className="text-[10px] text-[#62666F]">
                              {dict.pool.userAllowedGpus}
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
                                        ? "border-[#1A1D24] bg-[#1A1D24] text-white"
                                        : "border-[#E5E0D6] bg-[#FFFFFF] text-[#62666F]"
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
                </div>
              </section>
            </div>
          </TabsContent>
        )}
      </Tabs>

      {/* Account Onboard Dialog */}
      <Dialog open={onboardOpen} onOpenChange={setOnboardOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{dict.pool.onboardTitle}</DialogTitle>
            <DialogDescription>{dict.pool.onboardDesc}</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleOnboardAccount} className="space-y-4 p-5">
            {onboardError && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-[#EBC1BC] bg-[#FDF0EE] px-3 py-2 text-xs text-[#B43B2E]"
              >
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{onboardError}</span>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="acc-label">{dict.pool.accountLabel}</Label>
              <Input
                id="acc-label"
                placeholder="Colab Pro+"
                value={accLabel}
                onChange={(e) => setAccLabel(e.target.value)}
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="acc-prio">{dict.pool.priority}</Label>
                <Input
                  id="acc-prio"
                  type="number"
                  min={1}
                  max={1000}
                  value={accPriority}
                  onChange={(e) =>
                    setAccPriority(Number(e.target.value) || 100)
                  }
                  className="font-mono tabular-nums"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="acc-floor">{dict.pool.minBalance}</Label>
                <Input
                  id="acc-floor"
                  type="number"
                  min={0}
                  max={10000}
                  step={0.5}
                  value={accMinBalance}
                  onChange={(e) =>
                    setAccMinBalance(Number(e.target.value) || 0)
                  }
                  className="font-mono tabular-nums"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="acc-adc">{dict.pool.adcPayload}</Label>
                <label className="inline-flex cursor-pointer items-center gap-1 text-[11px] font-medium text-[#3E5C76] hover:underline">
                  <Upload className="h-3 w-3" />
                  {dict.pool.loadJsonFile}
                  <input
                    type="file"
                    accept=".json,application/json"
                    className="sr-only"
                    onChange={(e) =>
                      void handleAdcFileUpload(e.target.files?.[0])
                    }
                  />
                </label>
              </div>
              <Textarea
                id="acc-adc"
                rows={5}
                placeholder='{"type": "authorized_user", ...}'
                value={accAdcText}
                onChange={(e) => setAccAdcText(e.target.value)}
                className="font-mono text-xs"
                required
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOnboardOpen(false)}
              >
                {dict.app.cancel}
              </Button>
              <Button type="submit" disabled={busyAction === "onboard"}>
                {busyAction === "onboard"
                  ? dict.pool.onboardSubmitting
                  : dict.pool.onboardSubmit}
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
            <DialogTitle>{dict.pool.editAccountTitle}</DialogTitle>
            <DialogDescription>{editingAccount?.email}</DialogDescription>
          </DialogHeader>
          {editingAccount && (
            <form onSubmit={handleSaveAccount} className="space-y-4 p-5">
              <div className="space-y-1.5">
                <Label htmlFor="edit-acc-label">{dict.pool.accountLabel}</Label>
                <Input
                  id="edit-acc-label"
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="edit-acc-prio">{dict.pool.priority}</Label>
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
                  <Label htmlFor="edit-acc-floor">{dict.pool.minBalance}</Label>
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
              <div className="flex items-center justify-between rounded-md border border-[#E5E0D6] bg-[#FAF8F4] px-3 py-2">
                <Label htmlFor="edit-acc-enabled" className="cursor-pointer">
                  {dict.pool.accountEnabledSwitch}
                </Label>
                <Switch
                  id="edit-acc-enabled"
                  checked={editEnabled}
                  onCheckedChange={setEditEnabled}
                />
              </div>
              {editingAccount.unsupported_gpus.length > 0 && (
                <div className="flex items-center justify-between rounded-md border border-[#E5D0AD] bg-[#FBF4E8] px-3 py-2">
                  <Label
                    htmlFor="edit-acc-reset"
                    className="cursor-pointer text-[#8D5B1B]"
                  >
                    {interpolate(dict.pool.resetUnsupportedSwitch, {
                      gpus: editingAccount.unsupported_gpus.join(", "),
                    })}
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
                  {dict.app.cancel}
                </Button>
                <Button
                  type="submit"
                  disabled={busyAction === `edit:${editingAccount.id}`}
                >
                  {dict.app.save}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
