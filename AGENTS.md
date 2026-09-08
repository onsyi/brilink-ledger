# AGENTS

Project guidelines for BRILink Ledger.

## Commands

- `npm run dev` — Vite dev server
- `npm run build` — production build (Vite)
- `npm run lint` — ESLint (must be clean before commit)
- `npm run typecheck` — `tsc --noEmit` (must be clean before commit)
- `npm run format` — Prettier (SQL files excluded)
- `npm test` — unit tests for `src/lib/ledger.test.ts` (requires Bun; test file uses extensionless imports)

## Architecture notes

- Accounting rules (Saldo Awal/Akhir, Laba, FBI, FS) live in `src/lib/ledger.ts`. The same formulas are enforced server-side by Supabase RPCs (`supabase/migrations/`). Keep both sides in sync — PPOB is deliberately excluded from Saldo Awal/Akhir.
- The database is the authority: RLS + `SECURITY DEFINER` RPCs enforce the balance chain between shifts (per branch) and the immutability of closed shifts (triggers + `brilink.audit_override`). Never write financial data via direct SQL on production.
- Supabase API keys: the project uses the new-style keys — `VITE_SUPABASE_PUBLISHABLE_KEY` (client) — legacy anon/service_role JWTs are disabled.
- Deployment: Vercel (SPA rewrite in `vercel.json`); schema changes go through `supabase/migrations/` and must also be registered in `supabase_migrations.schema_migrations`.
