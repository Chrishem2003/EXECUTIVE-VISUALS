# Media Quality and Temporal Signal Analysis

## Temporal luminance review

The signal-analysis module can parse FFmpeg `signalstats` frame metadata (`lavfi.signalstats.YAVG`) into timestamped mean-luminance samples. Samples outside the valid 0–255 luma range, without a finite non-negative timestamp, or without a frame index are discarded.

`buildTemporalLumaFindings` checks two conservative patterns:

- **Abrupt luminance change:** a large adjacent-sample delta away from a supplied scene-cut timestamp.
- **Alternating luminance:** repeated high-amplitude sign changes over a short sample window, which may indicate temporal flicker.

Known scene-cut-adjacent transitions are excluded within a configurable guard interval. Thresholds are configurable, and findings are warnings for human review rather than automatic failures or perceptual-quality scores.

## Report integration

`buildMediaQualityReport` consumes optional `signalAnalysis.lumaSamples` and `signalAnalysis.sceneChanges` evidence and includes the derived findings and sample count. Existing black-frame, silence, freeze, scene-change and audio-metric checks remain separate.

The current integration is an evidence consumer: an upstream FFmpeg analysis step must provide decoded-frame samples. The report does not claim that luma analysis ran when samples were not supplied. A missing sample set is not a clean flicker pass.

## Limitations and release checks

- Mean luma alone cannot distinguish intentional strobing, rapid lighting changes, cuts, camera flashes, exposure changes or defective flicker with certainty.
- Scene-cut timestamps must come from a dedicated scene-change detector, not every decoded frame timestamp.
- Sparse sampling can miss very short flashes; dense sampling costs more CPU and metadata storage.
- This check does not assess chroma flicker, rolling-shutter artifacts, motion judder, stabilization, sharpness or perceptual fidelity.
- Before enabling automatic cloud-render analysis by default, benchmark representative short and long renders, cap analysis duration/output, propagate cancellation, and confirm optional-analysis failures remain visible as unknown rather than passed.
