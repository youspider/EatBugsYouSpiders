# EBYS Changelog

EBYS — Eat Bugs You Spider
Generative audio collage engine. Separates songs into stems, analyzes every transient slice, and plays them back in real time using spectral descriptors.

---

## 0.1.4 — 2026-06-19

### Max / slicer.js
- **`buffer_manager.js` fix** — wrong `filename` field in maxpat was silently invoking `track_loader.js` instead; corrected
- **Phantom `src_done` fix** — removed 3 wrong patch cords that were triggering spurious `src_done` callbacks
- **`fluid.bufcompose~` attribute fix** — `destframe` → `deststartframe` (correct attribute name)
- **`dict: cannot read dictionary: -1` fix** — removed loadbang → dict cord that fired before the dict was populated

### Time-stretching (karma~ speed wiring)
- **`stretchRatio` fix in `buffer_manager.js`** — `composePend` was silently discarding `stretchRatio`; now stored and passed through `ring_done` → `slot_router.js` as 4th argument
- **`slot_router.js` v4** — added dedicated speed outlets (12–15) wired to karma~'s right inlet (speed factor = `1/stretchRatio`); pitch follows speed tape-style
- Delay timer corrected: `delayMs = segDurMs × stretchRatio` so the next segment fires at the right moment regardless of stretch amount

### Per-stem pitch shifting (pfft~/gizmo~)
- **`ebys-pitch.maxpat`** — new pfft~ subpatch: `fftin~ 1 square` → `gizmo~` → `fftout~ 1 hamming`; `in 2` receives pitch ratio from outside, routes to gizmo~'s frequency-shift inlet; duration unchanged
- **`ebys-analyze.maxpat`** — 4× pfft~ objects (one per stem) inserted between karma~ and the mixer; slot_router outlets 16–19 wired to each pfft~ inlet 1
- **`slot_router.js` v4** — added pitch outlets (16–19) and `pitchShift / setPitchSemitones / setPitch` functions; per-stem `stemPitch` state; `setPitch all` resets all stems
- **`ws_server.js`** — intercepts `:pitchShift <stem> <semitones>` before buildIndex check; calls `Max.outlet('pitchShift', stem, semitones)`; route object outlet 22 → `prepend pitchShift` (obj-4068) → slot_router inlet 0
- TUI command: `:pitchShift melody 3` raises melody 3 semitones; `:pitchShift all 0` resets

### Code clarity
- **`slicer.js`** — added `── Role ──` header block: sequencing brain, musical decision-making, no direct DSP access
- **`slot_router.js`** — added `── Role ──` header block: audio engine parameter hub, sole owner of karma~/pfft~ messages

### Infrastructure
- **32KB JS read limit bypass** — `analysis_library.json` (~1MB) now read by `ws_server.js` (Node.js) and delivered to `slicer.js` in 2KB chunks over Max's message bus; works around Max's hard JS file read cap
- **Genre filtering** — `genres.json` delivered to slicer via the same chunked mechanism; every slice is tagged with its track's genres
- Genre filter commands: `setGenreFilter <genre>`, `clearGenreFilter`, `listGenres`

### Cricket / Training
- **`:bake` training system** — captures intent + Cricket's commands + user corrections + live descriptor state to `training_log.jsonl`
- **`convert_bakes.py`** — converts bake log to MLX fine-tuning JSONL format
- **`finetune.sh`** — one-command LoRA fine-tune on Apple Silicon via `mlx-lm`
- `mlx-lm` installed in `~/ebys-mlx-env`

### Documentation
- **`ARCHITECTURE.md`** — full pipeline documented: Analysis (Demucs → Essentia → madmom → FluCoMa → JSON) and Playback (ws_server.js → chunks → slicer.js → buffer_manager.js → karma~ → pfft~/gizmo~)
- **`PLAYBACK.md`** — updated to reflect two-axis audio engine (tempo via karma~ speed, pitch via pfft~/gizmo~) and slot_router.js role separation

---

## 0.1.3 — 2026-06-18

