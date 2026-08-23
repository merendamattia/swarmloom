import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "default" | "compact" | "icon";

const variants: Record<ButtonVariant, string> = {
  primary: "border-primary bg-primary text-primary-foreground hover:border-primary-hover hover:bg-primary-hover",
  secondary: "border-border bg-card text-foreground hover:border-foreground/30 hover:bg-muted",
  danger: "border-danger/45 bg-card text-danger hover:border-danger hover:bg-danger-soft",
  ghost: "border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
};

const sizes: Record<ButtonSize, string> = {
  default: "min-h-11 px-4 py-2.5",
  compact: "min-h-9 px-3 py-2",
  icon: "size-11 p-0",
};

export function buttonClassName({
  variant = "secondary",
  size = "default",
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}) {
  return cn(
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border text-[0.8125rem] font-semibold leading-none no-underline transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out [font-family:var(--font-sans)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
    variants[variant],
    sizes[size],
    className,
  );
}

export function Button({
  className,
  variant,
  size,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button className={buttonClassName({ variant, size, className })} type={type} {...props} />;
}

export function ButtonLink({
  className,
  variant,
  size,
  href,
  external,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  external?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const styles = buttonClassName({ variant, size, className });
  if (external || href.startsWith("http")) {
    return <a className={styles} href={href} target="_blank" rel="noreferrer" {...props} />;
  }
  return <Link className={styles} href={href} {...props} />;
}

export function IconButton({
  label,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & { label: string }) {
  return <Button aria-label={label} size="icon" variant="ghost" {...props} />;
}
