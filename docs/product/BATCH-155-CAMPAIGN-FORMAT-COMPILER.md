# Campaign format compiler — Batch 155

## Purpose

Turn one approved editorial timeline into independent, lineage-linked campaign canvas variants for common delivery formats. This extends the existing timeline-variant system rather than introducing another editor or project model.

## Supported canvases

| Format | Dimensions | Typical use |
|---|---:|---|
| Landscape 16:9 | 1920 × 1080 | YouTube, web video, landscape placements |
| Vertical 9:16 | 1080 × 1920 | TikTok, Reels, Shorts, vertical placements |
| Square 1:1 | 1080 × 1080 | Square social feeds |
| Portrait 4:5 | 1080 × 1350 | Portrait social feeds |

## Behaviour

- Creates a deep independent timeline variant for each selected format.
- Preserves source clip IDs, assets, timing, editorial metadata and root/parent lineage.
- Changes only the output canvas dimensions and attaches a delivery manifest.
- Records conservative internal safe-area guidance for captions and calls to action.
- Marks each output as requiring reframe review and keeps render readiness false.

## Safety and truthfulness

This compiler does not automatically crop, scale, reposition or render clips. A canvas change can cut off subjects, products, captions or graphics. Each variant must be reviewed and adjusted in the editor before export. Safe-area percentages are internal starting guidance, not guarantees about any platform's current UI overlays.

## Verification

`npm run test:campaign-format-compiler` covers four-format compilation, selected formats, lineage, source immutability, safe-area metadata and invalid-input rejection.
