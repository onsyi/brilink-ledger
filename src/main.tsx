import "./styles.css";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { Toaster } from "@/components/ui/sonner";
import { supabase } from "@/integrations/supabase/client";
import { useOfflineSync } from "@/hooks/useOfflineSync";
import { useRealtimeRefresh } from "@/hooks/useRealtimeRefresh";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

const router = createRouter({
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

function OfflineSyncProvider({ children }: { children: React.ReactNode }) {
  useOfflineSync();
  return <>{children}</>;
}

function RealtimeRefresh() {
  const queryClient = useQueryClient();
  useRealtimeRefresh(queryClient);
  return null;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <OfflineSyncProvider>
        <RealtimeRefresh />
        <RouterProvider router={router} />
        <Toaster richColors position="top-center" />
      </OfflineSyncProvider>
    </QueryClientProvider>
  );
}

const rootElement = document.getElementById("root")!;
import("react-dom/client").then(({ createRoot }) => {
  createRoot(rootElement).render(<App />);
});
