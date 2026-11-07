# Executive Visuals interface design principles

## Product direction
Executive Visuals is a professional production workspace, not an AI feature catalogue. The interface should feel like a considered creative tool: quiet chrome, clear hierarchy, visible project context and direct language.

## Visual system
- Graphite surfaces with a restrained green accent; avoid neon gradients and decorative pseudo-3D artwork.
- Use a readable system-first sans-serif stack with distinct heading and body hierarchy.
- Body copy and form controls should remain comfortably readable at normal desktop zoom; never rely on tiny uppercase labels to communicate essential information.
- Use spacing, alignment and consistent panel boundaries to establish hierarchy rather than excessive card decoration.
- Keep motion subtle and respect reduced-motion preferences.
- Preserve visible focus states and keyboard operation.

## Type scale
- Body: 15px base, 1.55 line height.
- Form controls: 14px minimum.
- Navigation: 13px.
- Supporting labels: 11px minimum, non-essential only.
- Page titles: 36px desktop, 29px narrow screens.
- Section headings: 22px.
- Panel headings: 16–22px depending on hierarchy.

## Content principles
- Name actions by the outcome: “New production brief”, “View projects”, “Export video”.
- Describe what is currently available, what requires a provider, and what is not yet supported.
- Avoid inflated promises, vague AI language, artificial status claims and decorative filler.
- Distinguish planning, queued work, provider execution and completed deliverables.

## Interaction principles
- Keep primary actions prominent and secondary actions quiet.
- Use clear loading, empty, blocked, error and success states.
- Do not make non-functional cards look like live controls.
- Keep project, media, timeline and export context visible in creative workflows.
- Preserve responsive layouts and touch-sized controls.

## Accessibility target
Use WCAG 2.2 AA as the baseline: sufficient text contrast, visible focus, keyboard access, meaningful control names, text resizing and reflow. See https://www.w3.org/TR/WCAG22/.
