import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Loader2, Eye, EyeOff, KeyRound, ArrowRight, TriangleAlert } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const passwordSchema = z
  .string()
  .min(10, "Password minimal 10 karakter")
  .max(72)
  .regex(/[a-zA-Z]/, "Password harus memuat huruf")
  .regex(/[0-9]/, "Password harus memuat angka");

export const Route = createFileRoute("/reset-password")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Atur Password Baru — Kasir BRILink" },
      { name: "description", content: "Atur password baru untuk akun Kasir BRILink." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ResetPasswordPage,
});

/**
 * Landing page for the Supabase password-recovery email.
 *
 * resetPasswordForEmail() was already being sent from Pengaturan, but its link
 * pointed at the site root, which redirects straight to /dashboard — the cashier
 * ended up signed in with no way to actually choose a new password. This route
 * consumes the recovery session and completes the flow.
 */
function ResetPasswordPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"checking" | "ready" | "invalid">("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;

    // supabase-js consumes the token from the URL hash while initialising and
    // then emits PASSWORD_RECOVERY, so listen before asking for the session.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === "PASSWORD_RECOVERY" || session) setStatus("ready");
    });

    supabase.auth.getSession().then(
      ({ data }) => {
        if (active) setStatus(data.session ? "ready" : "invalid");
      },
      () => {
        if (active) setStatus("invalid");
      },
    );

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Password tidak valid");
      return;
    }
    if (password !== confirm) {
      toast.error("Konfirmasi password tidak cocok");
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setBusy(false);
      toast.error(error.message);
      return;
    }
    // Sign out so the new password is actually exercised on the next sign-in.
    await supabase.auth.signOut();
    setBusy(false);
    toast.success("Password berhasil diubah. Silakan masuk dengan password baru.");
    navigate({ to: "/auth", replace: true });
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="glass-card p-7 sm:p-8">
          <div className="flex size-12 items-center justify-center rounded-2xl border border-primary/25 bg-primary/15 shadow-[0_0_20px_-5px] shadow-primary/25">
            {status === "invalid" ? (
              <TriangleAlert className="size-6 text-destructive" />
            ) : (
              <KeyRound className="size-6 text-primary" />
            )}
          </div>

          {status === "checking" && (
            <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Memeriksa tautan…
            </div>
          )}

          {status === "invalid" && (
            <>
              <h1 className="mt-5 font-display text-2xl font-bold">Tautan tidak berlaku</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Tautan reset password sudah kedaluwarsa atau pernah dipakai. Minta owner mengirim
                ulang email reset.
              </p>
              <Button asChild className="mt-6 w-full">
                <Link to="/auth">
                  Kembali ke halaman masuk <ArrowRight className="ml-1 size-4" />
                </Link>
              </Button>
            </>
          )}

          {status === "ready" && (
            <>
              <h1 className="mt-5 font-display text-2xl font-bold">Atur Password Baru</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Masukkan password baru untuk akun Anda.
              </p>

              <form onSubmit={submit} className="mt-7 space-y-5">
                <div className="space-y-2">
                  <Label
                    htmlFor="new-password"
                    className="text-xs font-semibold text-muted-foreground"
                  >
                    Password baru
                  </Label>
                  <div className="relative">
                    <Input
                      id="new-password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Password minimal 10 karakter, memuat huruf dan angka"
                      maxLength={72}
                      autoComplete="new-password"
                      required
                      className="h-11 pr-11"
                    />
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label
                    htmlFor="confirm-password"
                    className="text-xs font-semibold text-muted-foreground"
                  >
                    Ulangi password baru
                  </Label>
                  <Input
                    id="confirm-password"
                    type={showPassword ? "text" : "password"}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="Ulangi password"
                    maxLength={72}
                    autoComplete="new-password"
                    required
                    className="h-11"
                  />
                </div>

                <Button type="submit" className="h-11 w-full" size="lg" disabled={busy}>
                  {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
                  Simpan password
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
