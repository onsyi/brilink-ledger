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
        // supabase-js resolves with { data, error } instead of rejecting, so the
        // errors have to be re-thrown explicitly. Swallowing them here would
        // silently downgrade an owner to "cashier" on any transient failure.
        const [rolesResult, profileResult] = await Promise.all([
          supabase.from("user_roles").select("role").eq("user_id", session.user.id),
          supabase
            .from("profiles")
            .select("username, branch_id, is_active")
            .eq("id", session.user.id)
            .maybeSingle(),
        ]);
        if (rolesResult.error) throw rolesResult.error;
        if (profileResult.error) throw profileResult.error;
        const roleRows = rolesResult.data;
        const profile = profileResult.data;

        let branchName: string | null = null;
        if (profile?.branch_id) {
          // Cosmetic only — a failure here must not block sign-in.
          const { data: branch, error: branchError } = await supabase
            .from("branches")
            .select("name")
            .eq("id", profile.branch_id)
            .maybeSingle();
          if (branchError) console.warn("[useAuth] Failed to load branch:", branchError.message);
          branchName = branch?.name ?? null;
        }

        if (!active) return;
        const roles = (roleRows ?? []).map((r) => r.role as AppRole);
        const role = roles.includes("owner") ? "owner" : (roles[0] ?? null);
        const isActive = profile?.is_active ?? true;

        let authError: string | null = null;
        if (!isActive) {
          authError = "Akun Anda telah dinonaktifkan. Hubungi owner untuk mengaktifkan kembali.";
        } else if (!role) {
          authError = "Akun Anda belum memiliki role. Hubungi owner untuk mengaktifkan akses.";
        }

        setState({
          loading: false,
          error: authError,
          user: session.user,
          session,
          role: isActive ? role : null,
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
