# EBYS — Architecture Reference

> **EBYS** (Electronic Beat Yield System) is a real-time generative audio collage engine. It takes uploaded music, separates it into stems, analyzes every sonic slice, and rebuilds the music live from a pool of spectral-descriptor-indexed segments — driven by an AI personality (Cricket) running on a local LLM.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Pipeline at a Glance](#2-pipeline-at-a-glance)
3. [Stage 1 — Ingestion](#3-stage-1--ingestion)
4. [Stage 2 — Analysis](#4-stage-2--analysis)
5. [Stage 3 — Index Building](#5-stage-3--index-building)
6. [Stage 4 — Playback Engine](#6-stage-4--playback-engine)
7. [Stage 5 — AI Brain (Cricket)](#7-stage-5--ai-brain-cricket)
8. [Stage 6 — Terminal UI (TUI)](#8-stage-6--terminal-ui-tui)
9. [Data Files Reference](#9-data-files-reference)
10. [Max Patch Infrastructure](#10-max-patch-infrastructure)
11. [System Services & DevTools](#11-system-services--devtools)
12. [Archive / BAK Files](#12-archive--bak-files)

---

## 1. System Overview

EBYS has three independent processes that communicate over WebSocket:

```
┌─────────────────────────────┐
│   watch_demucs.py           │  ← runs as LaunchAgent (always on)
│   Demucs + Essentia + madmom│  ← Python analysis
└────────────┬────────────────┘
             │  writes stems → EBYS_INFRA/stems/htdemucs/
             │  writes analysis → MAX/analysis_library.json
             ▼
┌─────────────────────────────┐        WebSocket :8080
│   ebys-analyze.maxpat       │ ◄────────────────────────► TUI (sdj-tui.js)
│   Max/MSP patch             │
│   ├─ ws_server.js  (Node)   │  ← bridge: Max ↔ WebSocket
│   ├─ slicer.js              │  ← slice selector / sequencer
│   ├─ buffer_manager.js      │  ← disk → src → ring buffer chain
│   ├─ slot_router.js         │  ← audio engine parameter hub
│   ├─ analyze_reader.js      │  ← FluCoMa → slice_writer
│   └─ slice_writer.js        │  ← persists analysis dict
└─────────────────────────────┘
```

---

## 2. Pipeline at a Glance

```
Drop audio file
      │
      ▼
[watch_demucs.py]         Stage 1 — Ingestion
  Demucs: separate into vocals / drums / bass / other
  genre_tagger.py: Discogs-EffNet genre → genres.json
  madmom_tagger.py: downbeat detection → downbeats.json
      │
      ▼
[ebys-analyze.maxpat]     Stage 2 — Analysis (FluCoMa)
  streamWatcher.js detects new stems
  FluCoMa: slice, centroid, energy, flatness, pitch, MFCC, chroma
  analyze_reader.js reads buf~ → slice_writer.js
  slice_writer.js → analysis_library.json  (raw FluCoMa output ~1MB)
      │
      ▼
[add_tension.py]          Stage 2b — Tension Fields (optional, offline)
  Sliding-window slope across bars → tension_C/E/F/P/H/T per slice
      │
      ▼
[ws_server.js]            Stage 3 — Index Building
  prepareLibraryDict() → loads analysis_library.json into memory
  computeAndWriteUMAP():
    ├─ extract 6-D features (C, E, F, P, H, T)
    ├─ write stem_ranges.json (descriptor min/max per stem)
    └─ tsne_worker.js (Worker thread): t-SNE → umap_coords.json
  buildIndex: merge analysis + UMAP + genres → ebys_index.json (~2.8MB)
      │
      ▼
[slicer.js]               Stage 4 — Live Playback
  Receives ebys_index (idxchunk) and downbeats (downbeatchunk)
  Selects next slice per stem using descriptor weights + match probs
  Sends play commands → buffer_manager.js → slot_router.js → karma~
      │
      ▼
[sdj-tui.js]              Stage 5 — Control Surface
  Displays live descriptors, BPM, LUFS, slice position
  User types commands: :bars 2, :brighter, :bake, :pitchShift melody 3
  Cricket (Ollama LLM) interprets natural language → engine commands
```

---

## 3. Stage 1 — Ingestion

### `watch_demucs.py`
**Location:** `EBYS_INFRA/watch_demucs.py`
**Type:** Python daemon, runs as LaunchAgent

The entry point for all new audio. Uses `watchdog` to monitor `raw_uploads/`. When a new audio file appears:
1. Calls Demucs (`htdemucs` model) to separate into 4 stems: vocals, drums, bass, other (melody)
2. Places stems in `stems/htdemucs/<TrackName>/` with naming convention `<TrackName>_vocals.wav` etc.
3. Calls `genre_tagger.py` on the **original** mix file (not stems — the model needs the full mix)
4. Calls `madmom_tagger.py` on the original mix for downbeat/BPM detection
5. Reports progress at each stage via POST to `ws_server.js /progress` → broadcasts to TUI as `pipelineStage` events
6. Writes `stream.txt` listing all new stem paths → signals Max to start analysis

Uses two separate Python environments: `demucs_env` (Python 3.14, has torch) for Demucs, and a system Python 3.10/3.11 (has essentia + madmom) for analysis — these are incompatible with the same Python version.

### `genre_tagger.py`
**Location:** `EBYS_INFRA/genre_tagger.py`
**Type:** Python script (called by watch_demucs.py or standalone)

Classifies a track's genre using Essentia + Discogs-EffNet neural net (400 genre classes). Writes results to `genres.json` with top-N genre labels and confidence scores. Always runs on the original mix, not stems, because isolated stems lack the harmonic/rhythmic context the model needs.

### `madmom_tagger.py`
**Location:** `EBYS_INFRA/madmom_tagger.py`
**Type:** Python script (called by watch_demucs.py or standalone)

Uses madmom's `DBNDownBeatTrackingProcessor` to detect:
- Time signature (meter: 2, 3, or 4)
- BPM
- Downbeat timestamps in ms (first beat of every bar)
- Confidence score (1.0 = perfectly regular grid)

Output goes to `downbeats.json`. slicer.js uses downbeats to align slice selection to musical bar boundaries (the "downbeat snap" feature).

Requires Python ≤ 3.11 (madmom won't compile on 3.12+).

### `send_to_max.py`
**Location:** `EBYS_INFRA/send_to_max.py`
**Type:** Legacy Python polling script

Older approach: polls `stems/htdemucs/` every 500ms and writes a flat `stream.txt` listing all `.wav` paths with their stem type. `streamWatcher.js` in Max detects changes and triggers analysis. This is now mostly superseded by `watch_demucs.py` doing it directly, but the stream.txt mechanism is still used.

### `rename_stems.py`
**Location:** `EBYS_INFRA/rename_stems.py`
**Type:** Utility script (one-shot)

Early migration script. Renames `drums.wav` → `<SongFolder>_drums.wav` inside each htdemucs subfolder. Only needed when migrating from the flat naming convention Demucs originally used to the prefixed convention EBYS requires.

### `scan_stems.py` / `debug_stems.py`
**Location:** `EBYS_INFRA/`
**Type:** Diagnostic utilities

Simple utilities to list all stems found in `htdemucs/` and print them as JSON (`scan_stems.py`) or just pretty-print folder contents (`debug_stems.py`). Used during setup/debugging.

---

## 4. Stage 2 — Analysis

### `ebys-analyze.maxpat`
**Location:** `EBYS_INFRA/MAX/ebys-analyze.maxpat`
**Type:** Max/MSP patch (JSON format)

The main Max patch. Contains all wiring between JS objects, FluCoMa objects, buffer~ objects, and audio engine. Key subsystems inside it:
- **FluCoMa analysis chain**: `fluid.bufonsetslice~` → `fluid.bufstats~` → `fluid.bufpitch~` → `fluid.bufmfcc~` → `fluid.bufchroma~`
- **Buffer architecture**: `src_0/1_*` (full track disk buffers), `ring_0/1_*` (short segment copy buffers), `snap_*` (bake snapshot buffers)
- **Audio engine**: `karma~` per stem (looping buffer player), `pfft~`/`gizmo~` for pitch shifting
- **Node.js objects**: `node.script ws_server.js`, `node.script cricket.js`
- **JS objects**: all the `.js` files listed below

### `ebys-pitch.maxpat`
**Location:** `EBYS_INFRA/MAX/ebys-pitch.maxpat`
**Type:** Max sub-patch

Encapsulated pitch analysis patch, likely a bpatcher for the pitch FluCoMa chain.

### `streamWatcher.js`
**Location:** `EBYS_INFRA/MAX/streamWatcher.js`
**Type:** Max JS object (`js streamWatcher.js`)

Polls `stream.txt` every 1 second. When the file content changes (new stems appeared), it bangs outlet 0 → triggers the analysis counter in the patch to start processing. Replaces Max's unreliable `filewatch` for paths outside the Max search path.

### `analyze_reader.js`
**Location:** `EBYS_INFRA/MAX/analyze_reader.js`
**Type:** Max JS object (`js analyze_reader.js`)

Reads the FluCoMa `buf~` output buffers **after** FluCoMa finishes processing a stem. Iterates every analysis frame (one per onset slice), extracts descriptors (C, E, F, P, H, M0–M5), and sends them to `slice_writer.js` via outlet 0. Manages the multi-track analysis loop: batches of 4 stems (one track), advances a Max counter to trigger FluCoMa on the next stem, moves to the next batch when done.

Also loads `analysis_library.json` into the `analysisLib` dict at startup (triggered by the dict's outlet 1 wire → loadRegistry message) so that previously analyzed tracks are available immediately without re-analysis.

### `slice_writer.js`
**Location:** `EBYS_INFRA/MAX/slice_writer.js`
**Type:** Max JS object (`js slice_writer.js`)

Receives per-slice descriptor values from `analyze_reader.js` and writes them into the `analysisLib` Max dict using `replace` messages. Also handles:
- **Key detection**: Krumhansl-Schmuckler algorithm on accumulated pitch values → `metadata::key`
- **BPM/confidence metadata** per stem
- **Persistence**: writes all dict data to `analysis_library.json` on disk after each track completes
- **Deduplication**: `trackExists` message checks if a track is already in the library before re-analyzing

### `add_tension.py`
**Location:** `EBYS_INFRA/add_tension.py`
**Type:** Offline Python post-processor

Adds `tension_C/E/F/P/H/T` fields to every slice in `analysis_library.json`. Process:
1. Assigns each slice to its musical bar using `downbeats.json`
2. Averages all descriptors per bar
3. Computes a sliding-window slope (default window = 4 bars)
4. Normalizes slopes to [0,1]
5. Writes back to `analysis_library.json`

Tension values let slicer.js build towards or away from musical climaxes. Run manually after adding new tracks.

### `asset_id.js`
**Location:** `EBYS_INFRA/MAX/asset_id.js`
**Type:** Max JS object

Generates unique IDs for stem families. Given a filename (e.g. `DREPTO_CE3o.wav`) it produces `DREPTO_CE3o_1`, `_2`, etc. for each stem. Used during ingestion to assign stable asset IDs before analysis. Mostly legacy from an earlier architecture.

### `folder_scanner.js` / `scanner.js`
**Location:** `EBYS_INFRA/MAX/folder_scanner.js`, `scanner.js`
**Type:** Max JS objects

File system utilities. `folder_scanner.js` scans a flat folder for audio files (wav/aif/mp3) and outputs each filename. `scanner.js` is a recursive version that walks subdirectories and outputs full paths. Both are used during setup and analysis routing within the patch.

### `classifier.js`
**Location:** `EBYS_INFRA/MAX/classifier.js`
**Type:** Max JS object

Simple stem type classifier: given a file path, routes it to the `drums` or `instruments` outlet based on the filename (looks for "drums", "bass", "other", "vocals"). Legacy routing helper from before the current naming convention was stable.

### `bpm_from_tempogram.js`
**Location:** `EBYS_INFRA/MAX/bpm_from_tempogram.js`
**Type:** Max JS object — **DEPRECATED**

Written to extract BPM from a `fluid.buftempogram~` buffer. Marked deprecated in the file because `fluid.buftempogram~` doesn't exist in FluCoMa. Kept for reference. BPM detection now handled by `madmom_tagger.py`.

### `stems.js`
**Location:** `EBYS_INFRA/MAX/stems.js`
**Type:** Max JS object stub

Contains only `post("JS OBJECT WORKS\n")`. Placeholder/test object from an early development stage.

---

## 5. Stage 3 — Index Building

### `ws_server.js`
**Location:** `EBYS_INFRA/MAX/ws_server.js`
**Type:** Max Node.js object (`node.script ws_server.js`)

The central nervous system of EBYS. Bridges Max and the outside world (TUI, Cricket) over WebSocket on port 8080. Major responsibilities:

**WebSocket server**: accepts connections from TUI clients. On first connect, sends downbeats (chunk stream) and the cached `ebys_index.json` (if valid).

**buildIndex** (triggered by TUI after analysis completes):
1. `prepareLibraryDict()`: reads `analysisLib` dict from Max (sent as chunked JSON via `libchunk` outlet), parses it, caches it in memory
2. Sends `analysis_library.json` in 2048-char chunks to slicer.js via `libchunk` outlet
3. After 500ms (FluCoMa buffers settle), calls `computeAndWriteUMAP()`
4. `buildIndexInProgress` guard flag prevents duplicate builds

**computeAndWriteUMAP()**: 
1. Synchronously extracts 6-D features (C, E, F, P, H, T) per slice per stem
2. Writes `stem_ranges.json` immediately (no blocking)
3. Spawns `tsne_worker.js` via Worker thread (non-blocking, keeps WebSocket alive)
4. On worker result: writes `umap_coords.json`, broadcasts `umapDone`, resets guard flag

**Real-time telemetry**: relays `desc`, `seg`, `meter`, `state`, `slices`, `param`, `beats` messages from Max to TUI via WebSocket broadcast.

**Slice command relay**: relays `vocals/melody/bass/drums` play commands and `pitchShift` from TUI to Max outlets.

**Chunk reassembly** (`saveIdxChunk`): receives `ebys_index.json` from slicer.js in 2048-char chunks and saves to disk.

**Handlers**: `downbeatchunk`, `sourceTrack`, `analysisDone`, `umapDone`, `globalBPM`, `stemDurMs`, `meta`, `ready`, `stopped`, `resetMemory`, `streamUpdated`.

### `tsne_worker.js`
**Location:** `EBYS_INFRA/MAX/tsne_worker.js`
**Type:** Node.js Worker thread (spawned by ws_server.js)

Runs t-SNE in a separate thread so the ~5-second computation doesn't block the Node.js event loop (which would cause WebSocket ping timeouts → TUI reconnect → duplicate `buildIndex`).

Receives `workerData.stems` — an array of `{ stem, ids, features, nIter }`. For each stem, runs a full t-SNE implementation (perplexity-based bandwidth search, symmetric P matrix, gradient descent with momentum). Posts results back as `{ [stem]: { coords: { [id]: [x, y] }, ms } }`.

The t-SNE result is `umap_coords.json` — 2D coordinates for every slice, used by the TUI spatial navigator.

### `slicer.js`
**Location:** `EBYS_INFRA/MAX/slicer.js`
**Type:** Max JS object (`js slicer.js`) — the musical brain

Receives the full `ebys_index.json` (via `idxchunk` messages) and `downbeats.json` (via `downbeatchunk` from ws_server). After assembly, `buildIndex()` runs:
- Parses all slices, groups by stem type (`byTrack`)
- For each source track, loads downbeat data from `trackDownbeats`
- Builds candidate pools per stem: slices near downbeat positions go into `aligned[]`, others into `free[]`

**Slice selection** (`pickNext()`): weights candidates by Euclidean distance in descriptor space (C, E, F, P, H, T), filtered by match probabilities and directional preferences. Returns a slice index.

**Sequencer** (`metro` callback): at each tick, calls `pickNext()` per stem, sends play command to `buffer_manager.js` with `sourceSlot, startFrac, endFrac, stretchRatio, segDurMs`.

**Parameters received from TUI** (via route → slicer inlet): `setWeight`, `setMatchProb`, `setDirPref`, `setDirWeight`, `setStayProb`, `setSegmentBars`, `setQuantize`, `setFallbackBPM`, `setTrackWeight`, `start`, `stop`, `selectSegment`.

**Telemetry emitted** (outlet 1 → ws_server): `desc` (current slice descriptors), `seg` (slice position info), `slices` (pool sizes).

---

## 6. Stage 4 — Playback Engine

### `buffer_manager.js`
**Location:** `EBYS_INFRA/MAX/buffer_manager.js`
**Type:** Max JS object (`js buffer_manager.js`)

Two-level buffer architecture for zero-glitch multi-track playback:

**Level 1 — src buffers** (`src_0/1_voc/drm/bss/mel`, 8 total): full-length audio files loaded from disk. Two slots per stem enable crossfading between tracks without re-reading from disk.

**Level 2 — ring buffers** (`ring_0/1_voc/drm/bss/mel`, 8 total): short pre-allocated buffers. `fluid.bufcompose~` copies the exact segment (a few seconds) from the active src buffer into a ring buffer in ~1ms — much faster than reading from disk.

**Playback flow per stem**: `vocals sourceSlot startFrac endFrac stretchRatio segDurMs` arrives → find src slot → if not loaded, load it (`read` message to `buffer~`) → `triggerCompose()` → `fluid.bufcompose~` copies segment → `ring_done` callback → swap ring active/staging → send `vocals ringSlot segDurMs stretchRatio` to `slot_router.js`.

**Bake snapshot**: `bakeSnapshot()` copies `ring_active → snap_` for all stems. `bakeRestore()` copies back. Ensures every training loop attempt starts from identical audio.

**Slot→track map**: populated by `sourceTrack slotIdx ...nameParts` messages from `slicer.js`. Maps slot 0 → "DREPTO CE3o", slot 1 → "other track", etc.

### `slot_router.js`
**Location:** `EBYS_INFRA/MAX/slot_router.js`
**Type:** Max JS object (`js slot_router.js`)

The only object that sends messages directly to `karma~` and `pfft~`/`gizmo~`. Owns all DSP parameters.

Receives `vocals ringSlot segDurMs stretchRatio` from `buffer_manager.js`:
- Sends `set ring_N_voc` to `karma~` (switch which buffer to play)
- Sends `seek 0` to `karma~` (start from beginning)
- Sends `delayMs` to the delay~ object (fires the next segment's pick)
- Sends `speedFactor = 1/stretchRatio` to `karma~`'s speed inlet (tape-style tempo stretch)

**Pitch axis** (independent of tempo): `setPitch stem ratio` or `setPitchSemitones stem n` sends a frequency ratio to `pfft~`/`gizmo~` per stem. Pitch shift doesn't affect playback duration.

### `stretch_player.js`
**Location:** `EBYS_INFRA/MAX/stretch_player.js`
**Type:** Max JS object — **superseded**

Earlier approach to time-stretching: used `fluid.bufselect~` → `fluid.bufstretch~` → `play~` chain. Replaced by the ring buffer + karma~ architecture (which does tape-style stretching without FluCoMa). Kept in the patch for reference/fallback.

### `track_loader.js`
**Location:** `EBYS_INFRA/MAX/track_loader.js`
**Type:** Max JS object — **superseded**

Older multi-track loader. Scanned `htdemucs/` at startup, sorted tracks alphabetically (important — slicer.js uses the same sort for slot assignment), and sent `read` messages to `play_N_*` buffers. The `play_*` buffer naming convention was replaced by `src_*` + `ring_*` in the ring buffer upgrade; `buffer_manager.js` now handles this. Kept for reference.

### `bake_manager.js`
**Location:** `EBYS_INFRA/MAX/bake_manager.js`
**Type:** Max JS object (`js bake_manager.js`)

Handles the training snapshot system for the `:bake` workflow. `bakeSnapshot()` copies all ring buffers to snap buffers at `:bake` start. `bakeRestore()` copies back at every loop reset. This guarantees every training iteration starts from identical audio so the model only sees the effect of command changes, not audio drift.

Note: `bake_manager.js` uses `fluid.bufcompose~` via 16 outlets. `buffer_manager.js` also has bake logic built in (outlets 14–17) with simplified single-snap-per-stem approach. The two coexist in the patch; `buffer_manager.js` is the current path.

### `clear_stems.js`
**Location:** `EBYS_INFRA/MAX/clear_stems.js`
**Type:** Max JS object

Deletes all `.wav` files from the stems folder path (hardcoded to an old Desktop path). One-shot utility for resetting the stems library during development. Path is stale — not used in production.

---

## 7. Stage 5 — AI Brain (Cricket)

### `cricket.js`
**Location:** `EBYS_INFRA/MAX/cricket.js`
**Type:** Max Node.js object (`node.script cricket.js`)

EBYS's AI personality. Bridges Max to a locally running Ollama LLM (default: `llama3.1:latest`). 

Receives `ask <text>` from Max. Sends to Ollama `/api/chat` with a detailed system prompt that describes: what Cricket is (a dry, present DJ personality), what all the engine parameters mean, a translation guide (e.g. "sparse → setSegmentBars 8, setStayProb 0.5"), and how to mix prose and commands in the same response.

Ollama returns a text response. `cricket.js` parses each line: lines that look like engine commands (e.g. `setSegmentBars 2`) are emitted as Max atoms via outlet 0 → `route` object → correct parameter handler. Lines that are prose are also emitted (for the TUI to display as Cricket's "speech").

The model never sees the commands being sent — only users see Cricket's words, so it can narrate what it's doing.

### `TUI/cricket-voice.js`
**Location:** `EBYS_INFRA/TUI/cricket-voice.js`
**Type:** Standalone Node.js script

Training session tool for building Cricket's voice. You type freely; everything is saved to `voice_samples.md`. Commands:
- `:bake` — sends samples to Ollama to distill a personality profile into `voice.md`
- `:bakefranglais` — bakes Q&A examples into an Ollama `Modelfile`
- `:rule "..."` — adds a behavioral rule to `rules.md`

Not used during live performance — only for training/persona development.

### `TUI/test-ollama.js`
**Location:** `EBYS_INFRA/TUI/test-ollama.js`
**Type:** Standalone Node.js diagnostic script

Quick Ollama connectivity test. Lists available models, sends a test message, and prints which model string to use in `sdj-tui.js CONFIG.ollama_model`.

### `convert_bakes.py`
**Location:** `EBYS_INFRA/convert_bakes.py`
**Type:** Python script

Converts `training_log.jsonl` (raw `:bake` snapshots from live sessions) into `cricket_finetune.jsonl` (MLX/Llama fine-tuning format). Each bake snapshot becomes one training example: intent + live descriptor state → final engine commands. Includes user corrections in the ground truth.

### `finetune.sh`
**Location:** `EBYS_INFRA/finetune.sh`
**Type:** Shell script

End-to-end fine-tuning pipeline for Cricket on Apple Silicon:
1. Calls `convert_bakes.py` to prepare training data
2. Runs `mlx_lm.lora` (MLX LoRA fine-tuning, batch=1, 8 layers, 600 iters)
3. Saves adapter to `cricket_lora/`

Requires 200+ bakes for meaningful results. Takes 1-3 hours on Apple Silicon. The trained adapter is local-only (never uploaded).

---

## 8. Stage 6 — Terminal UI (TUI)

### `TUI/sdj-tui.js`
**Location:** `EBYS_INFRA/TUI/sdj-tui.js`
**Type:** Standalone Node.js app (`node sdj-tui.js`)
**Dependencies:** `blessed` (terminal UI), `ws` (WebSocket)

The control surface for EBYS. A rich terminal dashboard showing:
- Live descriptor readouts per stem (C, S, E, F, P, H, T) with trend arrows
- Slice position bar, segment duration, BPM, key
- Mix loudness (LUFS, dBFS)
- Active genre label
- System log

Connects to `ws_server.js` on port 8080. On connect: sends `buildIndex` if analysis is done. Reconnects every 3s on disconnect.

**Command input**: user types commands that are sent to Max via WebSocket:
- `:bars 2` → `setSegmentBars 2` → slicer.js
- `:brighter` → `setWeight C 3.0, setDirPref C 1` → slicer.js
- `:bake` → saves a snapshot to `training_log.jsonl`
- `:pitchShift melody 3` → `pitchShift melody 3` → ws_server → slot_router.js
- `:start` / `:stop`
- Natural language → sent to Cricket (Ollama) → engine commands back

Also sends `:buildIndex` after a new track is analyzed (detected via `streamUpdated` WebSocket event).

**Genre display**: pre-loads `genres.json` at startup to show genre labels alongside stem descriptors.

**Follow graph**: internal model of which stems "follow" which — allows asymmetric cross-stem influence weighting.

---

## 9. Data Files Reference

### `analysis_library.json`
**Location:** `EBYS_INFRA/MAX/`
**Size:** ~1MB
**Written by:** `slice_writer.js`
**Read by:** `ws_server.js` (prepareLibraryDict), `analyze_reader.js` (loadRegistry)

Raw FluCoMa analysis output. One entry per stem file. Structure:
```json
{
  "<TrackName>_vocals.wav": {
    "vocals": {
      "metadata": { "track_name": "...", "BPM": 128, "BPM_confidence": 0.91, "key": "C major" },
      "slices": {
        "slice_0001": { "time": 0.023, "C": 2300, "E": -24.1, "F": 0.42, "P": 440, "H": 0.7, "M0": ..., "M5": ... }
      }
    }
  }
}
```

### `ebys_index.json`
**Location:** `EBYS_INFRA/MAX/`
**Size:** ~2.8MB (larger than analysis_library — adds derived fields)
**Written by:** `slicer.js` (via saveIdxChunk → ws_server.js)
**Read by:** `ws_server.js` (cached, sent to slicer on TUI connect)

The pre-built slice database. Extends `analysis_library.json` with computed fields: UMAP 2D coordinates, tension values (tC, tE, tF, tP, tH, tT), genre tags, sourceTrack name per slice, delta values (descriptor change from previous slice). This is what slicer.js indexes for fast lookup — rebuilding it takes ~10s (FluCoMa + t-SNE), so it's cached and only rebuilt when new tracks are added.

### `downbeats.json`
**Location:** `EBYS_INFRA/` (NOT in MAX/)
**Written by:** `madmom_tagger.py`
**Read by:** `ws_server.js` (sends via downbeatchunk on TUI connect) → `slicer.js`

Musical timing data per track:
```json
{
  "DREPTO CE3o": {
    "meter": 4,
    "bpm": 128.3,
    "avgBarMs": 1873.2,
    "downbeats_ms": [0.0, 1873.2, 3746.4, ...],
    "confidence": 0.94
  }
}
```
slicer.js uses this to classify slices as "near-downbeat" or not. Near-downbeat slices go into the `aligned[]` pool (preferred for segment transitions). Keyed by source track name (e.g. `"DREPTO CE3o"` not `"DREPTO CE3o_vocals.wav"`).

### `umap_coords.json`
**Location:** `EBYS_INFRA/MAX/`
**Written by:** `ws_server.js` (from tsne_worker results)
**Read by:** `slicer.js` (merged into ebys_index)

2D t-SNE coordinates for every slice, per stem:
```json
{ "vocals": { "slice_0001": [12.3, -4.7], ... }, "melody": {...} }
```
Used by the TUI spatial navigator so the user can click/drag to select slices by sonic similarity.

### `stem_ranges.json`
**Location:** `EBYS_INFRA/MAX/`
**Written by:** `ws_server.js` (computeAndWriteUMAP, synchronous phase)
**Read by:** `slicer.js`

Descriptor min/max per stem, used for normalizing values before UMAP display and for the TUI's descriptor bar scaling:
```json
{ "vocals": { "C": { "min": 669, "max": 12152 }, "E": { "min": -53.6, "max": -18.8 }, ... } }
```

### `genres.json`
**Location:** `EBYS_INFRA/`
**Written by:** `genre_tagger.py`
**Read by:** `ws_server.js` (sent as genrechunk to slicer), `sdj-tui.js` (direct read)

Genre classification results per track name. Top-N genres with confidence scores from the Discogs-EffNet 400-class model.

### `dict_analysis.json`
**Location:** `EBYS_INFRA/MAX/`
**Written by:** Max `dict` export

A Max dict export snapshot — likely a manual debug export of the `analysisLib` dict. Not used in the automated pipeline.

### `ebys_feed_vocals.json`
**Location:** `EBYS_INFRA/MAX/`

Partial analysis export for the vocals stem only. Likely a debug snapshot or test feed. Not part of the main pipeline.

### `archive/analysis/features.json`
**Location:** `EBYS_INFRA/archive/analysis/`

Archived early analysis format. Predates the current `analysis_library.json` schema. Not used.

### `package.json` (MAX)
**Location:** `EBYS_INFRA/MAX/package.json`
**Dependencies:** `ws ^8.21.0`

Node.js package manifest for the Max-side scripts. The `ws` package is used by `ws_server.js` for the WebSocket server.

### `package.json` (TUI)
**Location:** `EBYS_INFRA/TUI/package.json`
**Dependencies:** `blessed ^0.1.81`, `ws ^8.21.0`

TUI Node.js manifest. `blessed` for the terminal UI, `ws` for the WebSocket client.

### `essentia_models/genre_discogs400_labels.json`
**Location:** `EBYS_INFRA/essentia_models/`
**Written by:** `extract_labels.py` or downloaded

The 400 genre class names for the Discogs-EffNet model. Without this file, `genre_tagger.py` falls back to numeric class IDs (`class_001`, etc.).

---

## 10. Max Patch Infrastructure

### Patch Evolution Scripts (`patch_*.py`)

These Python scripts directly edit `ebys-analyze.maxpat` (which is a JSON file) to add/remove/rewire objects without touching the Max GUI. Each creates a `.bak` before modifying.

| Script | What it did |
|---|---|
| `patch_multitrack_upgrade.py` | Renamed `play_*` → `play_0_*`, added `play_1_*` slot 1 buffers, wired `slot_router.js`, removed old route→unpack routing |
| `patch_ring_buffer_upgrade.py` | Renamed `play_0/1_*` → `src_0/1_*`, added `ring_0/1_*` buffers, replaced `track_loader.js` with `buffer_manager.js`, added `fluid.bufcompose~` objects |
| `patch_cleanup.py` | Removed 25 dead objects (orphaned unpack/*/- chains, label boxes) left after the multitrack upgrade |
| `patch_tighten2.py` | UI tightening pass 2 |
| `patch_tighten3.py` | UI tightening pass 3 |
| `patch_tighten4.py` | UI tightening pass 4 |
| `patch_bake_snapshot.py` | Added bake snapshot wiring (snap_* buffers, bake_manager.js connections) |

### `extract_labels.py`
**Location:** `EBYS_INFRA/extract_labels.py`
**Type:** Utility script

Attempts to extract the 400 genre class names from the Essentia `.pb` model files. Tries three methods: TensorFlow SignatureDef extraction, GitHub download, and class-count inference. Writes `genre_discogs400_labels.json`. Run once during setup.

### `ai_edit_file.py` / `ai_readme.py`
**Location:** `EBYS_INFRA/`
**Type:** Ollama-powered utility scripts

Small developer tools that use Ollama locally: `ai_edit_file.py` rewrites a text file with AI assistance (shows a preview, asks for confirmation before overwriting). `ai_readme.py` starts a Q&A loop about the README. Neither is part of the EBYS runtime.

---

## 11. System Services & DevTools

### `com.ebys.watchdemucs.plist`
**Location:** `EBYS_INFRA/com.ebys.watchdemucs.plist`
**Type:** macOS LaunchAgent plist

Runs `watch_demucs.py` automatically at login and keeps it alive if it crashes. Install with:
```bash
cp com.ebys.watchdemucs.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ebys.watchdemucs.plist
```

Logs stdout and stderr to `EBYS_INFRA/logs/watchdemucs.log`. Uses `demucs_env/bin/python3` (the venv that has torch).

### `finetune.sh`
See Stage 5 (Cricket). Shell script for MLX LoRA fine-tuning of the Cricket model on Apple Silicon.

---

## 12. Archive / BAK Files

These are automatic backups created by the patch evolution scripts before each modification. They capture the patch state at each architectural milestone and can be used to roll back.

| File | State captured |
|---|---|
| `EBYS_ANALYZE.maxpat.bak` | Generic most-recent backup |
| `EBYS_ANALYZE.maxpat.pre_multitrack.bak` | Before multi-track upgrade (single-track era) |
| `EBYS_ANALYZE.maxpat.pre_ringbuf.bak` | Before ring buffer upgrade (play_0/1_* era) |
| `ebys-analyze.maxpat.pre_bake_snapshot.bak` | Before bake snapshot wiring |
| `ebys-analyze.maxpat.pre_cleanup.bak` | Before dead object cleanup |
| `ebys-analyze.maxpat.pre_tighten2/3/4.bak` | Before each UI tightening pass |
| `UPLOAD_DMC.bpatcher.maxpat.bak` | Backup of the Demucs upload bpatcher |

---

## Quick Reference: Who Talks to Whom

```
watch_demucs.py
  → writes: stems/htdemucs/<Track>/<Track>_*.wav
  → writes: EBYS_INFRA/downbeats.json
  → writes: EBYS_INFRA/genres.json
  → writes: EBYS_INFRA/temp/stream.txt
  → POSTs:  ws_server :8080/progress (pipeline stage updates)

streamWatcher.js
  → reads:  stream.txt (polls every 1s)
  → bangs:  Max analysis counter → analyze_reader.js

analyze_reader.js
  → reads:  FluCoMa buf~ objects in Max
  → sends:  slice descriptors → slice_writer.js (outlet 0)

slice_writer.js
  → writes: dict analysisLib (Max dict)
  → writes: MAX/analysis_library.json

ws_server.js
  → reads:  MAX/analysis_library.json (via Max dict chunks)
  → reads:  EBYS_INFRA/downbeats.json
  → reads:  EBYS_INFRA/genres.json
  → reads:  MAX/ebys_index.json (cached)
  → spawns: tsne_worker.js (Worker thread)
  → writes: MAX/umap_coords.json
  → writes: MAX/stem_ranges.json
  → writes: MAX/ebys_index.json (reassembled from saveIdxChunk)
  → outlet: idxchunk → slicer.js
  → outlet: downbeatchunk → slicer.js
  → WS broadcast → sdj-tui.js

slicer.js
  → reads:  idxchunk (ebys_index, from ws_server)
  → reads:  downbeatchunk (downbeats, from ws_server)
  → sends:  play commands → buffer_manager.js
  → outlet: desc/seg/slices → ws_server → TUI

buffer_manager.js
  → reads:  src_N_* buffer~ (disk WAV files)
  → triggers: fluid.bufcompose~ (src → ring copy)
  → sends:  ringSlot/segDurMs/stretchRatio → slot_router.js

slot_router.js
  → sends:  set/seek → karma~ (playback)
  → sends:  speed factor → karma~ right inlet (tape stretch)
  → sends:  pitch ratio → pfft~/gizmo~ (independent pitch shift)

cricket.js
  → reads:  ask <text> from Max
  → POSTs:  Ollama /api/chat (localhost:11434)
  → outlet: engine commands → route → slicer/ws_server params

sdj-tui.js
  → WS: connects to ws_server :8080
  → sends: buildIndex, setWeight, setMatchProb, start/stop, pitchShift, :bake
  → receives: desc, seg, meter, state, slices, pipelineStage
```
