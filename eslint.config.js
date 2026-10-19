import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // supabase/functions berjalan di Deno, bukan di browser: globals, resolusi
  // modul, dan toolchain-nya berbeda. Dikecualikan agar aturan browser di bawah
  // tidak menilainya dengan asumsi yang salah.
  { ignores: ["dist", ".output", ".vinxi", "supabase/functions"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // Dinyalakan setelah audit menemukan belasan import mati (lucide-react,
      // helper ledger, hook react-query) yang ikut terbawa ke bundle dan
      // menyesatkan pembaca soal apa yang sebenarnya dipakai di satu file.
      // Argumen & variabel berawalan "_" tetap diizinkan untuk parameter yang
      // memang harus ada demi posisinya.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  eslintPluginPrettier,
);
