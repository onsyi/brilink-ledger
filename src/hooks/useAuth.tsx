import { useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export type AppRole = "owner" | "cashier";

export type AuthState = {
  loading: boolean;
  user: User | null;
  session: Session | null;
  role: AppRole | null;
  username: string | null;
};

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    loading: true,
    user: null,
    session: null,
    role: null,
    username: null,
  });

  useEffect(() => {
    let active = true;

    const hydrate = async (session: Session | null) => {
      if (!session?.user) {
        if (active)
          setState({ loading: false, user: null, session: null, role: null, username: null });
        return;
      }
      try {
        const [{ data: roleRows }, { data: profile }] = await Promise.all([
          supabase.from("user_roles").select("role").eq("user_id", session.user.id),
          supabase.from("profiles").select("username").eq("id", session.user.id).maybeSingle(),
        ]);
        if (!active) return;
        const roles = (roleRows ?? []).map((r) => r.role as AppRole);
        setState({
          loading: false,
          user: session.user,
          session,
          role: roles.includes("owner") ? "owner" : (roles[0] ?? "cashier"),
          username: profile?.username ?? session.user.email ?? null,
        });
      } catch {
        if (!active) return;
        // On network error, still set user but default to cashier to avoid privilege escalation
        setState({
          loading: false,
          user: session.user,
          session,
          role: "cashier",
          username: session.user.email ?? null,
        });
      }
    };

    supabase.auth.getSession().then(({ data }) => void hydrate(data.session));
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
