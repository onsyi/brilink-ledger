import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/useTheme";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={toggleTheme}
      title={isDark ? "Mode terang" : "Mode gelap"}
      aria-label={isDark ? "Aktifkan mode terang" : "Aktifkan mode gelap"}
      className="hover:bg-secondary/60"
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
      <span className="sr-only">Ganti tema</span>
    </Button>
  );
}
