import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Clock,
  Dices,
  Download,
  ExternalLink,
  Info,
  Loader2,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import { interpolate, useI18n } from "@/i18n";
import { ApiError, jobsApi } from "@/lib/api";
import { cn, formatRelativeTime } from "@/lib/utils";
import {
  GPU_TIER_META,
  sanitizeGpuTiers,
  type AuthUser,
  type GpuTier,
  type JobRecord,
  type JobStatus,
  type LoraInput,
  type LoraRecord,
  type StudioContextSnapshot,
  type StudioDraft,
  type WorkerRecord,
  type WorkflowManifest,
} from "@/types/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface StudioViewProps {
  user: AuthUser;
  workflows: WorkflowManifest[];
  loras: LoraRecord[];
  jobs: JobRecord[];
  workers: WorkerRecord[];
  gpuWarning: string | null;
  pendingDraft: StudioDraft | null;
  onConsumeDraft: () => void;
  onContextChange: (ctx: StudioContextSnapshot) => void;
  onJobSubmitted: (job: JobRecord) => void;
  onJobCancelled: (job: JobRecord) => void;
  onOpenGallery: () => void;
}

function randomSeed32(): number {
  return Math.floor(Math.random() * 2_147_483_646) + 1;
}

function shortAspectLabel(label: string): string {
  const m = label.match(/^(\d+:\d+)/);
  return m ? m[1] : label;
}

function AspectGlyph({ w, h }: { w: number; h: number }) {
  const max = Math.max(w, h);
  const rw = Math.max(7, Math.round((w / max) * 14));
  const rh = Math.max(7, Math.round((h / max) * 14));
  return (
    <span
      aria-hidden="true"
      className="inline-block rounded-[2px] border border-current"
      style={{ width: `${rw}px`, height: `${rh}px` }}
    />
  );
}

