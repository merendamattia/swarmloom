"use client";

import { Activity, GitBranch, LayoutDashboard, ListChecks, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/jobs", label: "Jobs", icon: ListChecks },
  { href: "/repositories", label: "Repositories", icon: GitBranch },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="app-frame">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <header className="app-header">
        <div className="header-inner">
          <Link href="/" className="brand" aria-label="GitHub Agent Worker overview">
            <span className="brand-mark" aria-hidden="true"><Activity size={18} /></span>
            <span className="brand-name">GitHub Agent Worker</span>
          </Link>
          <nav className="primary-nav" aria-label="Primary navigation">
            {links.map(({ href, label, icon: Icon }) => {
              const active = href === "/" ? pathname === href : pathname.startsWith(href);
              return (
                <Link key={href} href={href} className="nav-link" aria-current={active ? "page" : undefined}>
                  <Icon size={16} aria-hidden="true" />
                  <span>{label}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main id="main-content" className="page-shell">{children}</main>
    </div>
  );
}
