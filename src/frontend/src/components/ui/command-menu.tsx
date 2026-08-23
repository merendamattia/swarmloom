"use client";

import { Command, Search, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "@/components/ui/button";
import { navigationItems } from "@/components/ui/navigation";

export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setQuery("");
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const visibleItems = navigationItems.filter((item) => `${item.label} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <dialog
      className="command-dialog"
      ref={dialogRef}
      onClose={() => onOpenChange(false)}
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      aria-labelledby="command-title"
    >
      <div className="command-menu">
        <div className="command-search">
          <Search aria-hidden="true" />
          <label className="sr-only" htmlFor="command-query" id="command-title">Navigate Swarmloom</label>
          <input id="command-query" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search pages and actions" />
          <IconButton label="Close navigation search" onClick={() => onOpenChange(false)}><X aria-hidden="true" /></IconButton>
        </div>
        <div className="command-results">
          <p className="command-heading">Navigate</p>
          {visibleItems.length ? visibleItems.map(({ href, label, description, icon: Icon }) => (
            <Link className="command-item" href={href} key={href} onClick={() => onOpenChange(false)}>
              <span className="command-item-icon"><Icon aria-hidden="true" /></span>
              <span><strong>{label}</strong><small>{description}</small></span>
            </Link>
          )) : <div className="command-empty"><Command aria-hidden="true" /><p>No page matches “{query}”.</p></div>}
        </div>
        <footer className="command-footer"><kbd>Tab</kbd><span>Navigate</span><kbd>Esc</kbd><span>Close</span></footer>
      </div>
    </dialog>
  );
}
