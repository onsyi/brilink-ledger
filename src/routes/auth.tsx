import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Loader2, LockKeyhole, Eye, EyeOff } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const searchSchema = z.object({
  mode: z.enum(["signin", "signup"]).catch("signin"),
});

const credsSchema = z.object({
  email: z.string().trim().email("Email tidak valid").max(255),
  password: z.string().min(6, "Password minimal 6 karakter").max(72),
  username: z.string().trim().min(3, "Username minimal 3 karakter").max(40).optional(),
});

export const Route = createFileRoute("/auth")({
  validateSearch: searchSchema,
  head: () => ({
    meta: [
      { title: "Masuk — Kasir BRILink" },
      {
        name: "description",
        content: "Masuk sebagai owner atau kasir untuk membuka shift dan mencatat transaksi.",
      },
      { property: "og:title", content: "Masuk — Kasir BRILink" },
      { property: "og:description", content: "Autentikasi agen BRILink & PPOB." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const { mode } = Route.useSearch();
  const navigate = useNavigate();
  const [isSignup, setIsSignup] = useState(mode === "signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentConfirm, setSentConfirm] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard", replace: true });
    });
  }, [navigate]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = credsSchema.safeParse({
      email,
      password,
      username: isSignup ? username : undefined,
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Input tidak valid");
      return;
    }
    setBusy(true);
    try {
      if (isSignup) {
        const { data, error } = await supabase.auth.signUp({
          email: parsed.data.email,
          password: parsed.data.password,
          options: {
            emailRedirectTo: window.location.origin,
            data: { username: parsed.data.username },
          },
        });
        if (error) throw error;
        if (!data.session) {
          setSentConfirm(true);
          toast.success("Akun dibuat. Cek email untuk konfirmasi.");
        } else {
          navigate({ to: "/dashboard", replace: true });
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: parsed.data.email,
          password: parsed.data.password,
        });
        if (error) throw error;
        navigate({ to: "/dashboard", replace: true });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Gagal memproses permintaan");
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    setBusy(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin,
      },
    });
    if (error) {
      setBusy(false);
      toast.error("Gagal masuk dengan Google");
      return;
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10 sm:px-5 sm:py-12">
      <div className="ledger-card w-full max-w-md p-5 sm:p-7">
        <Link to="/" className="text-xs text-muted-foreground hover:text-foreground">
          ← Kasir BRILink
        </Link>
        <h1 className="mt-4 flex items-center gap-2 text-xl font-semibold sm:text-2xl">
          <LockKeyhole className="size-5 text-primary" />
          {isSignup ? "Buat akun" : "Masuk"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Akun pertama yang mendaftar otomatis menjadi Owner. Akun berikutnya menjadi Kasir.
        </p>

        {sentConfirm ? (
          <p className="mt-6 rounded-lg border border-border bg-secondary/50 p-4 text-sm">
            Konfirmasi terkirim ke <span className="font-medium">{email}</span>. Klik tautan di email
            tersebut, lalu masuk kembali.
          </p>
        ) : (
          <form onSubmit={submit} className="mt-5 space-y-3 sm:mt-6 sm:space-y-4">
            {isSignup && (
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="kasir_pagi"
                  maxLength={40}
                  autoComplete="username"
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="nama@agen.id"
                maxLength={255}
                autoComplete="email"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimal 6 karakter"
                  maxLength={72}
                  autoComplete={isSignup ? "new-password" : "current-password"}
                  className="pr-10"
                  required
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
              {isSignup ? "Daftar" : "Masuk"}
            </Button>
          </form>
        )}

        <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground sm:my-5">
          <span className="h-px flex-1 bg-border" /> atau <span className="h-px flex-1 bg-border" />
        </div>
        <Button variant="secondary" className="w-full" onClick={google} disabled={busy}>
          Lanjut dengan Google
        </Button>

        <button
          type="button"
          onClick={() => {
            setSentConfirm(false);
            setIsSignup((v) => !v);
          }}
          className="mt-5 w-full text-center text-sm text-muted-foreground hover:text-foreground sm:mt-6"
        >
          {isSignup ? "Sudah punya akun? Masuk" : "Belum punya akun? Daftar"}
        </button>
      </div>
    </main>
  );
}
