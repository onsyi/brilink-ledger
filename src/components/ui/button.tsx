import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "@/lib/utils";

const variants = {
  default:
    "bg-gradient-to-r from-[oklch(0.85_0.16_82)] to-[oklch(0.78_0.16_75)] text-primary-foreground shadow-md hover:shadow-lg hover:brightness-105 active:scale-[0.98] transition-all",
  destructive:
    "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 active:scale-[0.98] transition-all",
  outline:
    "border border-border bg-card/60 backdrop-blur-md shadow-sm hover:bg-secondary hover:text-foreground hover:border-primary/40 active:scale-[0.98] transition-all",
  secondary:
    "bg-secondary/90 border border-border/80 text-secondary-foreground shadow-sm hover:bg-secondary hover:border-primary/30 active:scale-[0.98] transition-all",
  ghost: "hover:bg-secondary/70 hover:text-foreground active:scale-[0.98] transition-all",
  glass:
    "bg-secondary/40 border border-white/10 backdrop-blur-md text-foreground hover:bg-secondary/70 hover:border-white/20 active:scale-[0.98] transition-all",
  link: "text-primary underline-offset-4 hover:underline",
} as const;

const sizes = {
  default: "h-9 px-4 py-2 rounded-xl text-sm font-semibold",
  sm: "h-8 rounded-lg px-3 text-xs font-semibold",
  lg: "h-11 rounded-xl px-7 text-base font-bold",
  icon: "h-9 w-9 rounded-xl",
} as const;

type Variant = keyof typeof variants;
type Size = keyof typeof sizes;

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(
          "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold cursor-pointer transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
          variants[variant],
          sizes[size],
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button };
