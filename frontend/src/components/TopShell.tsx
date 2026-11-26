import {
  Images,
  LogOut,
  MessageSquareText,
  Radio,
  SlidersHorizontal,
  Stamp,
  Wand2,
} from "lucide-react";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import type { AuthMode, AuthUser, SseConnectionState } from "@/types/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type AppRoute = "chat" | "studio" | "gallery" | "pool";

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
  const { locale, setLocale, dict } = useI18n();

  const navItems: Array<{
    id: AppRoute;
    label: string;
    href: string;
    icon: typeof Wand2;
  }> = [
    { id: "chat", label: dict.nav.inspire, href: "#chat", icon: MessageSquareText },
    { id: "studio", label: dict.nav.studio, href: "#studio", icon: Wand2 },
    { id: "gallery", label: dict.nav.gallery, href: "#gallery", icon: Images },
    { id: "pool", label: dict.nav.console, href: "#pool", icon: SlidersHorizontal },
  ];

  const sseLabel =
    sseState === "live"
      ? dict.shell.sseLive
      : sseState === "reconnecting"
      ? dict.shell.sseReconnecting
      : sseState === "connecting"
      ? dict.shell.sseConnecting
      : dict.shell.sseOffline;

  return (
    <header className="sticky top-0 z-30 border-b border-[#E5E0D6] bg-[#FAF8F4]/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
        <div className="flex flex-wrap items-center gap-4 sm:gap-6">
          <a
            href="#studio"
            onClick={(e) => {
              e.preventDefault();
              onNavigate("studio");
            }}
            className="flex items-center gap-2 text-[#1A1D24] hover:opacity-85 transition-opacity"
          >
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[#ECC5BD] bg-[#FDF1EE] text-[#C85642]">
              <Stamp className="h-4 w-4" />
            </span>
            <span className="font-display text-base font-semibold tracking-tight">
              {dict.app.brand}
            </span>
          </a>

          <nav
            aria-label="Primary navigation"
            className="flex items-center gap-1 rounded-full border border-[#E5E0D6] bg-[#F2EFE9] p-0.5"
          >
            {navItems.map((item) => {
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
                    "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                    active
                      ? "bg-[#FFFFFF] text-[#1A1D24]"
                      : "text-[#62666F] hover:text-[#1A1D24]"
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{item.label}</span>
                  {item.id === "studio" && activeJobCount > 0 && (
                    <span className="ml-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#C85642] px-1 text-[10px] font-semibold text-white tabular-nums">
                      {activeJobCount}
                    </span>
                  )}
                </a>
              );
            })}
          </nav>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
          {/* Locale Switcher */}
          <div
            className="inline-flex items-center rounded-full border border-[#E5E0D6] bg-[#F2EFE9] p-0.5 text-[11px]"
            role="group"
            aria-label={dict.shell.langToggleTooltip}
          >
            <button
              type="button"
              onClick={() => setLocale("zh")}
              className={cn(
                "rounded-full px-2 py-0.5 font-medium transition-colors",
                locale === "zh"
                  ? "bg-[#FFFFFF] text-[#1A1D24]"
                  : "text-[#62666F] hover:text-[#1A1D24]"
              )}
            >
              中
            </button>
            <button
              type="button"
              onClick={() => setLocale("en")}
              className={cn(
                "rounded-full px-2 py-0.5 font-medium transition-colors",
                locale === "en"
                  ? "bg-[#FFFFFF] text-[#1A1D24]"
                  : "text-[#62666F] hover:text-[#1A1D24]"
              )}
            >
              EN
            </button>
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onReconnectSse}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  sseState === "live" &&
                    "border-[#BBD8C9] bg-[#ECF5F0] text-[#2F6F52]",
                  (sseState === "connecting" || sseState === "reconnecting") &&
                    "border-[#E5D0AD] bg-[#FBF4E8] text-[#8D5B1B]",
                  sseState === "offline" &&
                    "border-[#EBC1BC] bg-[#FDF0EE] text-[#B43B2E]"
                )}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    sseState === "live" && "bg-[#2F6F52]",
                    (sseState === "connecting" || sseState === "reconnecting") &&
                      "bg-[#8D5B1B] animate-pulse",
                    sseState === "offline" && "bg-[#B43B2E]"
                  )}
                />
                <Radio className="h-3 w-3" />
                <span>{sseLabel}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{dict.shell.sseTooltip}</TooltipContent>
          </Tooltip>

          <div className="hidden md:flex items-center gap-2 rounded-full border border-[#E5E0D6] bg-[#FFFFFF] px-3 py-1 text-[11px] text-[#4A4E58] tabular-nums">
            <span>
              {dict.shell.quotaLabel}{" "}
              <strong className="font-mono text-[#1A1D24]">
                {user.daily_quota > 0
                  ? `${user.used_today}/${user.daily_quota}`
                  : `${user.used_today}/∞`}
              </strong>
            </span>
            <span className="h-3 w-px bg-[#E5E0D6]" />
            <span>
              {dict.shell.queueLabel}{" "}
              <strong className="font-mono text-[#1A1D24]">
                {user.active_queued}/{user.max_queued}
              </strong>
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="hidden sm:inline text-xs font-medium text-[#1A1D24]">
              {user.username}
            </span>
            <Badge variant={user.role === "admin" ? "slate" : "neutral"}>
              {user.role === "admin" ? dict.shell.roleAdmin : dict.shell.roleMember}
            </Badge>
            {authMode !== "cloudflare" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void onLogout()}
                    aria-label={dict.shell.logout}
                    className="h-7 rounded-full px-2.5 text-xs"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    <span className="hidden lg:inline">{dict.shell.logout}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{dict.shell.logout}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