### TUI
- **Novelty sparkline** — per-stem `▁▂▃▄▅▆▇█` weather map showing descriptor novelty over the last 12 slices
- Sparkline updates on every slice change (event-driven, no timer)
- Global autoscale across all 4 stems with `NOVELTY_GLOBAL_MIN = 0.05` floor — prevents outlier-poisoned rescaling
- `desc` message type separated from `stem` in ws_server.js so TUI can compute novelty with fresh descriptors
- Loop cycles emit `desc` before `seg` in slicer.js — sparkline now fires for loop repetitions
- Sparkline floor uses `▁` (LOWER ONE EIGHTH BLOCK) — bottom-anchored, single-width, guaranteed across terminal fonts
- Language list column layout: equal-distribution algorithm (floor/ceil per column, max diff = 1 entry)
- Language list LRM anchor restored for RTL scripts (Arabic, Hebrew) with +8 col gap to absorb CJK width discrepancies
- `loopCycles` counter in slicer.js — each loop repetition gets a unique id (`loop1`, `loop2`, …) so TUI detects id change on every cycle
- rangeBar fallback when `rng.max === rng.min`: cursor now shows at left (position 0) instead of center
- Progress bar shows slice zone `────[████░░░]────` with elapsed/remaining within zone
- **Slice zone now pixel-accurate** — slicer.js sends real `startFrac`/`endFrac` with every `seg` message; TUI uses them directly instead of estimating from BPM/bars
- Master header track name combines all stem track names with grey ` · ` separator
- Compact 2-space layout between descriptor fields
- **MMT direction arrows** — `↑` `─` `↓` displayed between each descriptor letter and its range bar (e.g. `M↑ ━━●━━`), driven by `tension_C/E/F/P/H/T` values; `·` when no tension data available
- Space separates arrow from range bar to prevent `─` merging with `━` characters

### ws_server.js
- `desc` handler broadcasts `type:'desc'` instead of `type:'stem'` — TUI uses this to know when fresh descriptors are available
- `desc` handler now accepts and stores `tC/tE/tF/tP/tH/tT` (tension values, 0–1) from slicer
- `seg` handler now parses and stores `sliceStart`/`sliceEnd` fracs broadcast with every stem message
- `slice_ms` handler added
- `index_empty` handler added — broadcasts warning to TUI when `:start` is sent before `buildIndex`

### slicer.js
- `loopCycles` per-stem counter — loop `seg` id is now `loop1`, `loop2`, … (unique per cycle)
- Loop branch emits `desc` with loop segment's descriptor values before `seg` — enables meaningful novelty in loop mode
- All three `desc` outlets now include `tension_C/E/F/P/H/T` fields from the slice object
- All three `seg` outlets now append `startFrac` and `endFrac` so TUI can draw an accurate zone bar
- `buildIndex` now reads `tension_C/E/F/P/H/T` from each slice dict into the in-memory slice objects

### add_tension.py
- Replaces `add_mmt.py` (deleted) — now the single source of truth for momentum computation
- All TUI paths (FluCoMa-done hook and `:setMMT` command) updated to call `add_tension.py`
- Writes `tension_*` fields (not `mmt_*`) — stale `mmt_*` fields stripped from `analysis_library.json`
- `_other.wav` / `_other` added to `STEM_SUFFIXES` so Demucs melody stem groups correctly
- Output condensed: one header line + one stem summary line per track, blank line between tracks

---

## 0.1.2 — 2026-06-16

### TUI
- Renamed `win:` to `env:` in header — the slice fade shape is an envelope, not an FFT window
- Moved MMT window display to sit right after `env:` in header line
- Genre header now shows full `Parent · Sub` format (e.g. `Electronic · Techno` instead of just `Techno`)
- `:setMMT <bars>` command — sets momentum window size, reruns `add_tension.py`, sends `buildIndex` on completion
- `MMT window: N bars` displayed in header

### Analysis
- `add_tension.py` — new script that computes per-bar momentum for all 6 descriptors (C, E, F, P, H, T) and writes `tension_C/E/F/P/H/T` back to every slice in `analysis_library.json`
- Momentum algorithm: group slices by bar → average descriptor per bar → sliding window slope → normalize 0–1 → write back
- `MOMENTUM.md` — documentation for the tension script
- `tension_E` near 1.0 = energy building (drop incoming). Near 0.0 = releasing. 0.5 = stable.
- T descriptor computed on the fly as RMS of MFCC coefficients M0–M5

