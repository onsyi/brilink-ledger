import { useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export type AppRole = "owner" | "cashier";

export type AuthState = {
  loading: boolean;
  error: string | null;
  user: User | null;
  session: Session | null;
  role: AppRole | null;
  username: string | null;
  branchId: string | null;
  branchName: string | null;
};

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    loading: true,
    error: null,
    user: null,
    session: null,
    role: null,
    username: null,
    branchId: null,
    branchName: null,
  });

  useEffect(() => {
    let active = true;

    const hydrate = async (session: Session | null) => {
      if (!session?.user) {
        if (active)
          setState({
            loading: false,
            error: null,
            user: null,
            session: null,
            role: null,
            username: null,
            branchId: null,
            branchName: null,
          });
        return;
      }
      try {
        const [{ data: roleRows }, { data: profile }] = await Promise.all([
          supabase.from("user_roles").select("role").eq("user_id", session.user.id),
          supabase
            .from("profiles")
            .select("username, branch_id")
            .eq("id", session.user.id)
            .maybeSingle(),
        ]);

        let branchName: string | null = null;
        if (profile?.branch_id) {
          const { data: branch } = await supabase
            .from("branches")
            .select("name")
            .eq("id", profile.branch_id)
            .maybeSingle();
          branchName = branch?.name ?? null;
        }

        if (!active) return;
        const roles = (roleRows ?? []).map((r) => r.role as AppRole);
        setState({
          loading: false,
          error: null,
          user: session.user,
          session,
          role: roles.includes("owner") ? "owner" : (roles[0] ?? "cashier"),
          username: profile?.username ?? session.user.email ?? null,
          branchId: profile?.branch_id ?? null,
          branchName,
        });
      } catch (err) {
        if (!active) return;
        console.error("[useAuth] Failed to load profile:", err);
        setState({
          loading: false,
          error: "Gagal memuat data akun. Silakan coba lagi.",
          user: session.user,
          session,
          role: null,
          username: session.user.email ?? null,
          branchId: null,
          branchName: null,
        });
      }
    };

    supabase.auth.getSession().then(
      ({ data }) => void hydrate(data.session),
      () => void hydrate(null),
    );
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      void hydrate(session);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}
