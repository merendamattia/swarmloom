# Product

## Register

product

## Users

Swarmloom is operated by one technically proficient person responsible for an autonomous
worker running on a VPS. They check the interface briefly during normal operation and investigate
only when a job, repository, provider, or notification path needs attention.

## Product Purpose

The dashboard makes the worker's health and exceptions understandable within ten seconds. It lets
the operator confirm that scheduled work is progressing, identify exactly where intervention is
needed, inspect durable evidence, and take the few supported recovery actions without reading raw
Docker logs first.

## Brand Personality

Calm, precise, reliable. The interface speaks in concise, factual language. It should feel composed
during failures, confident without bravado, and transparent about what is known or unavailable.

## Anti-references

Do not resemble a dark DevOps cockpit, a wall of undifferentiated KPI cards, or a neon terminal.
Avoid generic SaaS decoration, excessive card grids, ornamental charts, glass effects, and status
systems that require memorizing colors. Density must support diagnosis rather than visual drama.

## Design Principles

1. **Health before activity.** Lead with whether the system is healthy and whether action is needed.
2. **Exceptions explain the next move.** Every abnormal state names the affected object, evidence,
   and available operator action.
3. **Progressive operational detail.** Keep the overview quiet; reveal history, output, and technical
   context when the operator drills into a job or repository.
4. **Durable truth over optimistic UI.** Reflect PostgreSQL state, distinguish stale or unavailable
   data, and never imply an action succeeded before the API confirms it.
5. **Familiar controls, restrained personality.** Borrow the clarity of Linear, GitHub Actions, and
   Sentry without copying their branding or inventing novel dashboard affordances.

## Accessibility & Inclusion

Target WCAG 2.2 AA. All actions and navigation must work by keyboard with visible focus. Status must
use text and shape in addition to color. Respect reduced-motion preferences, preserve useful zoom
and narrow-screen behavior, keep interactive targets at least 44 pixels, and make long technical
output readable without trapping focus or forcing horizontal page scrolling.
