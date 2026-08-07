import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Loader2, Eye, EyeOff, Wallet, ArrowRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const credsSchema = z.object({
  email: z.string().trim().email("Email tidak valid").max(255),
  password: z.string().min(6, "Password minimal 6 karakter").max(72),
});

export const Route = createFileRoute("/auth")({
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
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard", replace: true });
    });
  }, [navigate]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = credsSchema.safeParse({ email, password });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Input tidak valid");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: parsed.data.email,
        password: parsed.data.password,
      });
      if (error) throw error;
      navigate({ to: "/dashboard", replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Gagal masuk");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen">
      {/* Left panel - Branding */}
      <div className="hidden w-1/2 flex-col items-center justify-center bg-gradient-to-br from-[oklch(0.25_0.04_232)] via-[oklch(0.22_0.035_234)] to-[oklch(0.19_0.03_236)] p-8 lg:flex xl:p-12">
        <div className="text-center">
          <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-primary/20">
            <Wallet className="size-8 text-primary" />
          </div>
          <h1 className="mt-6 font-display text-3xl font-bold xl:text-4xl">Kasir BRILink</h1>
          <p className="mt-3 text-sm text-muted-foreground xl:text-base">
            Aplikasi buatan <span className="font-semibold text-foreground">Onsyi.devpalu</span>
          </p>
        </div>
      </div>

      {/* Right panel - Form */}
      <div className="flex w-full items-center justify-center px-5 py-10 sm:px-8 lg:w-1/2">
        <div className="w-full max-w-sm">
          {/* Mobile logo */}
          <Link to="/" className="mb-8 inline-flex items-center gap-2 lg:hidden">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary/20">
              <Wallet className="size-5 text-primary" />
            </div>
            <span className="font-display text-lg font-bold tracking-tight">Kasir BRILink</span>
          </Link>

          <h2 className="font-display text-2xl font-bold sm:text-3xl">Selamat datang kembali</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Masuk untuk mengelola shift dan transaksi Anda.
          </p>

          <form onSubmit={submit} className="mt-6 space-y-4 sm:mt-8">
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
                className="h-11"
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
                  autoComplete="current-password"
                  className="h-11 pr-10"
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
            <Button type="submit" className="h-11 w-full" disabled={busy}>
              {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
              Masuk
              {!busy && <ArrowRight className="ml-1 size-4" />}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
