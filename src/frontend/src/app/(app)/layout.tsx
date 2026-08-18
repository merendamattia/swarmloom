import { AppShell } from "@/components/app-shell";

export default function OperationalLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
