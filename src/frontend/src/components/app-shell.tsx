"use client";

import { Activity, CircleAlert, GitBranch, LayoutDashboard, ListChecks, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStatus } from "@/hooks/api";

const links = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/jobs", label: "Jobs", icon: ListChecks },
  { href: "/repositories", label: "Repositories", icon: GitBranch },
  { href: "/settings", label: "Settings", icon: Settings },
];

function ProviderAuthBanner() {
  const status = useStatus();
  const data = status.data;
  const providerAuth = data?.providerAuth;
  if (!data || !providerAuth || providerAuth.status !== "required") return null;

  const provider = data.provider === "codex" ? "Codex" : "OpenCode";
  return (
    <aside className="provider-auth-banner" role="alert" aria-labelledby="provider-auth-title">
      <div className="provider-auth-inner">
        <span className="provider-auth-icon" aria-hidden="true"><CircleAlert size={20} /></span>
        <div className="provider-auth-copy">
          <div className="provider-auth-heading">
            <p className="eyebrow">Action required</p>
            <h2 id="provider-auth-title">{provider} login required</h2>
          </div>
          <p>The containers are online, but jobs will not run until the configured provider is authenticated.</p>
          <p>Open the worker container terminal and run:</p>
          <code className="provider-auth-command">{providerAuth.loginCommand}</code>
        </div>
      </div>
    </aside>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="app-frame">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <ProviderAuthBanner />
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
