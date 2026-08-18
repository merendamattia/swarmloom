---
name: Swarmloom
description: A calm morning ledger for autonomous GitHub work, exceptions, and durable evidence.
colors:
  canvas: "oklch(97.8% 0.006 78)"
  surface: "oklch(99.4% 0.003 78)"
  surface-subtle: "oklch(95.8% 0.009 78)"
  ink: "oklch(23% 0.018 258)"
  ink-muted: "oklch(47% 0.018 258)"
  border: "oklch(87% 0.012 78)"
  accent: "oklch(48% 0.115 264)"
  accent-hover: "oklch(42% 0.12 264)"
  accent-soft: "oklch(93% 0.028 264)"
  success: "oklch(43% 0.105 151)"
  success-soft: "oklch(94% 0.035 151)"
  warning: "oklch(48% 0.105 76)"
  warning-soft: "oklch(94% 0.045 76)"
  danger: "oklch(49% 0.16 28)"
  danger-soft: "oklch(94% 0.035 28)"
typography:
  heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.03em"
  data:
    fontFamily: "ui-monospace, 'SFMono-Regular', Consolas, monospace"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: "normal"
rounded:
  sm: "6px"
  md: "10px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  3xl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
    height: "44px"
  status-pill:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "5px 9px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "24px"
---

## Overview

**Creative North Star: "The Morning Ledger"**

Swarmloom should feel like opening a clean operational ledger at the start of the day:
quiet, current, and immediately decisive. The overview leads with a single health judgment and the
few exceptions that require action. History and evidence become denser only after the operator
drills in.

The visual direction combines Linear's information hierarchy, GitHub Actions' legible lifecycle
states, and Sentry's exception-first investigation pattern. It remains its own product through a
warm paper-like canvas, restrained ink-indigo accent, compact rules, and plain factual language.

**Key Characteristics:**

- Warm, daylight-friendly surfaces with crisp rules instead of floating card walls.
- Exception-first hierarchy: health, affected object, evidence, then recovery action.
- Compact data density with generous page-level breathing room.
- Text, icon, and shape always accompany status color.
- Familiar controls, durable confirmation, and no decorative operational theater.

## Colors

The canvas and surfaces are warm neutrals; the accent is a low-chroma ink indigo used only for
navigation, focus, and primary actions. Semantic colors are reserved for actual state. All
canonical colors use OKLCH and the same values must be used in CSS.

**The Rare Accent Rule.** Keep accent color below roughly ten percent of the visual weight so it
continues to identify the next action.

**The Explained State Rule.** Never rely on color alone. Every semantic color appears with a label
and, when useful, a distinct icon or dot shape.

## Typography

Use the native system sans stack for immediate rendering and an operational, familiar voice. Keep
the scale small and decisive: 24px page headings, 20px section headings, 16px body, and 13px labels
or metadata. Technical identifiers and output use the native monospace stack. Data tables use
tabular numerals.

**The Quiet Hierarchy Rule.** Create hierarchy with weight, position, and whitespace before adding
font sizes. Uppercase is limited to short eyebrows and status labels with deliberate tracking.

## Elevation

The interface is almost flat. Page sections are separated by spacing and one-pixel rules. Panels
use a white-warm surface and border; shadows are limited to a subtle floating-menu or sticky-header
separation. Avoid nested cards, glass, gradients, and conspicuous drop shadows.

Motion is functional: color and border transitions last 140ms; active work may use one restrained
pulse. Under `prefers-reduced-motion`, all nonessential animation stops.

**The Durable Surface Rule.** If content belongs to the same operational thought, group it with
alignment and rules rather than adding another container.

## Components

- **Top navigation:** product mark and three destinations—Overview, Jobs, Repositories—with a clear
  selected state. It remains horizontally usable on narrow screens.
- **Health strip:** one full-width sentence answering healthy or intervention needed, followed by
  worker, provider, Telegram, schedule, and repository facts. It is the strongest overview object.
- **Exception row:** affected repository or job, explicit state, short evidence, timestamp, and the
  next available action. A quiet empty state replaces the list when there is nothing to address.
- **Status pill:** compact text plus a small state glyph; never color-only. Sentence case in prose,
  uppercase only inside the pill.
- **Operational table:** left-aligned labels, tabular time and counts, full-row detail links, and
  thin separators. On narrow screens each row becomes a labeled record instead of overflowing.
- **Timeline:** a continuous vertical rule with timestamp, event type, message, and expandable
  technical payload. Long output wraps or scrolls inside its own region, never the page.
- **Buttons and fields:** minimum 44px target, visible 2px focus ring, explicit loading labels, and
  confirmed server response before success is shown.

## Do's and Don'ts

### Do:

- **Do** place the current health judgment and required intervention above activity totals.
- **Do** use 4px-based spacing and reserve 32–48px gaps for page-level hierarchy.
- **Do** let tables and timelines carry operational density after the overview.
- **Do** state what happened, why it matters, and the next available action in errors.
- **Do** preserve keyboard navigation, 200% zoom, 44px targets, and reduced-motion behavior.
- **Do** show stale, unavailable, empty, and invalid-repository states as first-class content.

### Don't:

- **Don't** build a dark DevOps cockpit, terminal aesthetic, KPI wall, or neon status system.
- **Don't** use charts when a count, list, or timestamp answers the operational question faster.
- **Don't** nest cards or give every statistic its own bordered container.
- **Don't** imply success before the API confirms the durable PostgreSQL state.
- **Don't** hide actions behind hover, encode state with color alone, or allow technical output to
  force horizontal page scrolling.
