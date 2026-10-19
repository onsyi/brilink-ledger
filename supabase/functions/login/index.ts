/**
 * Edge Function `login` — sign-in dengan email ATAU username.
 *
 * Dibuat untuk menutup temuan K-1 (supabase/AUDIT.md). Sebelumnya browser
 * memanggil resolve_login_email() sendiri untuk menerjemahkan username menjadi
 * email, dan fungsi itu harus di-GRANT ke `anon` agar bisa dipanggil sebelum
 * login. Akibatnya siapa pun yang memegang publishable key — yaitu siapa pun,
 * karena key itu ada di dalam bundle JavaScript — bisa memanen alamat email
 * setiap akun hanya dengan menebak username.
 *
 * Di sini penerjemahannya terjadi di server:
 *
 *   browser  --{identifier, password}-->  Edge Function
 *                                            |- resolve_login_email()  (service_role)
 *                                            |- POST /auth/v1/token    (publishable key)
 *   browser  <--{access_token, refresh_token}-/
 *
 * Email tidak pernah ikut dikembalikan. Sign-in tetap lewat endpoint GoTrue
 * yang normal memakai publishable key, jadi rate limit dan seluruh kebijakan
 * password project tetap berlaku — tidak ada verifikasi password yang
 * diimplementasikan ulang di sini.
 *
 * Tidak memakai supabase-js: dua panggilan HTTP biasa sudah cukup, dan sebuah
 * endpoint login lebih baik tanpa dependensi yang perlu di-pin versinya.
 *
 * Deploy (tidak terbawa oleh git push ke Vercel — ini berjalan di Supabase):
 *
 *   supabase functions deploy login --no-verify-jwt
 *
 * `--no-verify-jwt` wajib: pemanggilnya belum punya JWT, itu justru intinya.
 * Konfigurasi yang sama sudah dicatat di supabase/config.toml untuk `supabase
 * start` lokal.
 */

type LoginBody = {
  identifier?: unknown;
  password?: unknown;
};

/**
 * Satu-satunya pesan galat yang pernah dikirim untuk kredensial yang tidak
 * cocok. Dibedakan antara "username tidak ada" dan "password salah" akan
 * mengembalikan orakel keberadaan akun yang justru sedang kita tutup.
 */
const GENERIC_CREDENTIAL_ERROR = "Email/username atau password salah.";

// Login tidak bergantung pada cookie atau kredensial ambient, jadi `*` di sini
// tidak memberi situs lain kemampuan yang tidak bisa mereka dapatkan dari
// server mereka sendiri. Persempit ke origin produksi kalau nanti diinginkan.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

/**
 * Nama `SUPABASE_*` disuntikkan platform, tapi project ini memakai key gaya
 * baru dan JWT anon/service_role lama sudah dimatikan (lihat AGENTS.md). Jadi
 * nama BRILINK_* didahulukan: `supabase secrets set` menolak nama berawalan
 * `SUPABASE_`, sehingga key gaya baru memang harus diberi nama lain.
 */
