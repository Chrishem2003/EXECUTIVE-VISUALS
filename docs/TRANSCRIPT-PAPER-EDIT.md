# Transcript Paper Edit

## Purpose

Paper Edit turns a timestamped WebVTT transcript into an editable video track. It is intended for interviews, explainers, podcasts and dialogue-led footage where an editor wants to keep selected spoken moments and assemble them into a rough cut.

## Use it

1. Open the Timeline Editor and load a saved sequence.
2. Confirm the source video is already present on a video track and is accessible in the current project.
3. Open **Transcript Paper Edit** in the clip tools panel.
4. Select the source video clip.
5. Import a timestamped `.vtt` file, or paste its contents into the transcript field. The editor validates the file before placing its contents in the transcript field.
6. Review the parsed cue list. Search words or phrases and filter by WebVTT speaker labels to narrow visible moments without changing selection. The editor identifies gaps between transcript cues and shows their source time ranges before assembly. It also flags obvious filler sounds (um, uh, erm, etc.) and adjacent repeated words, with links to the affected cue for review. Set the pause threshold from 0.1 to 30 seconds to control which gaps are reported (default 0.75 seconds). Each cue is independently selectable; use **Select all cues** or **Clear selection** to change the selection quickly.
7. Choose **Build paper edit from transcript**. Only checked cues are assembled, in source-time order.
8. Review the new **Paper Edit** video track at the end of the sequence. Each cue is a separate, editable clip referencing the original video asset.

A timestamped WebVTT transcript can be produced by the existing review-first transcription and Video → Localized Captions workflows. When the configured transcription gateway returns word timestamps, the workflow can export a word-level WebVTT sidecar; import that sidecar here to select individual spoken words and build a finer-grained paper edit. If the provider returns only segment timestamps, the workflow retains the segment-level transcript and caption path. The Paper Edit action itself does not call a speech provider or incur AI usage.

## Timecode and media rules

- Transcript cue times are interpreted as absolute seconds from the beginning of the source media, not relative to the visible clip start.
- Every retained cue must fall inside the selected clip's source range.
- The builder supports constant playback speed from 0.25× through 4×.
- Variable-speed curves are rejected because a cue's source time cannot safely be mapped to the timeline with a constant-rate calculation.
- Transcript input is limited to 2 MiB and 5,000 cues; cue text is bounded to 1,000 characters.
- Cues shorter than one timeline frame are skipped. If no usable cues remain, the operation is rejected.

## Safety and editing behavior

- The original source clip and media asset are never trimmed, split, moved or overwritten.
- The builder adds a separate video track named **Paper Edit** and places the retained cues contiguously after the current sequence end.
- Each generated clip keeps the original asset ID and records the source clip, cue index and transcript text in clip metadata.
- The operation uses the normal timeline validation, undo/redo history and revision-guarded save path.
- If validation or persistence fails, the original source asset remains untouched. Review the timeline status before rendering or delivery.

## Known limitations

- Selection is per complete WebVTT cue. Word-level WebVTT cues support word-level selection; arbitrary sub-word ranges are not supported. Search and speaker filters only hide or show cue rows; they do not alter the selected set. Pause analysis and text flags are informational and do not modify cue selection. Selecting a text flag navigates to and selects the complete cue for human review.
- It creates a rough-cut track and reports long gaps between transcript cues. Those inter-cue gaps are naturally omitted when selected dialogue clips are assembled contiguously; this is not waveform-based silence detection and does not remove silence inside a cue. Text review flags common filler tokens and adjacent repeated words, but it does not infer word-level timing, remove individual words from audio, perform speaker diarization, or choose the strongest story moments. Editors must inspect the complete cue and decide whether to keep or omit it. Speaker filtering uses existing WebVTT voice tags (`<v Speaker Name>`) and does not infer speakers when labels are absent.
- Variable-speed clips and transcript formats other than WebVTT are not supported yet.
