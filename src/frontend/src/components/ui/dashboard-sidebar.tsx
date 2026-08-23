"use client";

import { PanelLeftClose, Search, X } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconButton } from "@/components/ui/button";
import { navigationItems } from "@/components/ui/navigation";
import { cn } from "@/lib/utils";

export type SidebarNavProps = {
  collapsed: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onCollapse: () => void;
  onSearch: () => void;
};

function SidebarLink({ href, label, icon: Icon, collapsed, onNavigate }: {
  href: string;
  label: string;
  icon: typeof navigationItems[number]["icon"];
  collapsed: boolean;
  onNavigate: () => void;
}) {
  const pathname = usePathname();
  const active = href === "/" ? pathname === href : pathname.startsWith(href);
  return (
    <Link className="sidebar-link" href={href} aria-current={active ? "page" : undefined} title={collapsed ? label : undefined} onClick={onNavigate}>
      <Icon aria-hidden="true" />
      <span className="sidebar-label">{label}</span>
    </Link>
  );
}

export function SidebarNav({ collapsed, mobileOpen, onCloseMobile, onCollapse, onSearch }: SidebarNavProps) {
  const mainItems = navigationItems.filter((item) => item.href !== "/settings");
  const settings = navigationItems.find((item) => item.href === "/settings")!;
  const compactLogo = collapsed && !mobileOpen;
  return (
    <>
      <button className="sidebar-scrim" type="button" data-open={mobileOpen} aria-label="Close navigation" onClick={onCloseMobile} />
      <aside className={cn("dashboard-sidebar", collapsed && "is-collapsed")} data-mobile-open={mobileOpen} aria-label="Application navigation">
        <div className="sidebar-workspace">
          <Link className="workspace-identity" href="/" aria-label="Swarmloom overview" onClick={onCloseMobile}>
            {compactLogo
              ? <span className="workspace-mark"><Image src="/brand/logo-no-name.png" alt="" width={32} height={32} priority /></span>
              : <Image className="workspace-logo" src="/brand/logo.png" alt="" width={175} height={45} priority />}
          </Link>
          <div className="sidebar-mobile-close"><IconButton label="Close navigation" onClick={onCloseMobile}><X aria-hidden="true" /></IconButton></div>
        </div>

        <nav className="sidebar-nav" aria-label="Primary navigation">
          <button className="sidebar-link sidebar-search" type="button" title={collapsed ? "Search" : undefined} onClick={onSearch}>
            <Search aria-hidden="true" />
            <span className="sidebar-label">Search</span>
            <kbd className="sidebar-shortcut">⌘K</kbd>
          </button>
          <p className="sidebar-group-label">Workspace</p>
          {mainItems.map((item) => <SidebarLink key={item.href} {...item} collapsed={collapsed} onNavigate={onCloseMobile} />)}
        </nav>

        <div className="sidebar-bottom">
          <SidebarLink {...settings} collapsed={collapsed} onNavigate={onCloseMobile} />
          <button className="sidebar-link sidebar-collapse" type="button" title={collapsed ? "Expand sidebar" : undefined} onClick={onCollapse}>
            <PanelLeftClose aria-hidden="true" />
            <span className="sidebar-label">Collapse sidebar</span>
          </button>
        </div>
      </aside>
    </>
  );
}
