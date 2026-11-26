import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Cpu,
  Dices,
  ExternalLink,
  Info,
  Layers,
  Loader2,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Wand2,
  XCircle,
} from "lucide-react";
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
  type RemixDraft,
  type WorkerRecord,
  type WorkflowManifest,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";

interface StudioViewProps {
  user: AuthUser;
  workflows: WorkflowManifest[];
  loras: LoraRecord[];
  jobs: JobRecord[];
  workers: WorkerRecord[];
  gpuWarning: string | null;
  remixDraft: RemixDraft | null;
  onConsumeRemixDraft: () => void;
  onJobSubmitted: (job: JobRecord) => void;
  onJobCancelled: (job: JobRecord) => void;
  onOpenGallery: () => void;
}

function jobStatusBadge(status: JobStatus) {
  switch (status) {
    case "completed":
      return <Badge variant="sage">completed</Badge>;
    case "running":
      return <Badge variant="slate">running</Badge>;
    case "booting":
      return <Badge variant="ochre">booting</Badge>;
    case "queued":
      return <Badge variant="neutral">queued</Badge>;
    case "failed":
      return <Badge variant="vermilion">failed</Badge>;
    case "cancelled":
      return <Badge variant="neutral">cancelled</Badge>;
  }
}

function randomSeed32(): number {
  return Math.floor(Math.random() * 2_147_483_646) + 1;
}

