import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

function createSupabaseClient() {
  // `process` does not exist in the browser bundle. Referencing it directly
  // threw "process is not defined" the moment a VITE_ var was missing, which
  // pre-empted the helpful message below with an opaque ReferenceError.
  const nodeEnv: Record<string, string | undefined> =
    typeof process !== "undefined" && process.env ? process.env : {};

  const CLIENT_SUPABASE_URL = "https://lxqgsbgmvsmkqjctfkoc.supabase.co";
  const CLIENT_SUPABASE_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx4cWdzYmdtdnNta3FqY3Rma29jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg3OTU4NDUsImV4cCI6MjEwNDM3MTg0NX0.ZxBPJOX0NoTNhMBHVNuiDrA5tKFI2St2CV_hl0uiwzU";

  const rawUrl = import.meta.env["VITE_SUPABASE_URL"] || nodeEnv["SUPABASE_URL"];
  const rawKey =
    import.meta.env["VITE_SUPABASE_ANON_KEY"] ||
    import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ||
    nodeEnv["SUPABASE_ANON_KEY"] ||
    nodeEnv["SUPABASE_PUBLISHABLE_KEY"];

  // If Vercel has the old deprecated project cached, override with client project
  const isOldProject = rawUrl && rawUrl.includes("blrazbccxocnhtpskjll");

  const SUPABASE_URL = !rawUrl || isOldProject ? CLIENT_SUPABASE_URL : rawUrl;
  const SUPABASE_ANON_KEY = !rawKey || isOldProject ? CLIENT_SUPABASE_KEY : rawKey;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    const missing = [
      ...(!SUPABASE_URL ? ["SUPABASE_URL"] : []),
      ...(!SUPABASE_ANON_KEY ? ["SUPABASE_ANON_KEY"] : []),
    ];
    const message = `Missing Supabase environment variable(s): ${missing.join(", ")}. Please configure your .env file.`;
    console.error(`[Supabase] ${message}`);
    throw new Error(message);
  }

  return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      // sessionStorage, bukan localStorage: terminal toko dipegang bergantian,
      // dan token yang bertahan melewati penutupan browser berarti kasir
      // berikutnya membuka aplikasi sebagai orang sebelumnya. Ongkosnya login
      // ulang setiap browser dibuka — di sini itu justru yang diinginkan,
      // karena pergantian browser biasanya menandai pergantian orang.
      // Idle timeout 30 menit di useSessionTimeout tetap berlaku di dalam sesi.
      storage: typeof window !== "undefined" ? sessionStorage : undefined,
      persistSession: true,
      autoRefreshToken: true,
    },
  });
}

let _supabase: ReturnType<typeof createSupabaseClient> | undefined;

export const supabase = new Proxy({} as ReturnType<typeof createSupabaseClient>, {
  get(_, prop, receiver) {
    if (!_supabase) _supabase = createSupabaseClient();
    return Reflect.get(_supabase, prop, receiver);
  },
});
