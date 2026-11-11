# Cloud audio render benchmark

This benchmark measures the current cloud FFmpeg timeline renderer with 1, 4 and 16 simultaneous mono audio clips. It uses generated local fixtures, so it does not require customer media, network access, external providers or paid services.

## Run

```bash
npm run benchmark:cloud-audio-render
```

Optional environment variables:

- `BENCHMARK_DURATION_SECONDS`: fixture length (1–30 seconds; default 4).
- `BENCHMARK_ITERATIONS`: repetitions per track count (1–5; default 1).
- `FFMPEG_PATH` and `FFPROBE_PATH`: explicit media-tool executables.

The script prints one JSON line per run and a final summary. It reports wall-clock render time, output duration and size, audio stream count, channel count and realtime factor.

## Interpretation and guardrails

- Compare results on the same machine, FFmpeg build, codec availability and power profile.
- Run at least three iterations for decisions; the default single iteration is a smoke benchmark.
- Treat 1/4/16 tracks as a scaling sample, not a universal performance guarantee.
- No hard pass/fail performance threshold is imposed until representative staging hardware and baseline measurements are agreed.
- The benchmark generates temporary fixtures and deletes its temporary workspace on completion.
- It does not deploy, change production resources, migrate data, enable workers or activate providers.

The current implementation uses FFmpeg `aeval` for time-varying channel expressions. FFmpeg's documentation explicitly notes that `aeval` is slow and recommends dedicated filters where possible. Do not replace it with a different filter until preview parity, automated pan transitions, and the benchmark results have all been validated.
