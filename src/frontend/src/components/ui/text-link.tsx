import Link from "next/link";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function TextLink({ href, children, className, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) {
  return <Link className={cn("text-link", className)} href={href} {...props}>{children}</Link>;
}

export function ExternalTextLink({ href, children, className, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) {
  return <a className={cn("text-link", className)} href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>;
}
