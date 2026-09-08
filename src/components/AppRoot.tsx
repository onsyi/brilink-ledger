import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { queryClient } from "@/lib/queryClient";
import { router } from "@/lib/router";
import { Toaster } from "@/components/ui/sonner";
import { useRealtimeRefresh } from "@/hooks/useRealtimeRefresh";

function RealtimeRefresh() {
  const queryClient = useQueryClient();
  useRealtimeRefresh(queryClient);
  return null;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RealtimeRefresh />
      <RouterProvider router={router} />
      <Toaster richColors position="top-center" />
    </QueryClientProvider>
  );
}
