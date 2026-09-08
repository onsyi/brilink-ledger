import { createRouter } from "@tanstack/react-router";
import { routeTree } from "../routeTree.gen";
import { queryClient } from "./queryClient";
import { supabase } from "@/integrations/supabase/client";

export const router = createRouter({
  routeTree,
  context: { queryClient },
  scrollRestoration: true,
  defaultPreloadStaleTime: 0,
});

supabase.auth.onAuthStateChange((event) => {
  if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
  router.invalidate();
  if (event === "SIGNED_OUT") {
    queryClient.clear();
  } else {
    queryClient.invalidateQueries();
  }
});