function readEnv(preferred: string, injected: string): string | undefined {
  return Deno.env.get(preferred) || Deno.env.get(injected) || undefined;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json(405, { error: "Metode tidak diizinkan" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = readEnv("BRILINK_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY");
  const secretKey = readEnv("BRILINK_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !publishableKey || !secretKey) {
    // Salah konfigurasi, bukan salah pengguna — dan jangan sebut nama key mana
    // yang hilang ke pemanggil yang belum terautentikasi.
    console.error("[login] Konfigurasi tidak lengkap", {
      hasUrl: !!supabaseUrl,
      hasPublishableKey: !!publishableKey,
      hasSecretKey: !!secretKey,
    });
    return json(500, { error: "Layanan masuk belum dikonfigurasi. Hubungi admin." });
  }

  let body: LoginBody;
  try {
    body = (await req.json()) as LoginBody;
  } catch {
    return json(400, { error: "Permintaan tidak valid" });
  }

  const identifier = typeof body.identifier === "string" ? body.identifier.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  // Cermin dari credsSchema di src/routes/auth.tsx. Diulang di sini karena
  // validasi klien hanya nasihat: endpoint ini terbuka ke internet.
  if (identifier.length < 3 || identifier.length > 255) {
    return json(400, { error: "Masukkan email atau username" });
  }
  if (password.length < 6 || password.length > 72) {
    return json(400, { error: "Password minimal 6 karakter" });
  }

  let email = identifier;

  if (!identifier.includes("@")) {
    const resolved = await fetch(`${supabaseUrl}/rest/v1/rpc/resolve_login_email`, {
      method: "POST",
      headers: {
        apikey: secretKey,
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ identifier }),
    });

    if (!resolved.ok) {
      const detail = await resolved.text();
      console.error("[login] resolve_login_email gagal", resolved.status, detail);
      // 401/403 di sini berarti secret key-nya salah atau sudah mati, bukan
      // gangguan sesaat. Project ini mematikan JWT anon/service_role lama
      // (lihat AGENTS.md), jadi SUPABASE_SERVICE_ROLE_KEY yang disuntikkan
      // platform TIDAK berfungsi di sini: BRILINK_SECRET_KEY wajib diisi key
      // gaya baru `sb_secret_...`. Dibedakan supaya pesannya menunjuk ke
      // konfigurasi, bukan menyuruh kasir "coba lagi" tanpa akhir.
      if (resolved.status === 401 || resolved.status === 403) {
        return json(500, {
          error: "Layanan masuk belum dikonfigurasi dengan benar. Hubungi admin.",
        });
      }
      return json(500, { error: "Gagal memproses permintaan masuk. Coba lagi." });
    }

    // Fungsinya mengembalikan NULL untuk username yang tidak terdaftar. Dalam
    // kasus itu identifier diteruskan apa adanya ke GoTrue, yang akan
    // menolaknya: satu jalur kode untuk "username tidak ada" dan "password
    // salah", sehingga keduanya tidak terbedakan dari luar — baik lewat isi
    // jawabannya maupun lewat lama waktunya.
    const payload: unknown = await resolved.json();
    if (typeof payload === "string" && payload.length > 0) {
      email = payload;
    }
  }

  // Sengaja memakai publishable key, bukan secret key: sign-in harus menempuh
  // jalur GoTrue yang sama dengan pengguna biasa, lengkap dengan rate limit dan
  // pemeriksaan banned_until (akun yang dinonaktifkan owner).
  const tokenResponse = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: publishableKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });

  if (!tokenResponse.ok) {
    const detail = await tokenResponse.text();
    // 400 dari GoTrue berarti kredensial salah; apa pun selain itu adalah
    // masalah di sisi kami dan tidak boleh tampil sebagai "password salah".
    if (tokenResponse.status === 400) {
      return json(401, { error: GENERIC_CREDENTIAL_ERROR });
    }
    if (tokenResponse.status === 429) {
      return json(429, { error: "Terlalu banyak percobaan masuk. Tunggu sebentar." });
    }
    // GoTrue memakai 400 untuk kredensial salah dan 401 untuk apikey yang tidak
    // diterima — jadi 401 di sini adalah publishable key yang salah atau mati,
    // bukan password kasir yang keliru.
    if (tokenResponse.status === 401) {
      return json(500, {
        error: "Layanan masuk belum dikonfigurasi dengan benar. Hubungi admin.",
      });
    }
    console.error("[login] GoTrue menolak", tokenResponse.status, detail);
    return json(502, { error: "Layanan masuk sedang bermasalah. Coba lagi." });
  }

  const session = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
  };

  if (!session.access_token || !session.refresh_token) {
    console.error("[login] GoTrue tidak mengembalikan token");
    return json(502, { error: "Layanan masuk sedang bermasalah. Coba lagi." });
  }

  // Hanya token. Tidak ada email, tidak ada objek user — klien mendapatkannya
  // sendiri dari sesi setelah setSession().
  return json(200, {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
});
