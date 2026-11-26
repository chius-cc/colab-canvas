import { useState, type FormEvent } from "react";
import {
  AlertCircle,
  CheckCircle2,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Stamp,
  UserPlus,
} from "lucide-react";
import { useI18n } from "@/i18n";
import { ApiError, authApi } from "@/lib/api";
import type { AuthMode, AuthUser } from "@/types/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface AuthGateProps {
  authMode: AuthMode;
  needsSetup: boolean;
  initialError?: string | null;
  onAuthenticated: (user: AuthUser, mode: AuthMode) => void;
  onRetryPassiveCheck: () => Promise<void>;
}

export function AuthGate({
  authMode,
  needsSetup,
  initialError,
  onAuthenticated,
  onRetryPassiveCheck,
}: AuthGateProps) {
  const { locale, setLocale, dict } = useI18n();
  const [tab, setTab] = useState<"login" | "register">("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  const [setupEmail, setSetupEmail] = useState("");
  const [setupUsername, setSetupUsername] = useState("");
  const [setupPassword, setSetupPassword] = useState("");

  const [identifier, setIdentifier] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  const [inviteCode, setInviteCode] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regUsername, setRegUsername] = useState("");
  const [regPassword, setRegPassword] = useState("");

  const handleSetup = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!setupEmail.trim().includes("@")) {
      setError(dict.auth.errInvalidEmail);
      return;
    }
    if (setupUsername.trim().length < 2) {
      setError(dict.auth.errShortUser);
      return;
    }
    if (setupPassword.length < 8) {
      setError(dict.auth.errShortPassword);
      return;
    }
    setBusy(true);
    try {
      const res = await authApi.setup({
        email: setupEmail.trim(),
        username: setupUsername.trim(),
        password: setupPassword,
      });
      onAuthenticated(res.user, authMode);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Setup failed");
    } finally {
      setBusy(false);
    }
  };

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!identifier.trim()) {
      setError(dict.auth.errEmptyIdentifier);
      return;
    }
    if (!loginPassword) {
      setError(dict.auth.errEmptyPassword);
      return;
    }
    setBusy(true);
    try {
      const res = await authApi.login({
        identifier: identifier.trim(),
        password: loginPassword,
      });
      onAuthenticated(res.user, authMode);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  const handleRegister = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (inviteCode.trim().length < 4) {
      setError(dict.auth.errShortInvite);
      return;
    }
    if (!regEmail.trim().includes("@")) {
      setError(dict.auth.errInvalidEmail);
      return;
    }
    if (regUsername.trim().length < 2) {
      setError(dict.auth.errShortUser);
      return;
    }
    if (regPassword.length < 8) {
      setError(dict.auth.errShortPassword);
      return;
    }
    setBusy(true);
    try {
      const res = await authApi.register({
        invite_code: inviteCode.trim(),
        email: regEmail.trim(),
        username: regUsername.trim(),
        password: regPassword,
      });
      onAuthenticated(res.user, authMode);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Registration failed");
    } finally {
      setBusy(false);
    }
  };

  const handleRetryCf = async () => {
    setError(null);
    setBusy(true);
    try {
      await onRetryPassiveCheck();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "SSO verification failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#FAF8F4] px-4 py-8 flex flex-col justify-between">
      <div className="flex justify-end">
        <div
          className="inline-flex items-center rounded-full border border-[#E5E0D6] bg-[#FFFFFF] p-0.5 text-xs"
          role="group"
          aria-label={dict.shell.langToggleTooltip}
        >
          <button
            type="button"
            onClick={() => setLocale("zh")}
            className={`rounded-full px-2.5 py-1 font-medium transition-colors ${
              locale === "zh"
                ? "bg-[#1A1D24] text-white"
                : "text-[#62666F] hover:text-[#1A1D24]"
            }`}
          >
            中
          </button>
          <button
            type="button"
            onClick={() => setLocale("en")}
            className={`rounded-full px-2.5 py-1 font-medium transition-colors ${
              locale === "en"
                ? "bg-[#1A1D24] text-white"
                : "text-[#62666F] hover:text-[#1A1D24]"
            }`}
          >
            EN
          </button>
        </div>
      </div>

      <div className="mx-auto w-full max-w-[400px] space-y-6 my-auto">
        <div className="flex flex-col items-center text-center space-y-2">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-[#ECC5BD] bg-[#FDF1EE] text-[#C85642]">
            <Stamp className="h-5 w-5" />
          </div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-[#1A1D24]">
            {dict.app.brand}
          </h1>
          <p className="text-xs text-[#62666F]">{dict.auth.subtitle}</p>
        </div>

        <div className="rounded-lg border border-[#E5E0D6] bg-[#FFFFFF] p-6 space-y-4">
          {authMode === "cloudflare" ? (
            <div className="space-y-4">
              <div className="space-y-1">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-[#1A1D24]">
                  <ShieldCheck className="h-4 w-4 text-[#3E5C76]" />
                  {dict.auth.cfTitle}
                </h2>
                <p className="text-xs text-[#62666F]">{dict.auth.cfDesc}</p>
              </div>
              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-[#EBC1BC] bg-[#FDF0EE] px-3 py-2 text-xs text-[#B43B2E]"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
              <Button onClick={handleRetryCf} disabled={busy} className="w-full">
                <RefreshCw className={busy ? "animate-spin" : ""} />
                {busy ? dict.auth.cfChecking : dict.auth.cfRetry}
              </Button>
            </div>
          ) : needsSetup ? (
            <form onSubmit={handleSetup} className="space-y-4" noValidate>
              <div className="space-y-1">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-[#1A1D24]">
                  <KeyRound className="h-4 w-4 text-[#C85642]" />
                  {dict.auth.setupTitle}
                </h2>
                <p className="text-xs text-[#62666F]">{dict.auth.setupDesc}</p>
              </div>
              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-[#EBC1BC] bg-[#FDF0EE] px-3 py-2 text-xs text-[#B43B2E]"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="setup-email">{dict.auth.setupEmail}</Label>
                <Input
                  id="setup-email"
                  type="email"
                  autoComplete="email"
                  placeholder="admin@studio.local"
                  value={setupEmail}
                  onChange={(e) => setSetupEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="setup-username">{dict.auth.setupUsername}</Label>
                <Input
                  id="setup-username"
                  autoComplete="username"
                  placeholder="admin"
                  value={setupUsername}
                  onChange={(e) => setSetupUsername(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="setup-password">{dict.auth.setupPassword}</Label>
                <Input
                  id="setup-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="••••••••"
                  value={setupPassword}
                  onChange={(e) => setSetupPassword(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" disabled={busy} className="w-full">
                {busy ? dict.auth.setupCreating : dict.auth.setupSubmit}
              </Button>
            </form>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-[#1A1D24]">
                    {dict.auth.signInTitle}
                  </h2>
                  <p className="text-xs text-[#62666F]">
                    {authMode === "hybrid"
                      ? dict.auth.signInDescHybrid
                      : dict.auth.signInDescLocal}
                  </p>
                </div>
                <Badge variant="slate" className="font-mono text-[10px]">
                  {authMode}
                </Badge>
              </div>

              {authMode === "hybrid" && (
                <div className="flex items-center justify-between gap-2 rounded-md border border-[#C8D5E1] bg-[#EFF3F7] px-3 py-2 text-xs text-[#3E5C76]">
                  <span className="flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    {dict.auth.hybridHint}
                  </span>
                  <button
                    type="button"
                    onClick={handleRetryCf}
                    disabled={busy}
                    className="font-medium underline underline-offset-2 hover:text-[#1A1D24] disabled:opacity-50"
                  >
                    {dict.auth.checkSso}
                  </button>
                </div>
              )}

              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-[#EBC1BC] bg-[#FDF0EE] px-3 py-2 text-xs text-[#B43B2E]"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <Tabs
                value={tab}
                onValueChange={(v) => {
                  setError(null);
                  setTab(v as "login" | "register");
                }}
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="login">
                    <KeyRound className="h-3.5 w-3.5" />
                    {dict.auth.tabSignIn}
                  </TabsTrigger>
                  <TabsTrigger value="register">
                    <UserPlus className="h-3.5 w-3.5" />
                    {dict.auth.tabRegister}
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="login">
                  <form onSubmit={handleLogin} className="space-y-3" noValidate>
                    <div className="space-y-1.5">
                      <Label htmlFor="login-identifier">
                        {dict.auth.identifier}
                      </Label>
                      <Input
                        id="login-identifier"
                        autoComplete="username"
                        placeholder={dict.auth.identifierPlaceholder}
                        value={identifier}
                        onChange={(e) => setIdentifier(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="login-password">{dict.auth.password}</Label>
                      <Input
                        id="login-password"
                        type="password"
                        autoComplete="current-password"
                        placeholder="••••••••"
                        value={loginPassword}
                        onChange={(e) => setLoginPassword(e.target.value)}
                        required
                      />
                    </div>
                    <Button type="submit" disabled={busy} className="w-full">
                      {busy ? dict.auth.signingIn : dict.auth.signInBtn}
                    </Button>
                  </form>
                </TabsContent>

                <TabsContent value="register">
                  <form onSubmit={handleRegister} className="space-y-3" noValidate>
                    <div className="space-y-1.5">
                      <Label htmlFor="reg-invite">{dict.auth.inviteCode}</Label>
                      <Input
                        id="reg-invite"
                        placeholder="cc-..."
                        className="font-mono text-xs"
                        value={inviteCode}
                        onChange={(e) => setInviteCode(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="reg-email">{dict.auth.email}</Label>
                      <Input
                        id="reg-email"
                        type="email"
                        autoComplete="email"
                        placeholder="you@example.com"
                        value={regEmail}
                        onChange={(e) => setRegEmail(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="reg-username">{dict.auth.username}</Label>
                      <Input
                        id="reg-username"
                        autoComplete="username"
                        placeholder="artist"
                        value={regUsername}
                        onChange={(e) => setRegUsername(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="reg-password">{dict.auth.password}</Label>
                      <Input
                        id="reg-password"
                        type="password"
                        autoComplete="new-password"
                        placeholder="••••••••"
                        value={regPassword}
                        onChange={(e) => setRegPassword(e.target.value)}
                        required
                      />
                    </div>
                    <Button type="submit" disabled={busy} className="w-full">
                      {busy ? dict.auth.registering : dict.auth.registerBtn}
                    </Button>
                  </form>
                </TabsContent>
              </Tabs>
            </div>
          )}
        </div>
      </div>

      <div />
    </div>
  );
}