export function StudioView({
  user,
  workflows,
  loras,
  jobs,
  workers,
  gpuWarning,
  remixDraft,
  onConsumeRemixDraft,
  onJobSubmitted,
  onJobCancelled,
  onOpenGallery,
}: StudioViewProps) {
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

  const [variant, setVariant] = useState<string>(() => {
    if (workflow?.default_variant) return workflow.default_variant;
    return "turbo";
  });

  const activeVariantSpec = useMemo(() => {
    if (!workflow) return null;
    const match = visibleVariants.find(([key]) => key === variant);
    if (match) return match[1];
    return visibleVariants[0]?.[1] ?? null;
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

  const [submitting, setSubmitting] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [remixNotice, setRemixNotice] = useState<string | null>(null);
  const [jobScope, setJobScope] = useState<"mine" | "all">("mine");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [initializedVariantKey, setInitializedVariantKey] = useState<string>("");

  // Sync workflow selection if workflows arrive asynchronously
  useEffect(() => {
    if (!workflow && workflows.length > 0) {
      setWorkflowId(workflows[0].id);
    }
  }, [workflow, workflows]);

  // Keep gpuType strictly within user's allowed GPUs
  useEffect(() => {
    if (!allowedGpus.includes(gpuType)) {
      setGpuType(allowedGpus[0] ?? "L4");
    }
  }, [allowedGpus, gpuType]);

  // Initialize defaults when workflow / variant first loads (unless a Remix draft is pending)
  useEffect(() => {
    if (!workflow || remixDraft) return;
    const effectiveVariantKey = visibleVariants.some(([k]) => k === variant)
      ? variant
      : workflow.default_variant in workflow.variants &&
        (user.role === "admin" || !workflow.variants[workflow.default_variant].admin_only)
      ? workflow.default_variant
      : visibleVariants[0]?.[0];

    if (!effectiveVariantKey) return;
    if (effectiveVariantKey !== variant) {
      setVariant(effectiveVariantKey);
    }
    const compoundKey = `${workflow.id}:${effectiveVariantKey}`;
    if (initializedVariantKey === "") {
      const defaults = workflow.variants[effectiveVariantKey].defaults;
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
      setInitializedVariantKey(compoundKey);
    }
  }, [
    workflow,
    variant,
    visibleVariants,
    user.role,
    initializedVariantKey,
    remixDraft,
  ]);

  // Hydrate Remix Draft from Gallery
  useEffect(() => {
    if (!remixDraft || !workflow) return;
    const targetWf =
      workflows.find((w) => w.id === remixDraft.workflow_id) ?? workflow;
    setWorkflowId(targetWf.id);

    const requestedSpec = targetWf.variants[remixDraft.variant];
    const canUseRequested =
      Boolean(requestedSpec) &&
      (user.role === "admin" || !requestedSpec.admin_only);
    const fallbackKey =
      Object.entries(targetWf.variants).find(
        ([, v]) => user.role === "admin" || !v.admin_only
      )?.[0] ?? targetWf.default_variant;

    const resolvedVariant = canUseRequested ? remixDraft.variant : fallbackKey;
    setVariant(resolvedVariant);
    setInitializedVariantKey(`${targetWf.id}:${resolvedVariant}`);

    setPrompt(remixDraft.prompt);
    setNegativePrompt(remixDraft.negative_prompt);
    setWidth(remixDraft.width);
    setHeight(remixDraft.height);
    setSteps(remixDraft.steps);
    setCfg(remixDraft.cfg);
    setSamplerName(remixDraft.sampler_name);
    setScheduler(remixDraft.scheduler);
    setSeedInput(String(remixDraft.seed));

    const matchedLoras: LoraInput[] = [];
    for (const item of remixDraft.loras) {
      const found =
        (item.id ? loras.find((l) => l.id === item.id) : undefined) ??
        loras.find((l) => l.filename === item.filename);
      if (found && !matchedLoras.some((m) => m.id === found.id)) {
        matchedLoras.push({ id: found.id, strength: item.strength });
      }
    }
    setSelectedLoras(matchedLoras.slice(0, targetWf.max_loras));

    const upperGpu = remixDraft.gpu_type.trim().toUpperCase();
    const matchedGpu = allowedGpus.find((g) => g === upperGpu);
    setGpuType(matchedGpu ?? allowedGpus[0] ?? "L4");

    setRemixNotice(
      canUseRequested
        ? `Hydrated parameters from image ${remixDraft.sourceImageId.slice(0, 8)} (seed ${remixDraft.seed}).`
        : `Hydrated from image ${remixDraft.sourceImageId.slice(0, 8)} (variant '${remixDraft.variant}' requires admin; switched to '${resolvedVariant}').`
    );
    setSubmitError(null);
    onConsumeRemixDraft();
  }, [
    remixDraft,
    workflow,
    workflows,
    loras,
    user.role,
    allowedGpus,
    onConsumeRemixDraft,
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
    setInitializedVariantKey(`${workflow.id}:${nextVariant}`);
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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    if (!workflow) {
      setSubmitError("No workflow manifest loaded.");
      return;
    }
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) {
      setSubmitError("Please enter a prompt before generating.");
      return;
    }
    let parsedSeed: number | null = null;
    if (seedInput.trim() !== "") {
      const n = Number(seedInput.trim());
      if (!Number.isInteger(n) || n < 0 || n > 4_294_967_295) {
        setSubmitError("Seed must be an integer between 0 and 4294967295.");
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
      setSubmitError(
        err instanceof ApiError ? err.detail : "Failed to submit job."
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelJob = async (jobId: string) => {
    setCancellingId(jobId);
    try {
      const res = await jobsApi.cancel(jobId);
      onJobCancelled(res.job);
    } catch (err) {
      setSubmitError(
        err instanceof ApiError ? err.detail : "Could not cancel job."
      );
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
        (j.status === "running" || j.status === "booting" || j.status === "queued")
    );
    if (mineActive) return mineActive;
    const mineCompleted = jobs.find(
      (j) => j.user_id === user.id && j.status === "completed" && j.image_ids.length > 0
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

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
      {/* Left: Generation Composer */}
      <form onSubmit={handleSubmit} className="space-y-4 lg:col-span-5">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Wand2 className="h-4 w-4 text-[#4A6580]" />
                  Studio Composer
                </CardTitle>
                <CardDescription>
                  Configure workflow, prompts, LoRAs, and sampling parameters.
                </CardDescription>
              </div>
              {workflow && (
                <Badge variant="neutral" className="font-mono text-[10px]">
                  {workflow.name}
                </Badge>
              )}
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            {remixNotice && (
              <div className="flex items-start justify-between gap-2 rounded-md border border-[#CBD7E3] bg-[#EFF3F7] px-3 py-2 text-xs text-[#3D546B]">
                <span className="flex items-start gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>{remixNotice}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setRemixNotice(null)}
                  className="text-[11px] underline underline-offset-2 shrink-0"
                >
                  Dismiss
                </button>
              </div>
            )}

            {submitError && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-[#E8C9C8] bg-[#FBF0F0] px-3 py-2 text-xs text-[#A84442]"
              >
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{submitError}</span>
              </div>
            )}

            {workflows.length > 1 && (
              <div className="space-y-1.5">
                <Label>Workflow</Label>
                <Select value={workflowId} onValueChange={setWorkflowId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select workflow" />
                  </SelectTrigger>
                  <SelectContent>
                    {workflows.map((wf) => (
                      <SelectItem key={wf.id} value={wf.id}>
                        {wf.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Variant Picker */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Model Variant</Label>
                {activeVariantSpec && (
                  <span className="font-mono text-[10px] text-[#78716C]">
                    {activeVariantSpec.weight.target_path.split("/").pop()}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {visibleVariants.map(([key, spec]) => {
                  const active = variant === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => handleVariantChange(key)}
                      className={cn(
                        "rounded-md border p-2.5 text-left transition-all",
                        active
                          ? "border-[#4A6580] bg-[#EFF3F7]/70 ring-1 ring-[#4A6580]/30"
                          : "border-[#E7E5E0] bg-[#FFFFFF] hover:border-[#D6D3CB] hover:bg-[#FAF9F6]"
                      )}
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <span className="text-xs font-semibold text-[#1C1917]">
                          {spec.label}
                        </span>
                        {spec.admin_only && (
                          <Badge variant="sakura" className="text-[9px] px-1.5 py-0">
                            admin
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 text-[11px] leading-snug text-[#78716C] line-clamp-2">
                        {spec.description}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Prompt & Anima Hint */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="studio-prompt">Positive Prompt</Label>
                {activeVariantSpec?.defaults.positive_prefix && (
                  <button
                    type="button"
                    onClick={handleInsertPrefix}
                    className="text-[11px] font-medium text-[#4A6580] hover:text-[#3D546B] underline underline-offset-2"
                  >
                    + Quality prefix
                  </button>
                )}
              </div>
              <Textarea
                id="studio-prompt"
                rows={4}
                placeholder="1girl, quiet Kyoto bookshop interior, morning sunlight filtering through paper shoji, warm wooden shelves, soft ink illustration"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="leading-relaxed"
              />
              {workflow?.prompt_hint && (
                <p className="flex items-start gap-1.5 rounded-md border border-[#E7E5E0] bg-[#FAF9F6] px-2.5 py-1.5 text-[11px] text-[#78716C]">
                  <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-[#4A6580]" />
                  <span>{workflow.prompt_hint}</span>
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="studio-negative">Negative Prompt</Label>
                {activeVariantSpec?.defaults.negative_prompt && (
                  <button
                    type="button"
                    onClick={() =>
                      setNegativePrompt(
                        activeVariantSpec.defaults.negative_prompt
                      )
                    }
                    className="inline-flex items-center gap-1 text-[11px] text-[#78716C] hover:text-[#1C1917]"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Reset default
                  </button>
                )}
              </div>
              <Textarea
                id="studio-negative"
                rows={2}
                placeholder="Optional negative terms..."
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.target.value)}
                className="min-h-[60px] text-xs"
              />
            </div>

            <Separator />

            {/* Resolution Presets */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Canvas Aspect &amp; Dimensions</Label>
                <span className="font-mono text-[11px] text-[#78716C] tabular-nums">
                  {width} × {height}
                </span>
              </div>
              {workflow && (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {workflow.resolution_presets.map((preset) => {
                      const active =
                        width === preset.width && height === preset.height;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => {
                            setWidth(preset.width);
                            setHeight(preset.height);
                          }}
                          className={cn(
                            "rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors tabular-nums",
                            active
                              ? "border-[#4A6580] bg-[#EFF3F7] text-[#3D546B]"
                              : "border-[#E7E5E0] bg-[#FFFFFF] text-[#44403C] hover:bg-[#FAF9F6]"
                          )}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <div className="space-y-1">
                      <Label htmlFor="studio-width" className="text-[11px] text-[#78716C]">
                        Width ({workflow.bounds.min_dimension}–{workflow.bounds.max_dimension})
                      </Label>
                      <Input
                        id="studio-width"
                        type="number"
                        min={workflow.bounds.min_dimension}
                        max={workflow.bounds.max_dimension}
                        step={workflow.bounds.dimension_step}
                        value={width}
                        onChange={(e) =>
                          setWidth(Number(e.target.value) || workflow.bounds.min_dimension)
                        }
                        className="h-8 font-mono text-xs tabular-nums"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="studio-height" className="text-[11px] text-[#78716C]">
                        Height ({workflow.bounds.min_dimension}–{workflow.bounds.max_dimension})
                      </Label>
                      <Input
                        id="studio-height"
                        type="number"
                        min={workflow.bounds.min_dimension}
                        max={workflow.bounds.max_dimension}
                        step={workflow.bounds.dimension_step}
                        value={height}
                        onChange={(e) =>
                          setHeight(Number(e.target.value) || workflow.bounds.min_dimension)
                        }
                        className="h-8 font-mono text-xs tabular-nums"
                      />
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Sampling & Seed */}
            {workflow && (
              <div className="space-y-3 pt-1">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Steps</Label>
                      <span className="font-mono text-xs text-[#1C1917] tabular-nums">
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

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>CFG Scale</Label>
                      <span className="font-mono text-xs text-[#1C1917] tabular-nums">
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

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label>Sampler</Label>
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
                    <Label>Scheduler</Label>
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

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
                  <div className="space-y-1 sm:col-span-7">
                    <Label htmlFor="studio-seed">Seed (blank = random)</Label>
                    <div className="flex gap-1.5">
                      <Input
                        id="studio-seed"
                        type="number"
                        min={0}
                        max={4294967295}
                        placeholder="Random"
                        value={seedInput}
                        onChange={(e) => setSeedInput(e.target.value)}
                        className="h-8 font-mono text-xs tabular-nums"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        title="Generate random seed"
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
                          Auto
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="space-y-1 sm:col-span-5">
                    <Label>Batch Size</Label>
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
                                ? "border-[#4A6580] bg-[#EFF3F7] text-[#3D546B]"
                                : "border-[#E7E5E0] bg-[#FFFFFF] text-[#44403C] hover:bg-[#FAF9F6]",
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
              </div>
            )}

            <Separator />

            {/* LoRA Picker */}
            {workflow?.supports_loras && (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <Label className="flex items-center gap-1.5">
                    <Layers className="h-3.5 w-3.5 text-[#78716C]" />
                    LoRAs ({selectedLoras.length}/{workflow.max_loras})
                  </Label>
                  {loras.length === 0 && (
                    <span className="text-[11px] text-[#78716C]">
                      None registered yet
                    </span>
                  )}
                </div>

                {loras.length > 0 && selectedLoras.length < workflow.max_loras && (
                  <div className="flex gap-2">
                    <Select value={loraToAdd} onValueChange={handleAddLora}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Add registered LoRA..." />
                      </SelectTrigger>
                      <SelectContent>
                        {availableLorasToAdd.map((l) => (
                          <SelectItem key={l.id} value={l.id}>
                            {l.name} ({l.source_type})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {selectedLoras.length > 0 && (
                  <div className="space-y-2">
                    {selectedLoras.map((sel) => {
                      const meta = loras.find((l) => l.id === sel.id);
                      if (!meta) return null;
                      return (
                        <div
                          key={sel.id}
                          className="rounded-md border border-[#E7E5E0] bg-[#FAF9F6] p-2.5 space-y-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-xs font-medium text-[#1C1917]">
                                {meta.name}
                              </div>
                              <div className="truncate font-mono text-[10px] text-[#78716C]">
                                {meta.filename}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="font-mono text-xs text-[#1C1917] tabular-nums">
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
                                className="rounded p-1 text-[#78716C] hover:bg-[#E7E5E0]/60 hover:text-[#A84442]"
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
                            <div className="flex items-center justify-between gap-2 pt-0.5">
                              <span className="truncate text-[10px] text-[#78716C]">
                                Triggers: <span className="font-mono">{meta.trigger_words}</span>
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  handleAppendTrigger(meta.trigger_words)
                                }
                                className="inline-flex items-center gap-0.5 text-[10px] font-medium text-[#4A6580] hover:underline shrink-0"
                              >
                                <Plus className="h-2.5 w-2.5" />
                                Insert
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* GPU Tier Selector — strictly allowed BF16 Colab accelerators */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1.5">
                  <Cpu className="h-3.5 w-3.5 text-[#78716C]" />
                  Colab GPU Tier
                </Label>
                <span className="text-[11px] text-[#78716C]">
                  BF16 accelerators only
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {allowedGpus.map((tier) => {
                  const meta = GPU_TIER_META[tier];
                  const active = gpuType === tier;
                  return (
                    <button
                      key={tier}
                      type="button"
                      onClick={() => setGpuType(tier)}
                      className={cn(
                        "rounded-md border px-2.5 py-2 text-left transition-colors",
                        active
                          ? "border-[#4A6580] bg-[#EFF3F7] text-[#1C1917]"
                          : "border-[#E7E5E0] bg-[#FFFFFF] text-[#44403C] hover:bg-[#FAF9F6]"
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-xs font-semibold">
                          {tier}
                        </span>
                        <span className="font-mono text-[10px] text-[#78716C] tabular-nums">
                          {meta.vram}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-[10px] text-[#78716C]">
                        {meta.label}
                      </div>
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-[#78716C]">
                {GPU_TIER_META[gpuType].note}
              </p>
            </div>

            <Button
              type="submit"
              disabled={
                submitting ||
                queueFull ||
                remainingQuota < batchSize ||
                !workflow
              }
              className="w-full h-10"
            >
              {submitting ? (
                <>
                  <Loader2 className="animate-spin" />
                  Queuing Job...
                </>
              ) : queueFull ? (
                `Queue Limit Reached (${user.active_queued}/${user.max_queued})`
              ) : remainingQuota < batchSize ? (
                `Daily Quota Insufficient (${remainingQuota} remaining)`
              ) : (
                <>
                  <Sparkles />
                  Generate {batchSize > 1 ? `${batchSize} Images` : "Image"} ({gpuType})
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      </form>

      {/* Right: Live Compute Stage, Preview & Queue */}
      <div className="space-y-4 lg:col-span-7">
        {gpuWarning && (
          <div
            role="status"
            className="flex items-start gap-2.5 rounded-lg border border-[#E8D7B8] bg-[#FBF5EA] px-4 py-3 text-xs text-[#9C6D2E]"
          >
            <Clock className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">Colab GPU capacity temporarily unavailable</div>
              <p className="mt-0.5">{gpuWarning}</p>
            </div>
          </div>
        )}

        {/* Active Compute & Cold-Start Timeline */}
        <Card>
          <CardHeader className="py-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-[#4A6580]" />
                <CardTitle>Live Execution &amp; Preview</CardTitle>
              </div>
              {activeManagedWorker ? (
                <div className="flex items-center gap-2">
                  <Badge variant="sage" className="font-mono">
                    {activeManagedWorker.gpu_type} · {activeManagedWorker.status}
                  </Badge>
                  <span className="text-[11px] text-[#78716C]">
                    {activeManagedWorker.account_label}
                  </span>
                </div>
              ) : (
                <Badge variant="neutral">Standby · 0 active VMs (0 CU/h)</Badge>
              )}
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            {focusedJob ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[#E7E5E0] bg-[#FAF9F6] px-3.5 py-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    {jobStatusBadge(focusedJob.status)}
                    <span className="font-mono text-xs text-[#44403C] tabular-nums">
                      {focusedJob.workflow_id}/{focusedJob.variant}
                    </span>
                    <span className="font-mono text-[11px] text-[#78716C]">
                      · {focusedJob.params.gpu_type} · seed {focusedJob.params.seed}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-[#1C1917] tabular-nums">
                      {Math.round(focusedJob.progress * 100)}%
                    </span>
                    {focusedJob.status === "queued" &&
                      (focusedJob.user_id === user.id || user.role === "admin") && (
                        <Button
                          variant="destructiveOutline"
                          size="sm"
                          disabled={cancellingId === focusedJob.id}
                          onClick={() => void handleCancelJob(focusedJob.id)}
                          className="h-7 px-2 text-[11px]"
                        >
                          Cancel
                        </Button>
                      )}
                  </div>
                </div>

                {/* Stage Timeline */}
                {focusedJob.status !== "failed" && focusedJob.status !== "cancelled" && (
                  <div className="space-y-2">
                    <div className="grid grid-cols-4 gap-2 text-[11px]">
                      {[
                        "1. Queued",
                        "2. Colab Assign",
                        "3. Bootstrap & Weights",
                        "4. Sampling & Save",
                      ].map((label, idx) => {
                        const done = stepStageIndex > idx;
                        const current = stepStageIndex === idx;
                        return (
                          <div
                            key={label}
                            className={cn(
                              "rounded-md border px-2.5 py-1.5 transition-colors",
                              done &&
                                "border-[#C5DFD0] bg-[#EEF6F1] text-[#3D7A5A]",
                              current &&
                                "border-[#CBD7E3] bg-[#EFF3F7] text-[#3D546B] font-medium",
                              !done &&
                                !current &&
                                "border-[#E7E5E0] bg-[#FFFFFF] text-[#78716C]"
                            )}
                          >
                            {label}
                          </div>
                        );
                      })}
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#E7E5E0]">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all duration-300",
                          focusedJob.status === "completed"
                            ? "bg-[#3D7A5A]"
                            : "bg-[#4A6580]"
                        )}
                        style={{
                          width: `${Math.max(
                            focusedJob.status === "queued" ? 8 : 15,
                            Math.round(focusedJob.progress * 100)
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                {focusedJob.status === "failed" && focusedJob.error_msg && (
                  <div className="flex items-start gap-2 rounded-md border border-[#E8C9C8] bg-[#FBF0F0] px-3 py-2 text-xs text-[#A84442]">
                    <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
                    <span className="break-all">{focusedJob.error_msg}</span>
                  </div>
                )}

                {/* Preview Canvas */}
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
                          className="group relative overflow-hidden rounded-lg border border-[#E7E5E0] bg-[#F5F3EE]"
                        >
                          <img
                            src={`/api/images/${imgId}/original`}
                            alt={focusedJob.params.prompt}
                            className="max-h-[520px] w-full object-contain mx-auto"
                          />
                          <div className="flex items-center justify-between border-t border-[#E7E5E0] bg-[#FFFFFF] px-3 py-2 text-[11px] text-[#78716C]">
                            <span className="font-mono tabular-nums">
                              {focusedJob.params.width}×{focusedJob.params.height}
                            </span>
                            <div className="flex items-center gap-3">
                              <a
                                href={`/api/images/${imgId}/original`}
                                download={`colab-canvas-${imgId.slice(0, 8)}.png`}
                                className="inline-flex items-center gap-1 font-medium text-[#4A6580] hover:underline"
                              >
                                PNG
                                <ExternalLink className="h-3 w-3" />
                              </a>
                              <button
                                type="button"
                                onClick={onOpenGallery}
                                className="font-medium text-[#1C1917] hover:underline"
                              >
                                Gallery →
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex min-h-[260px] flex-col items-center justify-center rounded-lg border border-dashed border-[#D6D3CB] bg-[#FAF9F6] p-6 text-center">
                    {focusedJob.status === "booting" ||
                    focusedJob.status === "running" ||
                    focusedJob.status === "queued" ? (
                      <>
                        <Loader2 className="h-6 w-6 animate-spin text-[#4A6580]" />
                        <p className="mt-2.5 text-sm font-medium text-[#1C1917]">
                          {focusedJob.status === "queued"
                            ? "Waiting in FIFO queue..."
                            : focusedJob.status === "booting"
                            ? "Provisioning Colab GPU & syncing model weights..."
                            : `Sampling artwork (${Math.round(
                                focusedJob.progress * 100
                              )}%)...`}
                        </p>
                        <p className="mt-1 max-w-md text-xs text-[#78716C] line-clamp-2">
                          {focusedJob.params.prompt}
                        </p>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="h-6 w-6 text-[#78716C]" />
                        <p className="mt-2 text-xs text-[#78716C]">
                          No preview images attached to this job ({focusedJob.status}).
                        </p>
                      </>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="flex min-h-[280px] flex-col items-center justify-center rounded-lg border border-dashed border-[#D6D3CB] bg-[#FAF9F6] p-8 text-center">
                <div
                  className="mb-3 rounded border border-[#D6D3CB] bg-[#FFFFFF] shadow-xs"
                  style={{
                    width: `${Math.max(48, Math.round((width / Math.max(width, height)) * 72))}px`,
                    height: `${Math.max(48, Math.round((height / Math.max(width, height)) * 72))}px`,
                  }}
                />
                <p className="text-sm font-medium text-[#1C1917]">
                  Ready to compose
                </p>
                <p className="mt-1 max-w-sm text-xs text-[#78716C]">
                  Write a prompt on the left and submit a job. Workers boot on-demand and shut down automatically when idle.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Queue & Recent Jobs */}
        <Card>
          <CardHeader className="py-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle>Queue &amp; Recent Jobs</CardTitle>
                <CardDescription>
                  Live status via SSE `/api/events` (queued jobs can be cancelled)
                </CardDescription>
              </div>
              <div className="flex items-center gap-1 rounded-md border border-[#E7E5E0] bg-[#FAF9F6] p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setJobScope("mine")}
                  className={cn(
                    "rounded-sm px-2.5 py-1 font-medium transition-colors",
                    jobScope === "mine"
                      ? "bg-[#FFFFFF] text-[#1C1917] shadow-2xs"
                      : "text-[#78716C] hover:text-[#1C1917]"
                  )}
                >
                  Mine
                </button>
                <button
                  type="button"
                  onClick={() => setJobScope("all")}
                  className={cn(
                    "rounded-sm px-2.5 py-1 font-medium transition-colors",
                    jobScope === "all"
                      ? "bg-[#FFFFFF] text-[#1C1917] shadow-2xs"
                      : "text-[#78716C] hover:text-[#1C1917]"
                  )}
                >
                  All ({jobs.length})
                </button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {visibleJobs.length === 0 ? (
              <div className="px-5 py-8 text-center text-xs text-[#78716C]">
                No jobs recorded yet.
              </div>
            ) : (
              <ul className="divide-y divide-[#E7E5E0]">
                {visibleJobs.slice(0, 15).map((job) => {
                  const selected = focusedJob?.id === job.id;
                  const canCancel =
                    job.status === "queued" &&
                    (job.user_id === user.id || user.role === "admin");
                  return (
                    <li
                      key={job.id}
                      className={cn(
                        "flex items-center justify-between gap-3 px-5 py-3 transition-colors",
                        selected ? "bg-[#EFF3F7]/45" : "hover:bg-[#FAF9F6]"
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedJobId(job.id)}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        {job.image_ids[0] ? (
                          <img
                            src={`/api/images/${job.image_ids[0]}/thumb`}
                            alt=""
                            className="h-10 w-10 shrink-0 rounded border border-[#E7E5E0] object-cover bg-[#F5F3EE]"
                          />
                        ) : (
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-[#E7E5E0] bg-[#F5F3EE] font-mono text-[10px] text-[#78716C] tabular-nums">
                            {Math.round(job.progress * 100)}%
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {jobStatusBadge(job.status)}
                            <span className="font-mono text-[11px] font-medium text-[#1C1917]">
                              {job.variant}
                            </span>
                            <span className="font-mono text-[10px] text-[#78716C] tabular-nums">
                              {job.params.width}×{job.params.height} ·{" "}
                              {job.params.gpu_type}
                            </span>
                            {jobScope === "all" && (
                              <span className="text-[10px] text-[#78716C]">
                                by {job.username}
                              </span>
                            )}
                            <span className="text-[10px] text-[#78716C]">
                              · {formatRelativeTime(job.created_at)}
                            </span>
                          </div>
                          <p className="mt-0.5 truncate text-xs text-[#44403C]">
                            {job.params.prompt}
                          </p>
                          {job.error_msg && (
                            <p className="mt-0.5 truncate text-[11px] text-[#A84442]">
                              {job.error_msg}
                            </p>
                          )}
                        </div>
                      </button>
                      {canCancel && (
                        <Button
                          variant="destructiveOutline"
                          size="sm"
                          disabled={cancellingId === job.id}
                          onClick={() => void handleCancelJob(job.id)}
                          className="h-7 px-2.5 text-[11px] shrink-0"
                        >
                          Cancel
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
