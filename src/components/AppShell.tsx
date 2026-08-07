import type { ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import {
  LayoutDashboard,
  ClipboardCheck,
  BarChart3,
  LogOut,
  Wallet,
  WifiOff,
  Loader2,
  Settings,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useSessionTimeout } from "@/hooks/useSessionTimeout";
import { SessionTimeoutDialog } from "@/components/SessionTimeoutDialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getAllPending, isOnline } from "@/lib/offline-db";

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

  useEffect(() => {
    const check = async () => {
      setOnline(isOnline());
      const pending = await getAllPending();
      setCount(pending.length);
    };
    check();
    const interval = setInterval(check, 5000);
    const onOnline = () => check();
    const onOffline = () => check();
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      clearInterval(interval);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  if (online && count === 0) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
        !online
          ? "border border-warning/50 bg-warning/10 text-warning"
          : "border border-primary/50 bg-primary/10 text-primary",
      )}
    >
      {!online ? <WifiOff className="size-3" /> : <Loader2 className="size-3 animate-spin" />}
      {!online ? "Offline" : `Sync ${count}`}
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { username, role } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isOwner = role === "owner";
  const items = nav.filter((item) => {
    if ("cashierOnly" in item && item.cashierOnly && isOwner) return false;
    if ("ownerOnly" in item && item.ownerOnly && !isOwner) return false;
    return true;
  });

  const signOut = async () => {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  };

  const handleTimeout = useCallback(() => {
    signOut();
  }, []);

  const { showWarning, extendSession } = useSessionTimeout(handleTimeout);

  return (
    <div className="min-h-screen pb-16 md:pb-0">
      <SessionTimeoutDialog open={showWarning} onExtend={extendSession} onLogout={handleTimeout} />
      {/* Desktop header */}
      <header className="sticky top-0 z-20 hidden border-b border-border bg-background/85 backdrop-blur md:block">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3 lg:px-6">
          <Link to="/" className="shrink-0 font-display text-base font-semibold">
            Kasir<span className="text-primary">BRILink</span>
          </Link>
          <nav className="ml-4 flex items-center gap-1">
            {items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
                  pathname === item.to && "bg-secondary text-foreground",
                )}
              >
                <item.icon className="size-4" />
                {isOwner && "ownerLabel" in item ? item.ownerLabel : item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <OfflineBadge />
            <div className="text-right text-xs leading-tight">
              <div className="font-medium">{username ?? "—"}</div>
              <div className="text-muted-foreground uppercase">{role ?? ""}</div>
            </div>
            <Button size="sm" variant="secondary" onClick={signOut}>
              <LogOut className="size-4" />
              <span className="sr-only">Keluar</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur md:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Link to="/" className="font-display text-base font-semibold">
            Kasir<span className="text-primary">BRILink</span>
          </Link>
          <div className="flex items-center gap-2">
            <OfflineBadge />
            <span className="text-xs text-muted-foreground">{username ?? "—"}</span>
            <Button size="sm" variant="ghost" onClick={signOut} className="h-8 w-8 p-0">
              <LogOut className="size-4" />
              <span className="sr-only">Keluar</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-5 sm:py-7 lg:px-6">{children}</main>

      {/* Mobile bottom nav */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 border-t border-border bg-background/95 backdrop-blur md:hidden">
        <div className="flex items-center justify-around px-2 py-1.5">
          {items.map((item) => {
            const active = pathname === item.to;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex flex-1 flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[10px] transition-colors",
                  active ? "text-primary" : "text-muted-foreground active:bg-secondary",
                )}
              >
                <item.icon className="size-5" />
                <span>{isOwner && "ownerLabel" in item ? item.ownerLabel : item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
