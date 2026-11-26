import { Cpu, Images, LogOut, Radio, Sparkles, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AuthMode, AuthUser, SseConnectionState } from "@/types/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type AppRoute = "studio" | "gallery" | "pool";

interface TopShellProps {
  route: AppRoute;
  onNavigate: (route: AppRoute) => void;
  user: AuthUser;
  authMode: AuthMode;
  sseState: SseConnectionState;
  onReconnectSse: () => void;
  onLogout: () => Promise<void>;
  activeJobCount: number;
}

const NAV_ITEMS: Array<{
  id: AppRoute;
  label: string;
  href: string;
  icon: typeof Wand2;
}> = [
  { id: "studio", label: "Studio", href: "#studio", icon: Wand2 },
  { id: "gallery", label: "Gallery", href: "#gallery", icon: Images },
  { id: "pool", label: "Pool & Admin", href: "#pool", icon: Cpu },
];

export function TopShell({
  route,
  onNavigate,
  user,
  authMode,
  sseState,
  onReconnectSse,
  onLogout,
  activeJobCount,
}: TopShellProps) {
  const quotaPct =
    user.daily_quota > 0
      ? Math.min(100, Math.round((user.used_today / user.daily_quota) * 100))
      : 0;

  const sseLabel =
    sseState === "live"
      ? "Live"
      : sseState === "reconnecting"
      ? "Reconnecting"
      : sseState === "connecting"
      ? "Connecting"
      : "Offline";

  return (
    <header className="sticky top-0 z-30 border-b border-[#E7E5E0] bg-[#FFFFFF]/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
        <div className="flex items-center gap-5">
          <a
            href="#studio"
            onClick={(e) => {
              e.preventDefault();
              onNavigate("studio");
            }}
            className="flex items-center gap-2.5 text-[#1C1917] hover:opacity-85 transition-opacity"
          >
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#E7E5E0] bg-[#FAF9F6]">
              <Sparkles className="h-4 w-4 text-[#4A6580]" />
            </span>
            <div className="leading-tight">
              <span className="block text-sm font-semibold tracking-tight">
                colab-canvas
              </span>
              <span className="block text-[10px] text-[#78716C] tracking-wide">
                SOFT STUDIO · BYO COLAB
              </span>
            </div>
          </a>

          <nav aria-label="Primary navigation" className="flex items-center gap-1 rounded-md border border-[#E7E5E0] bg-[#FAF9F6] p-0.5">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = route === item.id;
              return (
                <a
                  key={item.id}
                  href={item.href}
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate(item.id);
                  }}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-medium transition-colors",
                    active
                      ? "bg-[#FFFFFF] text-[#1C1917] shadow-[0_1px_2px_rgba(28,25,23,0.06)]"
                      : "text-[#78716C] hover:text-[#1C1917]"
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{item.label}</span>
                  {item.id === "studio" && activeJobCount > 0 && (
                    <span className="ml-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#4A6580] px-1 text-[10px] font-semibold text-white tabular-nums">
                      {activeJobCount}
                    </span>
                  )}
                </a>
              );
            })}
          </nav>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onReconnectSse}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  sseState === "live" &&
                    "border-[#C5DFD0] bg-[#EEF6F1] text-[#3D7A5A]",
                  (sseState === "connecting" || sseState === "reconnecting") &&
                    "border-[#E8D7B8] bg-[#FBF5EA] text-[#9C6D2E]",
                  sseState === "offline" &&
                    "border-[#E8C9C8] bg-[#FBF0F0] text-[#A84442]"
                )}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    sseState === "live" && "bg-[#3D7A5A]",
                    (sseState === "connecting" || sseState === "reconnecting") &&
                      "bg-[#9C6D2E] animate-pulse",
                    sseState === "offline" && "bg-[#A84442]"
                  )}
                />
                <Radio className="h-3 w-3" />
                <span>SSE {sseLabel}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              Real-time `/api/events` stream ({sseLabel}). Click to reconnect.
            </TooltipContent>
          </Tooltip>

          <div className="flex items-center gap-2.5 rounded-md border border-[#E7E5E0] bg-[#FAF9F6] px-2.5 py-1">
            <div className="flex flex-col min-w-[96px]">
              <div className="flex items-center justify-between gap-2 text-[10px] text-[#78716C]">
                <span>Daily Quota</span>
                <span className="font-mono font-medium text-[#1C1917] tabular-nums">
                  {user.daily_quota > 0
                    ? `${user.used_today}/${user.daily_quota}`
                    : `${user.used_today} / ∞`}
                </span>
              </div>
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[#E7E5E0]">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    user.daily_quota > 0 && quotaPct >= 90
                      ? "bg-[#A84442]"
                      : "bg-[#4A6580]"
                  )}
                  style={{
                    width:
                      user.daily_quota > 0 ? `${Math.max(4, quotaPct)}%` : "18%",
                  }}
                />
              </div>
            </div>
            <span className="h-5 w-px bg-[#E7E5E0]" />
            <div className="text-[11px] text-[#44403C] tabular-nums">
              Queue{" "}
              <span className="font-mono font-medium text-[#1C1917]">
                {user.active_queued}/{user.max_queued}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="text-right leading-tight hidden sm:block">
              <div className="text-xs font-medium text-[#1C1917]">
                {user.username}
              </div>
              <div className="text-[10px] text-[#78716C]">{user.email}</div>
            </div>
            <Badge variant={user.role === "admin" ? "slate" : "neutral"}>
              {user.role}
            </Badge>
            {authMode !== "cloudflare" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void onLogout()}
                    aria-label="Sign out"
                    className="h-8 px-2.5 text-xs"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    <span className="hidden md:inline">Logout</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Sign out of local session</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
