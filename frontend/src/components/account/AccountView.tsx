import { useState, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, KeyRound, Shield } from "lucide-react";
import { useI18n } from "@/i18n";
import { ApiError, authApi } from "@/lib/api";
import { sanitizeGpuTiers, type AuthUser } from "@/types/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface AccountViewProps {
  user: AuthUser;
  embedded?: boolean;
}

export function AccountView({ user, embedded = false }: AccountViewProps) {
  const { dict } = useI18n();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const gpus = sanitizeGpuTiers(user.allowed_gpus);
  const hasPassword = user.has_password !== false;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (newPassword.length < 8) {
      setError(dict.account.passwordTooShort);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(dict.account.passwordMismatch);
      return;
    }

    setBusy(true);
    try {
      await authApi.changePassword({
        current_password: currentPassword,
        new_password: newPassword,
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess(dict.account.passwordUpdated);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Password update failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={embedded ? "grid grid-cols-1 gap-5 lg:grid-cols-2" : "mx-auto max-w-3xl space-y-5"}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4 text-[#3E5C76]" />
            {dict.account.profileTitle}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-xs">
            <div className="rounded-md border border-[#E5E0D6] bg-[#FAF8F4] px-3 py-2.5">
              <span className="block text-[11px] text-[#62666F]">
                {dict.account.username}
              </span>
              <span className="mt-0.5 block font-medium text-[#1A1D24]">
                {user.username}
              </span>
            </div>

            <div className="rounded-md border border-[#E5E0D6] bg-[#FAF8F4] px-3 py-2.5">
              <span className="block text-[11px] text-[#62666F]">
                {dict.account.email}
              </span>
              <span className="mt-0.5 block font-mono text-[#1A1D24] truncate">
                {user.email}
              </span>
            </div>

            <div className="rounded-md border border-[#E5E0D6] bg-[#FAF8F4] px-3 py-2.5">
              <span className="block text-[11px] text-[#62666F]">
                {dict.account.role}
              </span>
              <div className="mt-1">
                <Badge variant={user.role === "admin" ? "slate" : "neutral"}>
                  {user.role === "admin" ? dict.shell.roleAdmin : dict.shell.roleMember}
                </Badge>
              </div>
            </div>

            <div className="rounded-md border border-[#E5E0D6] bg-[#FAF8F4] px-3 py-2.5">
              <span className="block text-[11px] text-[#62666F]">
                {dict.account.dailyQuota}
              </span>
              <span className="mt-0.5 block font-mono font-semibold text-[#1A1D24] tabular-nums">
                {user.daily_quota > 0
                  ? `${user.used_today} / ${user.daily_quota}`
                  : `${user.used_today} / ${dict.account.unlimited}`}
              </span>
            </div>

            <div className="rounded-md border border-[#E5E0D6] bg-[#FAF8F4] px-3 py-2.5">
              <span className="block text-[11px] text-[#62666F]">
                {dict.account.maxQueued}
              </span>
              <span className="mt-0.5 block font-mono font-semibold text-[#1A1D24] tabular-nums">
                {user.active_queued} / {user.max_queued}
              </span>
            </div>

            <div className="rounded-md border border-[#E5E0D6] bg-[#FAF8F4] px-3 py-2.5">
              <span className="block text-[11px] text-[#62666F]">
                {dict.account.allowedGpus}
              </span>
              <div className="mt-1 flex flex-wrap gap-1">
                {gpus.map((g) => (
                  <Badge key={g} variant="neutral" className="font-mono text-[10px]">
                    {g}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4 text-[#C85642]" />
            {dict.account.changePasswordTitle}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!hasPassword ? (
            <div className="rounded-md border border-[#E5E0D6] bg-[#FAF8F4] px-3.5 py-3 text-xs text-[#62666F]">
              {dict.account.ssoNoPassword}
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3.5">
              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-[#EBC1BC] bg-[#FDF0EE] px-3 py-2 text-xs text-[#B43B2E]"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              {success && (
                <div
                  role="status"
                  className="flex items-center gap-2 rounded-md border border-[#BBD8C9] bg-[#ECF5F0] px-3 py-2 text-xs text-[#2F6F52]"
                >
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>{success}</span>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="acc-cur-pw">{dict.account.currentPassword}</Label>
                <Input
                  id="acc-cur-pw"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="acc-new-pw">{dict.account.newPassword}</Label>
                <Input
                  id="acc-new-pw"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="acc-confirm-pw">{dict.account.confirmPassword}</Label>
                <Input
                  id="acc-confirm-pw"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>

              <div className="flex justify-end pt-1">
                <Button type="submit" disabled={busy}>
                  {busy ? dict.account.updatingPassword : dict.account.submitPassword}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
