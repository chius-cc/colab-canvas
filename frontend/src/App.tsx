import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import {
  ApiError,
  authApi,
  jobsApi,
  lorasApi,
  poolApi,
  workflowsApi,
} from "@/lib/api";
import { useEventStream } from "@/hooks/useEventStream";
import type {
  AuthMode,
  AuthUser,
  ColabAccount,
  JobRecord,
  LoraRecord,
  RemixDraft,
  WorkerRecord,
  WorkflowManifest,
} from "@/types/api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthGate } from "@/components/AuthGate";
import { TopShell, type AppRoute } from "@/components/TopShell";
import { StudioView } from "@/components/studio/StudioView";
import { GalleryView } from "@/components/gallery/GalleryView";
import { PoolAdminView } from "@/components/pool/PoolAdminView";
import { Button } from "@/components/ui/button";

function parseHashRoute(): AppRoute {
  const raw = window.location.hash.replace(/^#\/?/, "").toLowerCase();
  if (raw === "gallery") return "gallery";
  if (raw === "pool") return "pool";
  return "studio";
}

export function App() {
  const [route, setRoute] = useState<AppRoute>(() => parseHashRoute());

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
  const [remixDraft, setRemixDraft] = useState<RemixDraft | null>(null);

  // Hash navigation listener
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

  const loadWorkspaceData = useCallback(async () => {
    const [wfRes, loraRes, jobRes, accRes, wrkRes] = await Promise.all([
      workflowsApi.list(),
      lorasApi.list(),
      jobsApi.list({ limit: 50 }),
      poolApi.listAccounts(),
      poolApi.listWorkers(),
    ]);
    setWorkflows(wfRes.workflows);
    setLoras(loraRes.loras);
    setJobs(jobRes.jobs);
    setAccounts(accRes.accounts);
    setWorkers(wrkRes.workers);
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
              : "Could not reach colab-canvas backend API."
          );
        }
      } else {
        setBootError(
          err instanceof ApiError
            ? err.detail
            : "Could not connect to colab-canvas backend."
        );
      }
    } finally {
      setBooting(false);
    }
  }, [loadWorkspaceData]);

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
      try {
        const st = await authApi.status();
        setAuthMode(st.auth_mode);
        setNeedsSetup(st.needs_setup);
      } catch {
        // Keep current authMode
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
          copy[idx] = {
            ...cur,
            status: ev.status,
            progress: ev.progress !== undefined ? ev.progress : cur.progress,
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
          `Requested ${ev.gpu_type} for job ${ev.job_id.slice(
            0,
            8
          )} is temporarily unavailable across onboarded accounts. Job remains queued and will retry automatically.`
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
      <div className="min-h-screen bg-[#FAF9F6] flex flex-col items-center justify-center gap-3 text-xs text-[#78716C]">
        <Loader2 className="h-5 w-5 animate-spin text-[#4A6580]" />
        <span>Connecting to colab-canvas studio...</span>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="min-h-screen bg-[#FAF9F6] flex flex-col items-center justify-center p-6 text-center">
        <div className="max-w-md rounded-lg border border-[#E7E5E0] bg-[#FFFFFF] p-6 space-y-4">
          <h1 className="text-sm font-semibold text-[#1C1917]">
            Studio API Unreachable
          </h1>
          <p className="text-xs text-[#78716C]">{bootError}</p>
          <Button onClick={() => void bootstrapAuth()} size="sm">
            <RefreshCw className="h-3.5 w-3.5" />
            Retry Connection
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
      <div className="min-h-screen bg-[#FAF9F6] text-[#1C1917]">
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
          {route === "studio" && (
            <StudioView
              user={user}
              workflows={workflows}
              loras={loras}
              jobs={jobs}
              workers={workers}
              gpuWarning={gpuWarning}
              remixDraft={remixDraft}
              onConsumeRemixDraft={() => setRemixDraft(null)}
              onJobSubmitted={(job) => {
                setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
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
                setRemixDraft(draft);
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
              onPoolChanged={refreshPool}
              onLorasChanged={refreshLoras}
            />
          )}
        </main>
      </div>
    </TooltipProvider>
  );
}

export default App;
