import { useState, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, KeyRound, RefreshCw, ShieldCheck, Sparkles, UserPlus } from "lucide-react";
import { ApiError, authApi } from "@/lib/api";
import type { AuthMode, AuthUser } from "@/types/api";
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
  const [tab, setTab] = useState<"login" | "register">("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  // Setup fields
  const [setupEmail, setSetupEmail] = useState("");
  const [setupUsername, setSetupUsername] = useState("");
  const [setupPassword, setSetupPassword] = useState("");

  // Login fields
  const [identifier, setIdentifier] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  // Register fields
  const [inviteCode, setInviteCode] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regUsername, setRegUsername] = useState("");
  const [regPassword, setRegPassword] = useState("");

  const handleSetup = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!setupEmail.trim().includes("@")) {
      setError("Enter a valid admin email address.");
      return;
    }
    if (setupUsername.trim().length < 2) {
      setError("Username must be at least 2 characters.");
      return;
    }
    if (setupPassword.length < 8) {
      setError("Password must be at least 8 characters.");
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
      setError(err instanceof ApiError ? err.detail : "Failed to initialize admin.");
    } finally {
      setBusy(false);
    }
  };

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!identifier.trim()) {
      setError("Enter your email or username.");
      return;
    }
    if (!loginPassword) {
      setError("Enter your password.");
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
      setError(err instanceof ApiError ? err.detail : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleRegister = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (inviteCode.trim().length < 4) {
      setError("Enter a valid invite code (at least 4 characters).");
      return;
    }
    if (!regEmail.trim().includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    if (regUsername.trim().length < 2) {
      setError("Username must be at least 2 characters.");
      return;
    }
    if (regPassword.length < 8) {
      setError("Password must be at least 8 characters.");
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
      setError(err instanceof ApiError ? err.detail : "Registration failed.");
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
      setError(err instanceof ApiError ? err.detail : "Unable to verify Cloudflare Access.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#FAF9F6] px-4 py-12 flex flex-col items-center justify-center">
      <div className="w-full max-w-md space-y-5">
        <div className="flex flex-col items-center text-center space-y-2">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-[#E7E5E0] bg-[#FFFFFF] shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
            <Sparkles className="h-5 w-5 text-[#4A6580]" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-[#1C1917]">
              colab-canvas
            </h1>
            <p className="text-xs text-[#78716C]">
              Self-hosted AI studio &amp; on-demand Colab GPU pool
            </p>
          </div>
          <Badge variant="slate" className="uppercase tracking-wider text-[10px]">
            auth_mode: {authMode}
          </Badge>
        </div>

        {authMode === "cloudflare" ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-[#4A6580]" />
                Cloudflare Access Required
              </CardTitle>
              <CardDescription>
                Local sign-in is disabled. Access this instance through your Cloudflare Zero Trust tunnel so your Access JWT is passed automatically.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-[#E8C9C8] bg-[#FBF0F0] px-3 py-2 text-xs text-[#A84442]"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
              <Button
                onClick={handleRetryCf}
                disabled={busy}
                className="w-full"
              >
                <RefreshCw className={busy ? "animate-spin" : ""} />
                {busy ? "Checking Access Token..." : "Retry Cloudflare Access Check"}
              </Button>
            </CardContent>
          </Card>
        ) : needsSetup ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-[#4A6580]" />
                Initialize Studio Administrator
              </CardTitle>
              <CardDescription>
                No users exist in this database yet. Create the first admin account to configure Colab accounts and invite codes.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSetup} className="space-y-3.5" noValidate>
                {error && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-md border border-[#E8C9C8] bg-[#FBF0F0] px-3 py-2 text-xs text-[#A84442]"
                  >
                    <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>{error}</span>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="setup-email">Admin Email</Label>
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
                  <Label htmlFor="setup-username">Username</Label>
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
                  <Label htmlFor="setup-password">Password (min 8 chars)</Label>
                  <Input
                    id="setup-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder="••••••••••••"
                    value={setupPassword}
                    onChange={(e) => setSetupPassword(e.target.value)}
                    required
                  />
                </div>
                <Button type="submit" disabled={busy} className="w-full">
                  {busy ? "Creating Admin..." : "Create Administrator & Enter"}
                </Button>
              </form>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle>Sign in to Studio</CardTitle>
                  <CardDescription>
                    {authMode === "hybrid"
                      ? "Cloudflare Access JWTs sign in passively; or use local credentials / invite code."
                      : "Authenticate with your local credentials or an invite code."}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {authMode === "hybrid" && (
                <div className="flex items-center justify-between gap-2 rounded-md border border-[#CBD7E3] bg-[#EFF3F7] px-3 py-2 text-xs text-[#3D546B]">
                  <span className="flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    Behind Cloudflare Access? Retry passive SSO.
                  </span>
                  <button
                    type="button"
                    onClick={handleRetryCf}
                    disabled={busy}
                    className="font-medium underline underline-offset-2 hover:text-[#1C1917] disabled:opacity-50"
                  >
                    Check SSO
                  </button>
                </div>
              )}

              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-[#E8C9C8] bg-[#FBF0F0] px-3 py-2 text-xs text-[#A84442]"
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
                    Sign In
                  </TabsTrigger>
                  <TabsTrigger value="register">
                    <UserPlus className="h-3.5 w-3.5" />
                    Invite Register
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="login">
                  <form onSubmit={handleLogin} className="space-y-3.5 pt-1" noValidate>
                    <div className="space-y-1.5">
                      <Label htmlFor="login-identifier">Username or Email</Label>
                      <Input
                        id="login-identifier"
                        autoComplete="username"
                        placeholder="artist or artist@example.com"
                        value={identifier}
                        onChange={(e) => setIdentifier(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="login-password">Password</Label>
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
                      {busy ? "Signing in..." : "Sign In"}
                    </Button>
                  </form>
                </TabsContent>

                <TabsContent value="register">
                  <form onSubmit={handleRegister} className="space-y-3 pt-1" noValidate>
                    <div className="space-y-1.5">
                      <Label htmlFor="reg-invite">Invite Code</Label>
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
                      <Label htmlFor="reg-email">Email</Label>
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
                      <Label htmlFor="reg-username">Username</Label>
                      <Input
                        id="reg-username"
                        autoComplete="username"
                        placeholder="studio-member"
                        value={regUsername}
                        onChange={(e) => setRegUsername(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="reg-password">Password (min 8 chars)</Label>
                      <Input
                        id="reg-password"
                        type="password"
                        autoComplete="new-password"
                        placeholder="••••••••••••"
                        value={regPassword}
                        onChange={(e) => setRegPassword(e.target.value)}
                        required
                      />
                    </div>
                    <Button type="submit" disabled={busy} className="w-full">
                      {busy ? "Creating account..." : "Redeem Invite & Join"}
                    </Button>
                  </form>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        )}

        <p className="text-center text-[11px] text-[#78716C]">
          0 active Colab VMs when idle · Outbox-backed artwork storage
        </p>
      </div>
    </div>
  );
}
