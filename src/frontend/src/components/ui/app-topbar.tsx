"use client";

import { Menu, PanelLeftOpen, Search } from "lucide-react";
import { usePathname } from "next/navigation";
import { IconButton } from "@/components/ui/button";
import { routeTitle } from "@/components/ui/navigation";

export function AppTopbar({ collapsed, onToggleSidebar, onOpenMobile, onSearch }: {
  collapsed: boolean;
  onToggleSidebar: () => void;
  onOpenMobile: () => void;
  onSearch: () => void;
}) {
  const pathname = usePathname();
  const title = routeTitle(pathname);
  return (
    <header className="app-topbar">
      <div className="topbar-leading">
        <span className="topbar-mobile-menu"><IconButton label="Open navigation" onClick={onOpenMobile}><Menu aria-hidden="true" /></IconButton></span>
        {collapsed ? <span className="topbar-desktop-expand"><IconButton label="Expand sidebar" onClick={onToggleSidebar}><PanelLeftOpen aria-hidden="true" /></IconButton></span> : null}
        <nav className="topbar-breadcrumb" aria-label="Current location"><span>Swarmloom</span><span aria-hidden="true">/</span><strong>{title}</strong></nav>
      </div>
      <button className="topbar-search" type="button" onClick={onSearch}>
        <Search aria-hidden="true" />
        <span>Search</span>
        <kbd>⌘K</kbd>
      </button>
    </header>
  );
}
