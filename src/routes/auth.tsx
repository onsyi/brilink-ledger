import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import {
  Loader2,
  Eye,
  EyeOff,
  Wallet,
  ArrowRight,
  Shield,
  BarChart3,
  Building2,
  Lock,
} from "lucide-react";
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
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active && data.session) navigate({ to: "/dashboard", replace: true });
    });
    return () => {
      active = false;
    };
  }, [navigate]);

  const submittingRef = useRef(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    const parsed = credsSchema.safeParse({ email, password });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Input tidak valid");
      return;
    }
    submittingRef.current = true;
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
      submittingRef.current = false;
      setBusy(false);
    }
  };

  const features = [
    {
      icon: Shield,
      title: "Manajemen shift aman",
      desc: "Buka & tutup shift dengan pencatatan otomatis",
    },
    {
      icon: BarChart3,
      title: "Laporan laba real-time",
      desc: "Pantau kas fisik, digital, dan laba bersih",
    },
    {
      icon: Building2,
      title: "Multi-cabang",
      desc: "Pantau beberapa outlet dari satu akun owner",
    },
    {
      icon: Lock,
      title: "Shift terkunci setelah ditutup",
      desc: "Data keuangan tidak bisa diubah lagi",
    },
  ];

  return (
    <div className="flex min-h-screen">
      {/* Left panel - Branding */}
      <div className="relative hidden w-1/2 flex-col items-center justify-center overflow-hidden lg:flex">
        {/* Animated background layers */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(135deg, oklch(0.22 0.045 240) 0%, oklch(0.17 0.035 245) 40%, oklch(0.14 0.03 250) 100%)",
          }}
        />
        {/* Decorative floating orbs */}
        <div
          className="absolute -left-20 -top-20 size-72 rounded-full opacity-30 blur-3xl"
          style={{ background: "oklch(0.82 0.16 82 / 30%)" }}
        />
        <div
          className="absolute -bottom-16 -right-16 size-64 rounded-full opacity-25 blur-3xl"
          style={{ background: "oklch(0.72 0.17 155 / 30%)" }}
        />
        <div
          className="absolute left-1/2 top-1/3 size-48 -translate-x-1/2 rounded-full opacity-20 blur-3xl"
          style={{ background: "oklch(0.72 0.13 205 / 30%)" }}
        />

        {/* Content */}
        <div className="relative z-10 max-w-md px-8 text-center xl:px-12">
          {/* Logo */}
          <div className="mx-auto flex size-20 items-center justify-center rounded-3xl border border-primary/25 bg-primary/15 shadow-[0_0_30px_-5px] shadow-primary/25">
            <Wallet className="size-10 text-primary" />
          </div>

          <h1 className="mt-8 font-display text-4xl font-bold xl:text-5xl">
            Kasir<span className="gradient-text-gold">BRILink</span>
          </h1>
          <p className="mt-3 text-base text-muted-foreground xl:text-lg">
            Aplikasi buatan <span className="font-semibold text-foreground">Onsyi.devpalu</span>
          </p>

          {/* Feature list */}
          <div className="mt-10 space-y-4 text-left">
            {features.map((f) => (
              <div
                key={f.title}
                className="flex items-start gap-3 rounded-xl border border-white/[0.06] bg-white/[0.04] px-4 py-3 backdrop-blur-sm"
              >
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/12">
                  <f.icon className="size-4 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">{f.title}</p>
                  <p className="text-xs text-muted-foreground">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right panel - Form */}
      <div className="flex w-full items-center justify-center px-5 py-10 sm:px-8 lg:w-1/2">
        <div className="w-full max-w-sm">
          {/* Mobile logo */}
          <Link to="/" className="mb-8 inline-flex items-center gap-2.5 lg:hidden">
            <div className="flex size-10 items-center justify-center rounded-xl border border-primary/25 bg-primary/15 shadow-[0_0_15px_-3px] shadow-primary/25">
              <Wallet className="size-5 text-primary" />
            </div>
            <span className="font-display text-xl font-bold tracking-tight">
              Kasir<span className="gradient-text-gold">BRILink</span>
            </span>
          </Link>

          {/* Login Card */}
          <div className="glass-card p-7 sm:p-8">
            <h2 className="font-display text-2xl font-bold sm:text-3xl">Selamat datang kembali</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Masuk untuk mengelola shift dan transaksi Anda.
            </p>

            <form onSubmit={submit} className="mt-7 space-y-5">
              <div className="space-y-2">
                <Label htmlFor="email" className="text-xs font-semibold text-muted-foreground">
                  Email
                </Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="nama@agen.id"
                  maxLength={255}
                  autoComplete="email"
                  required
                  className="h-11 transition-all focus-visible:ring-primary/50"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password" className="text-xs font-semibold text-muted-foreground">
                  Password
                </Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimal 6 karakter"
                    maxLength={72}
                    autoComplete="current-password"
                    className="h-11 pr-11 transition-all focus-visible:ring-primary/50"
                    required
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
              <Button type="submit" className="h-11 w-full" size="lg" disabled={busy}>
                {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
                Masuk
                {!busy && <ArrowRight className="ml-1 size-4" />}
              </Button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
