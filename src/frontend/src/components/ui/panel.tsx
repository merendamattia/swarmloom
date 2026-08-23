import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Panel({ as: Component = "section", className, ...props }: HTMLAttributes<HTMLElement> & { as?: "section" | "aside" | "article" | "div" }) {
  return <Component className={cn("panel", className)} {...props} />;
}

export function PanelDivider({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("panel-divider", className)} role="separator" {...props} />;
}
