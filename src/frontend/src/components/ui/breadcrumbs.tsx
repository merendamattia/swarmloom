import { ChevronRight } from "lucide-react";
import Link from "next/link";

export function Breadcrumbs({ items, current }: { items: Array<{ href: string; label: string }>; current: string }) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      {items.map((item) => <span className="breadcrumb-item" key={item.href}><Link href={item.href}>{item.label}</Link><ChevronRight aria-hidden="true" /></span>)}
      <span aria-current="page">{current}</span>
    </nav>
  );
}
