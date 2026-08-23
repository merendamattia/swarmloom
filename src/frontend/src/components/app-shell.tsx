"use client";

import { useEffect, useState } from "react";
import { AppTopbar } from "@/components/ui/app-topbar";
import { CommandMenu } from "@/components/ui/command-menu";
import { SidebarNav } from "@/components/ui/dashboard-sidebar";
import { ProviderAuthBanner } from "@/components/ui/provider-auth-banner";
import { useStatus } from "@/hooks/api";

export function AppShell({ children }: { children: React.ReactNode }) {
  const status = useStatus();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="app-frame" data-sidebar-collapsed={collapsed}>
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <SidebarNav
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
        onCollapse={() => setCollapsed((value) => !value)}
        onSearch={() => setSearchOpen(true)}
      />
      <div className="app-workspace">
        <AppTopbar
          collapsed={collapsed}
          onToggleSidebar={() => setCollapsed(false)}
          onOpenMobile={() => setMobileOpen(true)}
          onSearch={() => setSearchOpen(true)}
        />
        <ProviderAuthBanner status={status.data} />
        <main id="main-content" className="page-shell">{children}</main>
      </div>
      <CommandMenu open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}
