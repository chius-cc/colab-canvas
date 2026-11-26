import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useI18n } from "@/i18n";
import {
  ApiError,
  assistantApi,
  authApi,
  jobsApi,
  lorasApi,
  poolApi,
  streamAssistantChat,
  workflowsApi,
} from "@/lib/api";
import { useEventStream } from "@/hooks/useEventStream";
import {
  sanitizeGpuTiers,
  type AssistantChatMode,
  type AssistantStatusResponse,
  type AuthMode,
  type AuthUser,
  type CanvasRecipe,
  type ChatThreadMessage,
  type ColabAccount,
  type JobRecord,
  type LoraRecord,
  type StudioContextSnapshot,
  type StudioDraft,
  type WorkerRecord,
  type WorkflowManifest,
} from "@/types/api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { AuthGate } from "@/components/AuthGate";
import { TopShell, type AppRoute } from "@/components/TopShell";
import { StudioView } from "@/components/studio/StudioView";
import { GalleryView } from "@/components/gallery/GalleryView";
import {
  PoolAdminView,
  type ConsoleTab,
} from "@/components/pool/PoolAdminView";
import { InspireView } from "@/components/assistant/InspireView";
import { FloatingCopilot } from "@/components/assistant/FloatingCopilot";

function parseHashRoute(): AppRoute {
  const raw = window.location.hash.replace(/^#\/?/, "").toLowerCase();
  if (raw === "chat") return "chat";
  if (raw === "gallery") return "gallery";
  if (raw === "pool") return "pool";
  return "studio";
}

function makeMsgId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function App() {
  const { locale, dict } = useI18n();
  const [route, setRoute] = useState<AppRoute>(() => parseHashRoute());
  const [consoleTab, setConsoleTab] = useState<ConsoleTab>("compute");

  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("hybrid");
  const [needsSetup, setNeedsSetup] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);

  const [workflows, setWorkflows] = useState<WorkflowManifest[]>([]);
  const [loras, setLoras] = useState<LoraRecord[]>([]);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [workers, setWorkers] = useState<WorkerRecord[]>([]);
  const [accounts, setAccounts] = useState<ColabAccount[]>([]);
  const [gpuWarning, setGpuWarning] = useState<string | null>(null);
  const [galleryRefreshSignal, setGalleryRefreshSignal] = useState(0);

  const [pendingDraft, setPendingDraft] = useState<StudioDraft | null>(null);
  const [studioContext, setStudioContext] =
    useState<StudioContextSnapshot | null>(null);

  // Shared Copilot state across #chat & FloatingCopilot
  const [assistantStatus, setAssistantStatus] =
    useState<AssistantStatusResponse | null>(null);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatThreadMessage[]>([]);
  const [chatStreaming, setChatStreaming] = useState(false);
  const chatAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!window.location.hash) {
      window.history.replaceState(null, "", "#studio");
    }
    const onHashChange = () => {
      setRoute(parseHashRoute());
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((next: AppRoute) => {
    const targetHash = `#${next}`;
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    }
    setRoute(next);
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      const res = await authApi.me();
      setAuthMode(res.auth_mode);
      setUser(res.user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
      }
    }
  }, []);

  const refreshJobs = useCallback(async () => {
    const res = await jobsApi.list({ limit: 50 });
    setJobs(res.jobs);
  }, []);

  const refreshLoras = useCallback(async () => {
    const res = await lorasApi.list();
    setLoras(res.loras);
  }, []);

  const refreshPool = useCallback(async () => {
    const [accRes, wrkRes] = await Promise.all([
      poolApi.listAccounts(),
      poolApi.listWorkers(),
    ]);
    setAccounts(accRes.accounts);
    setWorkers(wrkRes.workers);
  }, []);

  const refreshAssistantStatus = useCallback(async () => {
    try {
      const st = await assistantApi.status();
      setAssistantStatus(st);
    } catch {
      setAssistantStatus(null);
    }
  }, []);

  const loadWorkspaceData = useCallback(async () => {
    const [wfRes, loraRes, jobRes, accRes, wrkRes, aiRes] = await Promise.all([
      workflowsApi.list(),
      lorasApi.list(),
      jobsApi.list({ limit: 50 }),
      poolApi.listAccounts(),
      poolApi.listWorkers(),
      assistantApi.status().catch(() => null),
    ]);
    setWorkflows(wfRes.workflows);
    setLoras(loraRes.loras);
    setJobs(jobRes.jobs);
    setAccounts(accRes.accounts);
    setWorkers(wrkRes.workers);
    setAssistantStatus(aiRes);
  }, []);

  const bootstrapAuth = useCallback(async () => {
    setBooting(true);
    setBootError(null);
    setAuthError(null);
    try {
      const me = await authApi.me();
      setAuthMode(me.auth_mode);
      setNeedsSetup(false);
      setUser(me.user);
      await loadWorkspaceData();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
        try {
          const st = await authApi.status();
          setAuthMode(st.auth_mode);
          setNeedsSetup(st.needs_setup);
          if (st.auth_mode === "cloudflare") {
            setAuthError(err.detail);
          }
        } catch (stErr) {
          setBootError(
            stErr instanceof ApiError
              ? stErr.detail
              : dict.app.apiUnreachable
          );
        }
      } else {
        setBootError(
          err instanceof ApiError ? err.detail : dict.app.apiUnreachable
        );
      }
    } finally {
      setBooting(false);
    }
  }, [loadWorkspaceData, dict.app.apiUnreachable]);

  useEffect(() => {
    void bootstrapAuth();
  }, [bootstrapAuth]);

  const handleAuthenticated = useCallback(
    async (authedUser: AuthUser, mode: AuthMode) => {
      setUser(authedUser);
      setAuthMode(mode);
      setNeedsSetup(false);
      setAuthError(null);
      await loadWorkspaceData();
    },
    [loadWorkspaceData]
  );

  const handleLogout = useCallback(async () => {
    chatAbortRef.current?.abort();
    setChatStreaming(false);
    try {
      await authApi.logout();
    } finally {
      setUser(null);
      setWorkflows([]);
      setLoras([]);
      setJobs([]);
      setWorkers([]);
      setAccounts([]);
      setGpuWarning(null);
      setChatMessages([]);
      setCopilotOpen(false);
      setAssistantStatus(null);
      try {
        const st = await authApi.status();
        setAuthMode(st.auth_mode);
        setNeedsSetup(st.needs_setup);
      } catch {
        // Keep authMode
      }
    }
  }, []);

  const { state: sseState, reconnect: reconnectSse } = useEventStream(
    user !== null,
    {
      onJobUpdated: (ev) => {
        if (ev.status === "booting" || ev.status === "running") {
          setGpuWarning(null);
        }
        setJobs((prev) => {
          const idx = prev.findIndex((j) => j.id === ev.job_id);
          if (idx === -1) {
            void refreshJobs();
            return prev;
          }
          const copy = [...prev];
          const cur = copy[idx];
          const terminal =
            ev.status === "completed" ||
            ev.status === "failed" ||
            ev.status === "cancelled";
          copy[idx] = {
            ...cur,
            status: ev.status,
            progress: ev.progress !== undefined ? ev.progress : cur.progress,
            stage: terminal
              ? null
              : ev.stage !== undefined
              ? ev.stage
              : cur.stage,
            stage_detail: terminal
              ? null
              : ev.stage_detail !== undefined
              ? ev.stage_detail
              : cur.stage_detail,
            image_ids: ev.image_ids ?? cur.image_ids,
            error_msg: ev.error ?? cur.error_msg,
          };
          return copy;
        });

        if (
          ev.status === "completed" ||
          ev.status === "failed" ||
          ev.status === "cancelled"
        ) {
          void refreshJobs();
          void refreshMe();
          if (ev.status === "completed") {
            setGalleryRefreshSignal((s) => s + 1);
          }
        }
      },
      onWorkerUpdated: () => {
        void poolApi.listWorkers().then((res) => setWorkers(res.workers));
      },
      onPoolUpdated: () => {
        void refreshPool();
      },
      onPoolGpuUnavailable: (ev) => {
        setGpuWarning(
          `${ev.gpu_type} · ${ev.job_id.slice(0, 8)}`
        );
      },
      onImageCreated: () => {
        setGalleryRefreshSignal((s) => s + 1);
        void refreshMe();
      },
      onImageUploaded: () => {
        setGalleryRefreshSignal((s) => s + 1);
      },
      onImageUploadFailed: () => {
        setGalleryRefreshSignal((s) => s + 1);
      },
      onUnauthorized: () => {
        void bootstrapAuth();
      },
    }
  );

  const sendChatMessage = useCallback(
    async (text: string, mode: AssistantChatMode = "chat") => {
      const clean = text.trim();
      if (!clean || chatStreaming) return;

      const userMsg: ChatThreadMessage = {
        id: makeMsgId(),
        role: "user",
        content: clean,
      };
      const assistantId = makeMsgId();
      const placeholder: ChatThreadMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        streaming: true,
      };

      const historyPayload = [...chatMessages, userMsg].map((m) => ({
        role: m.role,
        content: m.content,
      }));

      setChatMessages((prev) => [...prev, userMsg, placeholder]);
      setChatStreaming(true);

      const controller = new AbortController();
      chatAbortRef.current = controller;

      try {
        await streamAssistantChat(
          {
            messages: historyPayload,
            locale,
            mode,
            studio_context: studioContext
              ? (studioContext as unknown as Record<string, unknown>)
              : null,
          },
          {
            signal: controller.signal,
            onDelta: (chunk) => {
              setChatMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: m.content + chunk }
                    : m
                )
              );
            },
            onDone: () => {
              setChatMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, streaming: false } : m
                )
              );
            },
            onError: (errMsg) => {
              setChatMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, streaming: false, error: errMsg }
                    : m
                )
              );
            },
          }
        );
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, streaming: false } : m
            )
          );
        } else {
          const message =
            err instanceof ApiError
              ? err.detail
              : (err as Error)?.message || "Assistant request failed";
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, streaming: false, error: message }
                : m
            )
          );
        }
      } finally {
        chatAbortRef.current = null;
        setChatStreaming(false);
        setChatMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, streaming: false } : m
          )
        );
      }
    },
    [chatMessages, chatStreaming, locale, studioContext]
  );

  const stopChatStreaming = useCallback(() => {
    chatAbortRef.current?.abort();
  }, []);

  const buildDraftFromRecipe = useCallback(
    (recipe: CanvasRecipe): StudioDraft => ({
      workflow_id: workflows[0]?.id ?? "anima",
      variant: recipe.variant,
      prompt: recipe.prompt,
      negative_prompt: recipe.negative_prompt,
      width: recipe.width,
      height: recipe.height,
      steps: recipe.steps,
      cfg: recipe.cfg,
      loras: recipe.loras?.map((l) => ({
        id: l.id,
        strength: l.strength ?? 0.8,
      })),
    }),
    [workflows]
  );

  const handleApplyRecipeFromChat = useCallback(
    (recipe: CanvasRecipe, switchToStudio: boolean) => {
      setPendingDraft(buildDraftFromRecipe(recipe));
      if (switchToStudio) {
        navigate("studio");
      }
    },
    [buildDraftFromRecipe, navigate]
  );

  const handleGenerateFromRecipe = useCallback(
    async (
      messageId: string,
      recipeIndex: number,
      recipe: CanvasRecipe
    ) => {
      if (!user) return;
      const wf = workflows[0];
      const allowedGpus = sanitizeGpuTiers(user.allowed_gpus);
      const gpuType = allowedGpus[0] ?? "L4";

      const requestedVar = recipe.variant ?? wf?.default_variant ?? "turbo";
      const spec = wf?.variants[requestedVar];
      const validVar =
        spec && (user.role === "admin" || !spec.admin_only)
          ? requestedVar
          : Object.entries(wf?.variants ?? {}).find(
              ([, v]) => user.role === "admin" || !v.admin_only
            )?.[0] ?? "turbo";

      const b = wf?.bounds;
      const clampDim = (val: number | undefined, fallback: number) => {
        if (!val) return fallback;
        const step = b?.dimension_step ?? 64;
        const min = b?.min_dimension ?? 512;
        const max = b?.max_dimension ?? 1536;
        const snapped = Math.round(val / step) * step;
        return Math.min(max, Math.max(min, snapped));
      };

      const validLoraIds = (recipe.loras ?? [])
        .filter((item) => loras.some((l) => l.id === item.id))
        .slice(0, wf?.max_loras ?? 4)
        .map((item) => ({
          id: item.id,
          strength: Math.min(2, Math.max(-2, item.strength ?? 0.8)),
        }));

      try {
        const res = await jobsApi.submit({
          workflow_id: wf?.id ?? "anima",
          variant: validVar,
          prompt: recipe.prompt,
          negative_prompt: recipe.negative_prompt ?? null,
          width: clampDim(recipe.width, 1024),
          height: clampDim(recipe.height, 1024),
          batch_size: 1,
          steps:
            recipe.steps !== undefined
              ? Math.min(
                  b?.max_steps ?? 60,
                  Math.max(b?.min_steps ?? 1, recipe.steps)
                )
              : null,
          cfg:
            recipe.cfg !== undefined
              ? Math.min(
                  b?.max_cfg ?? 12,
                  Math.max(b?.min_cfg ?? 1, recipe.cfg)
                )
              : null,
          lora_ids: validLoraIds,
          gpu_type: gpuType,
        });

        setJobs((prev) => [
          res.job,
          ...prev.filter((j) => j.id !== res.job.id),
        ]);
        setChatMessages((prev) =>
          prev.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  generatedJobs: {
                    ...(m.generatedJobs ?? {}),
                    [recipeIndex]: res.job.id,
                  },
                }
              : m
          )
        );
        void refreshMe();
      } catch (err) {
        const msg = err instanceof ApiError ? err.detail : "Submit failed";
        setChatMessages((prev) =>
          prev.map((m) =>
            m.id === messageId ? { ...m, error: msg } : m
          )
        );
      }
    },
    [user, workflows, loras, refreshMe]
  );

  const openAssistantSettings = useCallback(() => {
    setConsoleTab("assistant");
    setCopilotOpen(false);
    navigate("pool");
  }, [navigate]);

  const handleCancelJob = useCallback(
    async (jobId: string) => {
      try {
        const res = await jobsApi.cancel(jobId);
        setJobs((prev) =>
          prev.map((item) => (item.id === res.job.id ? res.job : item))
        );
        void refreshMe();
      } catch {
        // Ignore stale state errors; SSE/refresh syncs state
      }
    },
    [refreshMe]
  );

  const activeJobCount = useMemo(
    () =>
      jobs.filter(
        (j) =>
          j.status === "queued" ||
          j.status === "booting" ||
          j.status === "running"
      ).length,
    [jobs]
  );

  if (booting) {
    return (
      <div className="min-h-screen bg-[#FAF8F4] flex flex-col items-center justify-center gap-3 text-xs text-[#62666F]">
        <Loader2 className="h-5 w-5 animate-spin text-[#C85642]" />
        <span>{dict.app.connecting}</span>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="min-h-screen bg-[#FAF8F4] flex flex-col items-center justify-center p-6 text-center">
        <div className="max-w-md rounded-lg border border-[#E5E0D6] bg-[#FFFFFF] p-6 space-y-4">
          <h1 className="font-display text-base font-semibold text-[#1A1D24]">
            {dict.app.apiUnreachable}
          </h1>
          <p className="text-xs text-[#62666F]">{bootError}</p>
          <Button onClick={() => void bootstrapAuth()} size="sm">
            <RefreshCw className="h-3.5 w-3.5" />
            {dict.app.retryConnection}
          </Button>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <TooltipProvider delayDuration={200}>
        <AuthGate
          authMode={authMode}
          needsSetup={needsSetup}
          initialError={authError}
          onAuthenticated={handleAuthenticated}
          onRetryPassiveCheck={bootstrapAuth}
        />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-screen bg-[#FAF8F4] text-[#1A1D24]">
        <TopShell
          route={route}
          onNavigate={navigate}
          user={user}
          authMode={authMode}
          sseState={sseState}
          onReconnectSse={reconnectSse}
          onLogout={handleLogout}
          activeJobCount={activeJobCount}
        />

        <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6">
          {route === "chat" && (
            <InspireView
              user={user}
              assistantStatus={assistantStatus}
              messages={chatMessages}
              streaming={chatStreaming}
              jobs={jobs}
              onSendMessage={sendChatMessage}
              onStopStreaming={stopChatStreaming}
              onClearChat={() => setChatMessages([])}
              onApplyRecipeToStudio={(r) => handleApplyRecipeFromChat(r, true)}
              onGenerateFromRecipe={handleGenerateFromRecipe}
              onCancelJob={handleCancelJob}
              onOpenAssistantSettings={openAssistantSettings}
              onOpenGallery={() => navigate("gallery")}
            />
          )}

          {route === "studio" && (
            <StudioView
              user={user}
              workflows={workflows}
              loras={loras}
              jobs={jobs}
              workers={workers}
              gpuWarning={gpuWarning}
              pendingDraft={pendingDraft}
              onConsumeDraft={() => setPendingDraft(null)}
              onContextChange={setStudioContext}
              onJobSubmitted={(job) => {
                setJobs((prev) => [
                  job,
                  ...prev.filter((j) => j.id !== job.id),
                ]);
                void refreshMe();
              }}
              onJobCancelled={(job) => {
                setJobs((prev) =>
                  prev.map((item) => (item.id === job.id ? job : item))
                );
                void refreshMe();
              }}
              onOpenGallery={() => navigate("gallery")}
            />
          )}

          {route === "gallery" && (
            <GalleryView
              user={user}
              workflows={workflows}
              refreshSignal={galleryRefreshSignal}
              onRemixInStudio={(draft) => {
                setPendingDraft(draft);
                navigate("studio");
              }}
              onImageDeleted={() => {
                void refreshMe();
              }}
            />
          )}

          {route === "pool" && (
            <PoolAdminView
              user={user}
              workers={workers}
              accounts={accounts}
              loras={loras}
              activeTab={consoleTab}
              onTabChange={setConsoleTab}
              onPoolChanged={refreshPool}
              onLorasChanged={refreshLoras}
              onAssistantConfigSaved={refreshAssistantStatus}
            />
          )}
        </main>

        {route !== "chat" && (
          <FloatingCopilot
            user={user}
            open={copilotOpen}
            onOpenChange={setCopilotOpen}
            showStudioChips={route === "studio"}
            assistantStatus={assistantStatus}
            messages={chatMessages}
            streaming={chatStreaming}
            jobs={jobs}
            onSendMessage={sendChatMessage}
            onStopStreaming={stopChatStreaming}
            onApplyRecipeToStudio={(r) =>
              handleApplyRecipeFromChat(r, route !== "studio")
            }
            onGenerateFromRecipe={handleGenerateFromRecipe}
            onCancelJob={handleCancelJob}
            onExpandToInspire={() => {
              setCopilotOpen(false);
              navigate("chat");
            }}
            onOpenAssistantSettings={openAssistantSettings}
            onOpenGallery={() => {
              setCopilotOpen(false);
              navigate("gallery");
            }}
          />
        )}
      </div>
    </TooltipProvider>
  );
}

export default App;
