import type { ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LayoutDashboard,
  ClipboardCheck,
  BarChart3,
  LogOut,
  Wallet,
  WifiOff,
  Loader2,
  Settings,
  ShieldCheck,
  UserCircle,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useSessionTimeout } from "@/hooks/useSessionTimeout";
import { SessionTimeoutDialog } from "@/components/SessionTimeoutDialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getAllPending, isOnline, clearPending } from "@/lib/offline-db";

const nav = [
  { to: "/dashboard", label: "Shift", icon: LayoutDashboard, ownerLabel: "Ringkasan" },
  { to: "/close-shift", label: "Tutup Shift", icon: ClipboardCheck, cashierOnly: true },
  { to: "/deposits", label: "Setoran", icon: Wallet },
  { to: "/reports", label: "Laporan", icon: BarChart3, ownerOnly: true },
  { to: "/settings", label: "Pengaturan", icon: Settings },
] as const;

function OfflineBadge() {
  const [count, setCount] = useState(0);
  const [online, setOnline] = useState(isOnline());
  const countRef = useRef(0);
  countRef.current = count;

  useEffect(() => {
    let active = true;
    const check = async () => {
      if (!active) return;
      setOnline(isOnline());
      const pending = await getAllPending();
      if (active) setCount(pending.length);
    };
    check();

    // Only poll when offline or when there are pending items
    let interval: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (interval) return;
      interval = setInterval(async () => {
        const p = await getAllPending();
        if (!active) return;
        setCount(p.length);
        setOnline(isOnline());
        // Stop polling once back online and no pending items
        if (isOnline() && p.length === 0 && interval) {
          clearInterval(interval);
          interval = null;
        }
      }, 10000);
    };

    const onOnline = () => {
      check();
      startPolling();
    };
    const onOffline = () => {
      check();
      startPolling();
    };

    // Start polling immediately if offline or has pending
    if (!isOnline() || countRef.current > 0) startPolling();

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      active = false;
      if (interval) clearInterval(interval);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  if (online && count === 0) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-wide backdrop-blur-sm transition-all",
        !online
          ? "border border-warning/40 bg-warning/10 text-warning animate-pulse"
          : "border border-primary/40 bg-primary/10 text-primary shadow-[0_0_10px_-3px] shadow-primary/30",
      )}
    >
      {!online ? <WifiOff className="size-3" /> : <Loader2 className="size-3 animate-spin" />}
      {!online ? "Offline" : `Sync ${count}`}
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { username, role, branchName, error } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isOwner = role === "owner";
  const items = useMemo(
    () =>
      nav.filter((item) => {
        if ("cashierOnly" in item && item.cashierOnly && isOwner) return false;
        if ("ownerOnly" in item && item.ownerOnly && !isOwner) return false;
        return true;
      }),
    [isOwner],
  );

  const signOut = async () => {
    await queryClient.cancelQueries();
    queryClient.clear();
    clearPending();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  };

  const signOutRef = useRef(signOut);
  signOutRef.current = signOut;

  const handleTimeout = useCallback(() => {
    signOutRef.current();
  }, []);

  const { showWarning, extendSession } = useSessionTimeout(handleTimeout);

  return (
    <div className="min-h-screen pb-24 md:pb-0">
      <SessionTimeoutDialog open={showWarning} onExtend={extendSession} onLogout={handleTimeout} />
      {error && (
        <div className="bg-destructive/10 border-b border-destructive/20 px-4 py-2.5 text-center text-sm text-destructive backdrop-blur-sm">
          {error}
        </div>
      )}

      {/* Desktop header */}
      <header className="sticky top-0 z-20 hidden border-b border-white/[0.06] bg-background/70 backdrop-blur-xl md:block">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-4 px-4 py-3 lg:px-6">
          <Link to="/" className="shrink-0 font-display text-lg font-bold tracking-tight">
            Kasir<span className="gradient-text-gold">BRILink</span>
          </Link>

          <nav className="ml-4 flex items-center gap-1">
            {items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium text-muted-foreground transition-all duration-200 hover:bg-secondary/80 hover:text-foreground",
                  pathname === item.to &&
                    "bg-primary/12 text-primary shadow-[0_0_12px_-4px] shadow-primary/30 font-semibold",
                )}
              >
                <item.icon className="size-4" />
                {isOwner && "ownerLabel" in item ? item.ownerLabel : item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <OfflineBadge />
            <div className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-secondary/50 px-3 py-1.5 backdrop-blur-sm">
              <div className="flex size-7 items-center justify-center rounded-lg bg-primary/15">
                {isOwner ? (
                  <ShieldCheck className="size-3.5 text-primary" />
                ) : (
                  <UserCircle className="size-3.5 text-primary" />
                )}
              </div>
              <div className="text-right text-xs leading-tight">
                <div className="font-semibold">{username ?? "—"}</div>
                <div className="text-[10px] text-muted-foreground">{branchName ?? role ?? ""}</div>
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={signOut}
              className="hover:bg-destructive/10 hover:text-destructive"
            >
              <LogOut className="size-4" />
              <span className="sr-only">Keluar</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 border-b border-white/[0.06] bg-background/70 backdrop-blur-xl md:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Link to="/" className="font-display text-lg font-bold tracking-tight">
            Kasir<span className="gradient-text-gold">BRILink</span>
          </Link>
          <div className="flex items-center gap-2">
            <OfflineBadge />
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-secondary/50 px-2.5 py-1 text-[11px] font-medium text-muted-foreground backdrop-blur-sm">
              {isOwner ? (
                <ShieldCheck className="size-3 text-primary" />
              ) : (
                <UserCircle className="size-3 text-primary" />
              )}
              {branchName ?? username ?? "—"}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={signOut}
              className="h-8 w-8 p-0 hover:bg-destructive/10 hover:text-destructive"
            >
              <LogOut className="size-4" />
              <span className="sr-only">Keluar</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-5 sm:py-7 lg:px-6">{children}</main>

      {/* Mobile bottom nav — floating dock */}
      <nav className="fixed bottom-3 left-3 right-3 z-30 glass-card rounded-2xl shadow-[0_8px_30px_-8px_oklch(0.05_0.03_240_/_70%)] md:hidden">
        <div className="flex items-center justify-around px-2 py-2">
          {items.map((item) => {
            const active = pathname === item.to;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex flex-1 flex-col items-center gap-1 rounded-xl px-1 py-2 text-[10px] font-medium transition-all duration-200",
                  active
                    ? "text-primary"
                    : "text-muted-foreground active:scale-95 active:bg-secondary/50",
                )}
              >
                <div className="relative">
                  <item.icon
                    className={cn(
                      "size-5",
                      active && "drop-shadow-[0_0_6px_oklch(0.82_0.16_82_/_50%)]",
                    )}
                  />
                  {active && (
                    <span className="absolute -bottom-1.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-primary shadow-[0_0_6px_2px] shadow-primary/40" />
                  )}
                </div>
                <span className={cn(active && "font-semibold")}>
                  {isOwner && "ownerLabel" in item ? item.ownerLabel : item.label}
                </span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