export function StudioView({
  user,
  workflows,
  loras,
  jobs,
  workers,
  gpuWarning,
  pendingDraft,
  onConsumeDraft,
  onContextChange,
  onJobSubmitted,
  onJobCancelled,
  onOpenGallery,
}: StudioViewProps) {
  const { dict } = useI18n();
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const allowedGpus = useMemo(
    () => sanitizeGpuTiers(user.allowed_gpus),
    [user.allowed_gpus]
  );

  const [workflowId, setWorkflowId] = useState<string>(
    () => workflows[0]?.id ?? "anima"
  );

  const workflow = useMemo(
    () => workflows.find((w) => w.id === workflowId) ?? workflows[0] ?? null,
    [workflows, workflowId]
  );

  const visibleVariants = useMemo(() => {
    if (!workflow) return [];
    return Object.entries(workflow.variants).filter(
      ([, spec]) => user.role === "admin" || !spec.admin_only
    );
  }, [workflow, user.role]);

  const [variant, setVariant] = useState<string>(
    () => workflow?.default_variant ?? "turbo"
  );

  const activeVariantSpec = useMemo(() => {
    if (!workflow) return null;
    const match = visibleVariants.find(([key]) => key === variant);
    return match ? match[1] : visibleVariants[0]?.[1] ?? null;
  }, [workflow, visibleVariants, variant]);

  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [steps, setSteps] = useState(10);
  const [cfg, setCfg] = useState(1.0);
  const [samplerName, setSamplerName] = useState("euler");
  const [scheduler, setScheduler] = useState("simple");
  const [seedInput, setSeedInput] = useState<string>("");
  const [batchSize, setBatchSize] = useState(1);
  const [gpuType, setGpuType] = useState<GpuTier>(() => allowedGpus[0] ?? "L4");
  const [selectedLoras, setSelectedLoras] = useState<LoraInput[]>([]);
  const [loraToAdd, setLoraToAdd] = useState<string>("");

  const [paramsOpen, setParamsOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const [jobScope, setJobScope] = useState<"mine" | "all">("mine");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [initializedKey, setInitializedKey] = useState("");

  useEffect(() => {
    if (!workflow && workflows.length > 0) {
      setWorkflowId(workflows[0].id);
    }
  }, [workflow, workflows]);

  useEffect(() => {
    if (!allowedGpus.includes(gpuType)) {
      setGpuType(allowedGpus[0] ?? "L4");
    }
  }, [allowedGpus, gpuType]);

  // Initialize variant defaults once when workflows load
  useEffect(() => {
    if (!workflow || pendingDraft) return;
    const validKey = visibleVariants.some(([k]) => k === variant)
      ? variant
      : workflow.default_variant in workflow.variants &&
        (user.role === "admin" || !workflow.variants[workflow.default_variant].admin_only)
      ? workflow.default_variant
      : visibleVariants[0]?.[0];

    if (!validKey) return;
    if (validKey !== variant) {
      setVariant(validKey);
    }
    if (initializedKey === "") {
      const defaults = workflow.variants[validKey].defaults;
      setSteps(defaults.steps);
      setCfg(defaults.cfg);
      setSamplerName(defaults.sampler_name);
      setScheduler(defaults.scheduler);
      setNegativePrompt(defaults.negative_prompt);
      const preset = workflow.resolution_presets[0];
      if (preset) {
        setWidth(preset.width);
        setHeight(preset.height);
      }
      setInitializedKey(`${workflow.id}:${validKey}`);
    }
  }, [workflow, variant, visibleVariants, user.role, initializedKey, pendingDraft]);

  // Apply Remix or Copilot Recipe draft
  useEffect(() => {
    if (!pendingDraft || !workflow) return;
    const targetWf =
      workflows.find((w) => w.id === pendingDraft.workflow_id) ?? workflow;
    setWorkflowId(targetWf.id);

    const requestedVar = pendingDraft.variant ?? targetWf.default_variant;
    const requestedSpec = targetWf.variants[requestedVar];
    const canUseRequested =
      Boolean(requestedSpec) &&
      (user.role === "admin" || !requestedSpec.admin_only);
    const fallbackVar =
      Object.entries(targetWf.variants).find(
        ([, v]) => user.role === "admin" || !v.admin_only
      )?.[0] ?? targetWf.default_variant;

    const resolvedVariant = canUseRequested ? requestedVar : fallbackVar;
    const defaults = targetWf.variants[resolvedVariant]?.defaults;
    setVariant(resolvedVariant);
    setInitializedKey(`${targetWf.id}:${resolvedVariant}`);

    setPrompt(pendingDraft.prompt);
    setNegativePrompt(
      pendingDraft.negative_prompt ?? defaults?.negative_prompt ?? ""
    );

    const b = targetWf.bounds;
    if (pendingDraft.width) {
      setWidth(
        Math.min(b.max_dimension, Math.max(b.min_dimension, pendingDraft.width))
      );
    }
    if (pendingDraft.height) {
      setHeight(
        Math.min(b.max_dimension, Math.max(b.min_dimension, pendingDraft.height))
      );
    }
    setSteps(
      pendingDraft.steps !== undefined
        ? Math.min(b.max_steps, Math.max(b.min_steps, pendingDraft.steps))
        : defaults?.steps ?? 10
    );
    setCfg(
      pendingDraft.cfg !== undefined
        ? Math.min(b.max_cfg, Math.max(b.min_cfg, pendingDraft.cfg))
        : defaults?.cfg ?? 1.0
    );
    if (
      pendingDraft.sampler_name &&
      b.allowed_samplers.includes(pendingDraft.sampler_name)
    ) {
      setSamplerName(pendingDraft.sampler_name);
    } else if (defaults) {
      setSamplerName(defaults.sampler_name);
    }
    if (
      pendingDraft.scheduler &&
      b.allowed_schedulers.includes(pendingDraft.scheduler)
    ) {
      setScheduler(pendingDraft.scheduler);
    } else if (defaults) {
      setScheduler(defaults.scheduler);
    }
    if (pendingDraft.seed !== undefined && pendingDraft.seed !== null) {
      setSeedInput(String(pendingDraft.seed));
    }

    if (pendingDraft.loras) {
      const matched: LoraInput[] = [];
      for (const item of pendingDraft.loras) {
        const found =
          (item.id ? loras.find((l) => l.id === item.id) : undefined) ??
          (item.filename
            ? loras.find((l) => l.filename === item.filename)
            : undefined);
        if (found && !matched.some((m) => m.id === found.id)) {
          matched.push({ id: found.id, strength: item.strength });
        }
      }
      setSelectedLoras(matched.slice(0, targetWf.max_loras));
    }

    if (pendingDraft.gpu_type) {
      const upper = pendingDraft.gpu_type.trim().toUpperCase();
      const matchedGpu = allowedGpus.find((g) => g === upper);
      if (matchedGpu) setGpuType(matchedGpu);
    }

    if (pendingDraft.sourceLabel) {
      setDraftNotice(
        canUseRequested
          ? interpolate(dict.studio.remixLoaded, {
              id: pendingDraft.sourceLabel,
              seed: pendingDraft.seed ?? "auto",
            })
          : interpolate(dict.studio.remixFallback, {
              id: pendingDraft.sourceLabel,
              variant: requestedVar,
              fallback: resolvedVariant,
            })
      );
    }

    setSubmitError(null);
    onConsumeDraft();
  }, [
    pendingDraft,
    workflow,
    workflows,
    loras,
    user.role,
    allowedGpus,
    dict.studio.remixLoaded,
    dict.studio.remixFallback,
    onConsumeDraft,
  ]);

  // Publish live studio context to App for Floating Copilot quick chips
  useEffect(() => {
    onContextChange({
      workflow_id: workflow?.id ?? "anima",
      variant,
      prompt,
      negative_prompt: negativePrompt,
      width,
      height,
      steps,
      cfg,
      sampler_name: samplerName,
      scheduler,
      batch_size: batchSize,
      gpu_type: gpuType,
      loras: selectedLoras,
    });
  }, [
    workflow?.id,
    variant,
    prompt,
    negativePrompt,
    width,
    height,
    steps,
    cfg,
    samplerName,
    scheduler,
    batchSize,
    gpuType,
    selectedLoras,
    onContextChange,
  ]);

  const handleVariantChange = (nextVariant: string) => {
    setVariant(nextVariant);
    if (!workflow) return;
    const spec = workflow.variants[nextVariant];
    if (!spec) return;
    setSteps(spec.defaults.steps);
    setCfg(spec.defaults.cfg);
    setSamplerName(spec.defaults.sampler_name);
    setScheduler(spec.defaults.scheduler);
    setNegativePrompt(spec.defaults.negative_prompt);
    setInitializedKey(`${workflow.id}:${nextVariant}`);
  };

  const handleAddLora = (loraId: string) => {
    if (!workflow || !loraId) return;
    if (selectedLoras.some((item) => item.id === loraId)) return;
    if (selectedLoras.length >= workflow.max_loras) return;
    const record = loras.find((l) => l.id === loraId);
    if (!record) return;
    setSelectedLoras((prev) => [
      ...prev,
      { id: record.id, strength: record.default_weight },
    ]);
    setLoraToAdd("");
  };

  const handleAppendTrigger = (words: string) => {
    const clean = words.trim();
    if (!clean) return;
    setPrompt((prev) => {
      const p = prev.trim();
      if (!p) return clean;
      if (p.toLowerCase().includes(clean.toLowerCase())) return prev;
      return `${p}, ${clean}`;
    });
  };

  const handleInsertPrefix = () => {
    const prefix = activeVariantSpec?.defaults.positive_prefix ?? "";
    if (!prefix) return;
    setPrompt((prev) => {
      if (prev.startsWith(prefix.trim())) return prev;
      return prev.trim() ? `${prefix}${prev}` : prefix;
    });
  };

  const submitGeneration = async () => {
    setSubmitError(null);
    if (!workflow) return;
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) {
      setSubmitError(dict.studio.errNoPrompt);
      return;
    }
    let parsedSeed: number | null = null;
    if (seedInput.trim() !== "") {
      const n = Number(seedInput.trim());
      if (!Number.isInteger(n) || n < 0 || n > 4_294_967_295) {
        setSubmitError(dict.studio.errBadSeed);
        return;
      }
      parsedSeed = n;
    }

    setSubmitting(true);
    try {
      const res = await jobsApi.submit({
        workflow_id: workflow.id,
        variant,
        prompt: cleanPrompt,
        negative_prompt: negativePrompt.trim() ? negativePrompt : null,
        width,
        height,
        batch_size: batchSize,
        steps,
        cfg,
        sampler_name: samplerName,
        scheduler,
        seed: parsedSeed,
        lora_ids: selectedLoras,
        gpu_type: gpuType,
      });
      onJobSubmitted(res.job);
      setSelectedJobId(res.job.id);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.detail : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submitGeneration();
  };

  const handlePromptKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void submitGeneration();
    }
  };

  const handleCancelJob = async (jobId: string) => {
    setCancellingId(jobId);
    try {
      const res = await jobsApi.cancel(jobId);
      onJobCancelled(res.job);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.detail : "Cancel failed");
    } finally {
      setCancellingId(null);
    }
  };

  const activeManagedWorker = useMemo(
    () =>
      workers.find(
        (w) =>
          w.origin === "managed" &&
          (w.status === "assigning" ||
            w.status === "bootstrapping" ||
            w.status === "ready" ||
            w.status === "stopping")
      ) ?? null,
    [workers]
  );

  const visibleJobs = useMemo(() => {
    if (jobScope === "mine") {
      return jobs.filter((j) => j.user_id === user.id);
    }
    return jobs;
  }, [jobs, jobScope, user.id]);

  const focusedJob = useMemo(() => {
    if (selectedJobId) {
      const found = jobs.find((j) => j.id === selectedJobId);
      if (found) return found;
    }
    const mineActive = jobs.find(
      (j) =>
        j.user_id === user.id &&
        (j.status === "running" ||
          j.status === "booting" ||
          j.status === "queued")
    );
    if (mineActive) return mineActive;
    const mineCompleted = jobs.find(
      (j) =>
        j.user_id === user.id &&
        j.status === "completed" &&
        j.image_ids.length > 0
    );
    return mineCompleted ?? jobs[0] ?? null;
  }, [jobs, selectedJobId, user.id]);

  const remainingQuota =
    user.daily_quota > 0
      ? Math.max(0, user.daily_quota - user.used_today)
      : Infinity;
  const queueFull = user.active_queued >= user.max_queued;

  const availableLorasToAdd = useMemo(
    () => loras.filter((l) => !selectedLoras.some((s) => s.id === l.id)),
    [loras, selectedLoras]
  );

  const stepStageIndex = useMemo(() => {
    if (!focusedJob) return -1;
    switch (focusedJob.status) {
      case "queued":
        return 0;
      case "booting":
        return activeManagedWorker?.status === "bootstrapping" ? 2 : 1;
      case "running":
        return 3;
      case "completed":
        return 4;
      default:
        return -1;
    }
  }, [focusedJob, activeManagedWorker]);

  const statusBadge = (status: JobStatus) => {
    const label = dict.studio.status[status];
    switch (status) {
      case "completed":
        return <Badge variant="sage">{label}</Badge>;
      case "running":
        return <Badge variant="slate">{label}</Badge>;
      case "booting":
        return <Badge variant="ochre">{label}</Badge>;
      case "failed":
        return <Badge variant="vermilion">{label}</Badge>;
      default:
        return <Badge variant="neutral">{label}</Badge>;
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
      {/* Left Dock: Prompt + Collapsible Parameters + Compact Queue */}
      <div className="space-y-4 lg:col-span-5">
        <form
          onSubmit={handleSubmit}
          className="rounded-lg border border-[#E5E0D6] bg-[#FFFFFF] p-4 space-y-4"
        >
          {draftNotice && (
            <div className="flex items-start justify-between gap-2 rounded-md border border-[#C8D5E1] bg-[#EFF3F7] px-3 py-2 text-xs text-[#3E5C76]">
              <span>{draftNotice}</span>
              <button
                type="button"
                onClick={() => setDraftNotice(null)}
                className="underline shrink-0"
              >
                {dict.app.dismiss}
              </button>
            </div>
          )}

          {submitError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-[#EBC1BC] bg-[#FDF0EE] px-3 py-2 text-xs text-[#B43B2E]"
            >
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{submitError}</span>
            </div>
          )}

          {/* Prompt Textarea */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="studio-prompt" className="text-[#1A1D24]">
                  {workflow?.name ?? "Anima"}
                </Label>
                {workflow?.prompt_hint && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="Prompting hint"
                        className="text-[#62666F] hover:text-[#1A1D24]"
                      >
                        <Info className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{workflow.prompt_hint}</TooltipContent>
                  </Tooltip>
                )}
              </div>
              {activeVariantSpec?.defaults.positive_prefix && (
                <button
                  type="button"
                  onClick={handleInsertPrefix}
                  className="text-[11px] font-medium text-[#3E5C76] hover:underline"
                >
                  {dict.studio.addQualityPrefix}
                </button>
              )}
            </div>

            <Textarea
              ref={promptRef}
              id="studio-prompt"
              rows={4}
              placeholder={dict.studio.promptPlaceholder}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handlePromptKeyDown}
              className="leading-relaxed bg-[#FAF8F4]/50"
            />
          </div>

          {/* Inline Variant Pills */}
          <div className="space-y-1.5">
            <Label>{dict.studio.variantLabel}</Label>
            <div className="flex flex-wrap gap-1.5">
              {visibleVariants.map(([key, spec]) => {
                const active = variant === key;
                return (
                  <Tooltip key={key}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => handleVariantChange(key)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                          active
                            ? "border-[#1A1D24] bg-[#1A1D24] text-white"
                            : "border-[#E5E0D6] bg-[#FAF8F4] text-[#4A4E58] hover:border-[#D4CEC2] hover:text-[#1A1D24]"
                        )}
                      >
                        <span>{spec.label}</span>
                        {spec.admin_only && (
                          <span
                            className={cn(
                              "rounded px-1 text-[9px]",
                              active
                                ? "bg-white/20 text-white"
                                : "bg-[#FDF1EE] text-[#C85642]"
                            )}
                          >
                            admin
                          </span>
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{spec.description}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </div>

          {/* Visual Aspect Ratio Pills */}
          {workflow && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>{dict.studio.aspectLabel}</Label>
                <span className="font-mono text-[11px] text-[#62666F] tabular-nums">
                  {width}×{height}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {workflow.resolution_presets.map((preset) => {
                  const active =
                    width === preset.width && height === preset.height;
                  return (
                    <Tooltip key={preset.id}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => {
                            setWidth(preset.width);
                            setHeight(preset.height);
                          }}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-xs transition-colors tabular-nums",
                            active
                              ? "border-[#C85642] bg-[#FDF1EE] text-[#C85642] font-medium"
                              : "border-[#E5E0D6] bg-[#FFFFFF] text-[#4A4E58] hover:bg-[#FAF8F4]"
                          )}
                        >
                          <AspectGlyph w={preset.width} h={preset.height} />
                          <span>{shortAspectLabel(preset.label)}</span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{preset.label}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
          )}

          {/* Collapsible Progressive Disclosure: Fine Parameters */}
          {workflow && (
            <div className="rounded-md border border-[#E5E0D6] bg-[#FAF8F4]">
              <button
                type="button"
                aria-expanded={paramsOpen}
                onClick={() => setParamsOpen((o) => !o)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-[#1A1D24] hover:bg-[#F2EFE9]/70 transition-colors rounded-md"
              >
                <span className="flex items-center gap-1.5">
                  <SlidersHorizontal className="h-3.5 w-3.5 text-[#62666F]" />
                  <span>{dict.studio.parametersBtn}</span>
                </span>
                <span className="flex items-center gap-1.5 font-mono text-[11px] text-[#62666F] tabular-nums">
                  <span>
                    {steps}s · CFG {cfg.toFixed(1)} · {gpuType}
                    {selectedLoras.length > 0
                      ? ` · ${selectedLoras.length} LoRA`
                      : ""}
                  </span>
                  {paramsOpen ? (
                    <ChevronUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                </span>
              </button>

              {paramsOpen && (
                <div className="border-t border-[#E5E0D6] p-3 space-y-3.5 bg-[#F2EFE9]/45">
                  {/* Negative Prompt */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="studio-negative">
                        {dict.studio.negativePrompt}
                      </Label>
                      {activeVariantSpec?.defaults.negative_prompt && (
                        <button
                          type="button"
                          onClick={() =>
                            setNegativePrompt(
                              activeVariantSpec.defaults.negative_prompt
                            )
                          }
                          className="inline-flex items-center gap-1 text-[11px] text-[#62666F] hover:text-[#1A1D24]"
                        >
                          <RotateCcw className="h-3 w-3" />
                          {dict.studio.resetDefault}
                        </button>
                      )}
                    </div>
                    <Textarea
                      id="studio-negative"
                      rows={2}
                      value={negativePrompt}
                      onChange={(e) => setNegativePrompt(e.target.value)}
                      className="min-h-[56px] text-xs"
                    />
                  </div>

                  {/* Custom Dimensions */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="studio-width" className="text-[11px]">
                        {dict.studio.width}
                      </Label>
                      <Input
                        id="studio-width"
                        type="number"
                        min={workflow.bounds.min_dimension}
                        max={workflow.bounds.max_dimension}
                        step={workflow.bounds.dimension_step}
                        value={width}
                        onChange={(e) =>
                          setWidth(
                            Number(e.target.value) ||
                              workflow.bounds.min_dimension
                          )
                        }
                        className="h-8 font-mono text-xs tabular-nums"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="studio-height" className="text-[11px]">
                        {dict.studio.height}
                      </Label>
                      <Input
                        id="studio-height"
                        type="number"
                        min={workflow.bounds.min_dimension}
                        max={workflow.bounds.max_dimension}
                        step={workflow.bounds.dimension_step}
                        value={height}
                        onChange={(e) =>
                          setHeight(
                            Number(e.target.value) ||
                              workflow.bounds.min_dimension
                          )
                        }
                        className="h-8 font-mono text-xs tabular-nums"
                      />
                    </div>
                  </div>

                  {/* Steps & CFG */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px]">{dict.studio.steps}</Label>
                        <span className="font-mono text-xs tabular-nums">
                          {steps}
                        </span>
                      </div>
                      <Slider
                        min={workflow.bounds.min_steps}
                        max={workflow.bounds.max_steps}
                        step={1}
                        value={[steps]}
                        onValueChange={([v]) => setSteps(v)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px]">{dict.studio.cfg}</Label>
                        <span className="font-mono text-xs tabular-nums">
                          {cfg.toFixed(1)}
                        </span>
                      </div>
                      <Slider
                        min={workflow.bounds.min_cfg}
                        max={workflow.bounds.max_cfg}
                        step={0.5}
                        value={[cfg]}
                        onValueChange={([v]) => setCfg(v)}
                      />
                    </div>
                  </div>

                  {/* Sampler & Scheduler */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-[11px]">{dict.studio.sampler}</Label>
                      <Select value={samplerName} onValueChange={setSamplerName}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {workflow.bounds.allowed_samplers.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px]">{dict.studio.scheduler}</Label>
                      <Select value={scheduler} onValueChange={setScheduler}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {workflow.bounds.allowed_schedulers.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Seed & Batch */}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
                    <div className="space-y-1 sm:col-span-7">
                      <Label htmlFor="studio-seed" className="text-[11px]">
                        {dict.studio.seed}
                      </Label>
                      <div className="flex gap-1.5">
                        <Input
                          id="studio-seed"
                          type="number"
                          min={0}
                          max={4294967295}
                          placeholder={dict.studio.seedRandomPlaceholder}
                          value={seedInput}
                          onChange={(e) => setSeedInput(e.target.value)}
                          className="h-8 font-mono text-xs tabular-nums"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-label="Randomize seed"
                          onClick={() => setSeedInput(String(randomSeed32()))}
                        >
                          <Dices className="h-3.5 w-3.5" />
                        </Button>
                        {seedInput !== "" && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setSeedInput("")}
                            className="h-8 px-2 text-[11px]"
                          >
                            {dict.studio.seedAuto}
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="space-y-1 sm:col-span-5">
                      <Label className="text-[11px]">{dict.studio.batchSize}</Label>
                      <div className="grid grid-cols-4 gap-1">
                        {Array.from(
                          { length: workflow.bounds.max_batch_size },
                          (_, idx) => idx + 1
                        ).map((n) => {
                          const exceeds = n > remainingQuota;
                          return (
                            <button
                              key={n}
                              type="button"
                              disabled={exceeds}
                              onClick={() => setBatchSize(n)}
                              className={cn(
                                "h-8 rounded-md border font-mono text-xs font-medium transition-colors tabular-nums",
                                batchSize === n
                                  ? "border-[#1A1D24] bg-[#1A1D24] text-white"
                                  : "border-[#E5E0D6] bg-[#FFFFFF] text-[#4A4E58] hover:bg-[#FAF8F4]",
                                exceeds && "opacity-40 cursor-not-allowed"
                              )}
                            >
                              {n}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* LoRAs */}
                  {workflow.supports_loras && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px]">
                          {dict.studio.loras} ({selectedLoras.length}/
                          {workflow.max_loras})
                        </Label>
                        {loras.length === 0 && (
                          <span className="text-[11px] text-[#62666F]">
                            {dict.studio.loraEmpty}
                          </span>
                        )}
                      </div>

                      {loras.length > 0 &&
                        selectedLoras.length < workflow.max_loras && (
                          <Select
                            value={loraToAdd}
                            onValueChange={handleAddLora}
                          >
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue
                                placeholder={dict.studio.loraAddPlaceholder}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              {availableLorasToAdd.map((l) => (
                                <SelectItem key={l.id} value={l.id}>
                                  {l.name} ({l.source_type})
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}

                      {selectedLoras.map((sel) => {
                        const meta = loras.find((l) => l.id === sel.id);
                        if (!meta) return null;
                        return (
                          <div
                            key={sel.id}
                            className="rounded-md border border-[#E5E0D6] bg-[#FFFFFF] p-2.5 space-y-1.5"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-xs font-medium text-[#1A1D24]">
                                {meta.name}
                              </span>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className="font-mono text-xs tabular-nums">
                                  {sel.strength.toFixed(2)}
                                </span>
                                <button
                                  type="button"
                                  aria-label={`Remove ${meta.name}`}
                                  onClick={() =>
                                    setSelectedLoras((prev) =>
                                      prev.filter((item) => item.id !== sel.id)
                                    )
                                  }
                                  className="text-[#62666F] hover:text-[#B43B2E]"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                            <Slider
                              min={-2.0}
                              max={2.0}
                              step={0.05}
                              value={[sel.strength]}
                              onValueChange={([v]) =>
                                setSelectedLoras((prev) =>
                                  prev.map((item) =>
                                    item.id === sel.id
                                      ? { ...item, strength: v }
                                      : item
                                  )
                                )
                              }
                            />
                            {meta.trigger_words && (
                              <button
                                type="button"
                                onClick={() =>
                                  handleAppendTrigger(meta.trigger_words)
                                }
                                className="inline-flex items-center gap-1 text-[10px] font-medium text-[#3E5C76] hover:underline"
                              >
                                <Plus className="h-2.5 w-2.5" />
                                {dict.studio.loraInsertTriggers}:{" "}
                                {meta.trigger_words}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* GPU Tier Selector (Strictly allowed BF16 Colab accelerators) */}
                  <div className="space-y-1.5">
                    <Label className="text-[11px]">{dict.studio.gpuTier}</Label>
                    <div className="flex flex-wrap gap-1.5">
                      {allowedGpus.map((tier) => {
                        const meta = GPU_TIER_META[tier];
                        const active = gpuType === tier;
                        return (
                          <Tooltip key={tier}>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={() => setGpuType(tier)}
                                className={cn(
                                  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-xs transition-colors",
                                  active
                                    ? "border-[#1A1D24] bg-[#1A1D24] text-white"
                                    : "border-[#E5E0D6] bg-[#FFFFFF] text-[#4A4E58] hover:bg-[#FAF8F4]"
                                )}
                              >
                                <span className="font-semibold">{tier}</span>
                                <span className="text-[10px] opacity-75">
                                  {meta.vram}
                                </span>
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {dict.studio.gpuNotes[tier]}
                            </TooltipContent>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Primary Vermilion Seal CTA */}
          <Button
            type="submit"
            disabled={
              submitting || queueFull || remainingQuota < batchSize || !workflow
            }
            className="w-full h-10 text-sm font-medium"
          >
            {submitting ? (
              <>
                <Loader2 className="animate-spin" />
                {dict.studio.submittingBtn}
              </>
            ) : queueFull ? (
              interpolate(dict.studio.queueFullBtn, {
                active: user.active_queued,
                max: user.max_queued,
              })
            ) : remainingQuota < batchSize ? (
              interpolate(dict.studio.quotaLowBtn, {
                left: remainingQuota,
              })
            ) : (
              <>
                <Sparkles />
                {batchSize > 1
                  ? interpolate(dict.studio.generateBatchBtn, {
                      count: batchSize,
                    })
                  : dict.studio.generateBtn}
              </>
            )}
          </Button>
        </form>

        {/* Compact Queue Strip */}
        <div className="rounded-lg border border-[#E5E0D6] bg-[#FFFFFF]">
          <div className="flex items-center justify-between border-b border-[#E5E0D6] px-4 py-2.5">
            <span className="text-xs font-semibold text-[#1A1D24]">
              {dict.studio.queueTitle}
            </span>
            <div className="flex items-center gap-1 rounded-full border border-[#E5E0D6] bg-[#F2EFE9] p-0.5 text-[11px]">
              <button
                type="button"
                onClick={() => setJobScope("mine")}
                className={cn(
                  "rounded-full px-2.5 py-0.5 font-medium transition-colors",
                  jobScope === "mine"
                    ? "bg-[#FFFFFF] text-[#1A1D24]"
                    : "text-[#62666F] hover:text-[#1A1D24]"
                )}
              >
                {dict.studio.queueMine}
              </button>
              <button
                type="button"
                onClick={() => setJobScope("all")}
                className={cn(
                  "rounded-full px-2.5 py-0.5 font-medium transition-colors tabular-nums",
                  jobScope === "all"
                    ? "bg-[#FFFFFF] text-[#1A1D24]"
                    : "text-[#62666F] hover:text-[#1A1D24]"
                )}
              >
                {dict.studio.queueAll} ({jobs.length})
              </button>
            </div>
          </div>

          {visibleJobs.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-[#62666F]">
              {dict.studio.queueEmpty}
            </div>
          ) : (
            <ul className="divide-y divide-[#E5E0D6] max-h-[300px] overflow-y-auto">
              {visibleJobs.slice(0, 12).map((job) => {
                const selected = focusedJob?.id === job.id;
                const canCancel =
                  (job.status === "queued" || job.status === "booting") &&
                  (job.user_id === user.id || user.role === "admin");
                return (
                  <li
                    key={job.id}
                    className={cn(
                      "flex items-center justify-between gap-2.5 px-4 py-2.5 transition-colors",
                      selected ? "bg-[#F2EFE9]/75" : "hover:bg-[#FAF8F4]"
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedJobId(job.id)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    >
                      {job.image_ids[0] ? (
                        <img
                          src={`/api/images/${job.image_ids[0]}/thumb`}
                          alt=""
                          className="h-9 w-9 shrink-0 rounded border border-[#E5E0D6] object-cover bg-[#F2EFE9]"
                        />
                      ) : (
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-[#E5E0D6] bg-[#FAF8F4] font-mono text-[10px] text-[#62666F] tabular-nums">
                          {Math.round(job.progress * 100)}%
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          {statusBadge(job.status)}
                          <span className="font-mono text-[11px] text-[#1A1D24]">
                            {job.variant}
                          </span>
                          <span className="text-[10px] text-[#62666F]">
                            {formatRelativeTime(job.created_at)}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-[#4A4E58]">
                          {(job.status === "queued" ||
                            job.status === "booting" ||
                            job.status === "running") &&
                          job.stage_detail
                            ? job.stage_detail
                            : job.params.prompt}
                        </p>
                      </div>
                    </button>
                    {canCancel && (
                      <Button
                        variant="destructiveOutline"
                        size="sm"
                        disabled={cancellingId === job.id}
                        onClick={() => void handleCancelJob(job.id)}
                        className="h-7 px-2 text-[11px] shrink-0"
                      >
                        {dict.studio.cancelJob}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Right Dominant Stage: Primary Artboard */}
      <div className="space-y-3 lg:col-span-7">
        {gpuWarning && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-[#E5D0AD] bg-[#FBF4E8] px-4 py-3 text-xs text-[#8D5B1B]"
          >
            <Clock className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">
                {dict.studio.gpuUnavailableTitle}
              </div>
              <p className="mt-0.5">{gpuWarning}</p>
            </div>
          </div>
        )}

        <div className="rounded-lg border border-[#E5E0D6] bg-[#FFFFFF] overflow-hidden">
          {/* Artboard Top Strip */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E5E0D6] px-5 py-3">
            <div className="flex items-center gap-2">
              {user.role === "admin" &&
                (activeManagedWorker ? (
                  <Badge variant="sage" className="font-mono">
                    {activeManagedWorker.gpu_type} · {activeManagedWorker.status}
                  </Badge>
                ) : (
                  <Badge variant="neutral">{dict.studio.workerStandby}</Badge>
                ))}
              {focusedJob && (
                <>
                  {statusBadge(focusedJob.status)}
                  <span className="font-mono text-xs text-[#62666F] tabular-nums">
                    {focusedJob.variant} · {focusedJob.params.width}×
                    {focusedJob.params.height}
                  </span>
                </>
              )}
            </div>

            {focusedJob && (
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-medium text-[#1A1D24] tabular-nums">
                  {Math.round(focusedJob.progress * 100)}%
                </span>
                {(focusedJob.status === "queued" ||
                  focusedJob.status === "booting") &&
                  (focusedJob.user_id === user.id || user.role === "admin") && (
                    <Button
                      variant="destructiveOutline"
                      size="sm"
                      disabled={cancellingId === focusedJob.id}
                      onClick={() => void handleCancelJob(focusedJob.id)}
                      className="h-7 px-2.5 text-[11px]"
                    >
                      {dict.studio.cancelJob}
                    </Button>
                  )}
              </div>
            )}
          </div>

          {/* Artboard Canvas */}
          <div className="p-5">
            {focusedJob ? (
              <div className="space-y-4">
                {focusedJob.status !== "failed" &&
                  focusedJob.status !== "cancelled" &&
                  focusedJob.status !== "completed" && (
                    <div className="space-y-2">
                      <div className="grid grid-cols-4 gap-2 text-[11px]">
                        {dict.studio.stages.map((label, idx) => {
                          const done = stepStageIndex > idx;
                          const current = stepStageIndex === idx;
                          return (
                            <div
                              key={label}
                              className={cn(
                                "rounded-md border px-2.5 py-1.5 text-center transition-colors",
                                done &&
                                  "border-[#BBD8C9] bg-[#ECF5F0] text-[#2F6F52]",
                                current &&
                                  "border-[#ECC5BD] bg-[#FDF1EE] text-[#C85642] font-medium",
                                !done &&
                                  !current &&
                                  "border-[#E5E0D6] bg-[#FAF8F4] text-[#62666F]"
                              )}
                            >
                              {label}
                            </div>
                          );
                        })}
                      </div>
                      <div className="h-1 w-full overflow-hidden rounded-full bg-[#E5E0D6]">
                        <div
                          className="h-full rounded-full bg-[#C85642] transition-all duration-300"
                          style={{
                            width: `${Math.max(
                              focusedJob.status === "queued" ? 8 : 16,
                              Math.round(focusedJob.progress * 100)
                            )}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}

                {focusedJob.status === "failed" && focusedJob.error_msg && (
                  <div className="flex items-start gap-2 rounded-md border border-[#EBC1BC] bg-[#FDF0EE] px-3 py-2.5 text-xs text-[#B43B2E]">
                    <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
                    <span className="break-all">{focusedJob.error_msg}</span>
                  </div>
                )}

                {focusedJob.image_ids.length > 0 ? (
                  <div className="space-y-3">
                    <div
                      className={cn(
                        "grid gap-3",
                        focusedJob.image_ids.length === 1
                          ? "grid-cols-1"
                          : "grid-cols-2"
                      )}
                    >
                      {focusedJob.image_ids.map((imgId) => (
                        <div
                          key={imgId}
                          className="overflow-hidden rounded-lg border border-[#E5E0D6] bg-[#F2EFE9]"
                        >
                          <img
                            src={`/api/images/${imgId}/original`}
                            alt={focusedJob.params.prompt}
                            className="max-h-[580px] w-full object-contain mx-auto"
                          />
                          <div className="flex items-center justify-between border-t border-[#E5E0D6] bg-[#FFFFFF] px-3.5 py-2 text-xs">
                            <span className="font-mono text-[#62666F] tabular-nums">
                              seed {focusedJob.params.seed}
                            </span>
                            <div className="flex items-center gap-3">
                              <a
                                href={`/api/images/${imgId}/original`}
                                download={`colab-canvas-${imgId.slice(0, 8)}.png`}
                                className="inline-flex items-center gap-1 font-medium text-[#3E5C76] hover:underline"
                              >
                                <Download className="h-3.5 w-3.5" />
                                {dict.studio.downloadPng}
                              </a>
                              <button
                                type="button"
                                onClick={onOpenGallery}
                                className="inline-flex items-center gap-1 font-medium text-[#1A1D24] hover:underline"
                              >
                                {dict.studio.toGallery}
                                <ExternalLink className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex min-h-[420px] flex-col items-center justify-center rounded-lg border border-dashed border-[#D4CEC2] bg-[#FAF8F4] p-8 text-center">
                    <Loader2 className="h-6 w-6 animate-spin text-[#C85642]" />
                    <p className="mt-3 text-sm font-medium text-[#1A1D24]">
                      {focusedJob.stage_detail
                        ? focusedJob.stage_detail
                        : focusedJob.status === "queued"
                        ? dict.studio.stageQueued
                        : focusedJob.status === "booting"
                        ? dict.studio.stageBooting
                        : focusedJob.status === "running"
                        ? interpolate(dict.studio.stageRunning, {
                            pct: Math.round(focusedJob.progress * 100),
                          })
                        : interpolate(dict.studio.stageEmpty, {
                            status: dict.studio.status[focusedJob.status],
                          })}
                    </p>
                    <p className="mt-1.5 max-w-md text-xs text-[#62666F] line-clamp-2">
                      {focusedJob.params.prompt}
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex min-h-[480px] flex-col items-center justify-center rounded-lg border border-dashed border-[#D4CEC2] bg-[#FAF8F4] px-6 py-10 text-center">
                <h2 className="font-display text-2xl font-semibold text-[#1A1D24]">
                  {dict.studio.stageIdleTitle}
                </h2>
                <p className="mt-1.5 text-xs text-[#62666F]">
                  {dict.studio.stageIdleSubtitle}
                </p>

                <div className="mt-6 grid w-full max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
                  {dict.studio.starterPrompts.map((chip) => (
                    <button
                      key={chip.label}
                      type="button"
                      onClick={() => {
                        setPrompt(chip.prompt);
                        promptRef.current?.focus();
                      }}
                      className="rounded-md border border-[#E5E0D6] bg-[#FFFFFF] px-3.5 py-2.5 text-left transition-colors hover:border-[#C85642] hover:bg-[#FDF1EE]/40"
                    >
                      <div className="text-xs font-medium text-[#1A1D24]">
                        {chip.label}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-[#62666F]">
                        {chip.prompt}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
