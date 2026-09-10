import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

function createSupabaseClient() {
  // `process` does not exist in the browser bundle. Referencing it directly
  // threw "process is not defined" the moment a VITE_ var was missing, which
  // pre-empted the helpful message below with an opaque ReferenceError.
  const nodeEnv: Record<string, string | undefined> =
    typeof process !== "undefined" && process.env ? process.env : {};

  const CLIENT_SUPABASE_URL = "https://blrazbccxocnhtpskjll.supabase.co";
  const CLIENT_SUPABASE_KEY = "sb_publishable_ANNCG0Gfhqs8uAEvMnIXOg_7qEU_uff";

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
