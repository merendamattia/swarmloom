import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type FactItem = {
  label: string;
  value: ReactNode;
  mono?: boolean;
  title?: string;
};

export function FactList({ items, className }: { items: FactItem[]; className?: string }) {
  return (
    <dl className={cn("fact-list", className)}>
      {items.map((item) => (
        <div className="fact-item" key={item.label}>
          <dt>{item.label}</dt>
          <dd className={item.mono ? "mono" : undefined} title={item.title}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
