import { GitBranch, LayoutDashboard, ListChecks, Settings } from "lucide-react";

export const navigationItems = [
  { href: "/", label: "Overview", description: "Health and exceptions", icon: LayoutDashboard },
  { href: "/jobs", label: "Jobs", description: "Durable execution history", icon: ListChecks },
  { href: "/repositories", label: "Repositories", description: "Develop baselines", icon: GitBranch },
  { href: "/settings", label: "Settings", description: "Runtime controls", icon: Settings },
] as const;

export function routeTitle(pathname: string) {
  if (pathname.startsWith("/jobs/")) return "Job evidence";
  return navigationItems.find((item) => item.href === "/" ? pathname === "/" : pathname.startsWith(item.href))?.label ?? "Overview";
}