---

## 0.1.1 — 2026

### TUI
- Per-stem track name display — shows which file each stem is currently playing from (20-char truncation with `…`)
- Weighted genre label in header — genre reflects which stem dominates by energy × track weight
- Track browser — `:nextTrack` / `:prevTrack` cycles through all tracks in bank showing BPM, key, genre, confidence
- `:reloadDownbeats` now updates TUI locally before forwarding to Max
- Key detection displayed in header — pulled from `downbeats.json` via Essentia KeyExtractor
- match/dir parameter lines aligned with bar column
- `fmtM` fixed to 4-char output, matching `fmtDir` alignment
- Slice id moved to end of descriptor line
- `setTrackWeight` intercepted to update per-stem weight in TUI state
- `[object Object]` genre display bug fixed — now correctly extracts `.genres[0].genre`

### Max / slicer.js
- `stemTrack` message handler added to `ws_server.js` — was silently dropped before
- `track_name` handler pre-populates all stem track fields immediately on track load
- `cleanTrackName()` helper strips stem suffix from track name before display
- `outlet(1, "stemTrack", ...)` added in `selectSegment()` and `nextNearest()`

### Analysis
- Essentia KeyExtractor wired into analysis pipeline — writes `key` field to `downbeats.json`
- Key shows in TUI header; `?` when unavailable

---

## 0.1.0 — 2026 (initial working build)

### Engine
- Max/MSP patch — 4-stem playback (vocals, melody, bass, drums) via `fluid.bufcompose~` + `fluid.bufresampler~`
- `analyze_reader.js` — reads Essentia analysis JSON, skips already-analyzed tracks, emits "all analyzed" on completion
- `slice_writer.js` — writes slice data to `analysis_library.json` with M0–M5 MFCC fields
- `slicer.js` — real-time slice selection engine using descriptor distance scoring (C, E, F, P, H, T + MFCC)
- Bar-snap quantization using madmom downbeats — slices lock to bar boundaries when confidence ≥ 0.4
- Stretch ratio wired through outlet 0 for time-stretching playback
- `ws_server.js` — WebSocket bridge between Max and TUI (RFC 6455, no external deps)

### Analysis pipeline
- `genre_tagger.py` — Essentia-based genre classification, writes `genres.json`
- `madmom_tagger.py` — downbeat detection via madmom DBNDownBeatTracker, writes `downbeats.json`
- `fluid.bufmfcc~` added to `ebys-analyze.maxpat` — computes M0–M5 per slice
- `fluid.buftempogram~` added for BPM estimation
- Improved BPM estimation in `analyze_reader.js`

### TUI (sdj-tui.js)
- 4-stem progression bars with real-time position tracking
- Descriptor display per stem: M, E, F, P, H, T
- Slice timestamp display
- Status header: track, BPM, key, LUFS, dBFS, genre, beats confidence bar, quant mode
- match/dir parameter display
- Language selector — 40+ languages, localized agent name and chirp
- Cricket AI agent — Ollama-backed, reads CRICKET.md as knowledge base, mixes commands and conversation
- `:resetMemory` — two-step confirmation to wipe all analysis JSON
- `:tagBeats` — runs madmom tagger from TUI
- `:commands` toggle, `:chat` toggle, `:language` toggle
- Counter advancement fixed — completion-based, not delay loop
- Meter console flooding fixed — delayed metro 100 startup
- `dictwrap` errors in `buildIndex` fixed
- Bass/melody buffer read messages fixed (obj-245, obj-247)

### Infrastructure
- `analysis_library.json` — consolidated single dict replacing per-track dict files
- Nested JSON format fixed — correct structure for Max `dict` objects
- Clean slate command — wipes analysis JSON and resets counter

---

## Roadmap

- **0.2** — momentum wired into slice selection (`:setArc`, `:setMMT` bias)
- **0.3** — Pure Data migration (Max/MSP → PD, deadline Aug 8)
- **1.0** — stable enough to perform with, documented, demo recording
