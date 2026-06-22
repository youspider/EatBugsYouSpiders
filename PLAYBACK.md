# EBYS Playback Engine — Architecture

## Concept

EBYS has **four independent stem channels**: vocals, melody, bass, drums.

Each channel **always plays its own stem type**. What changes is the *source track* — the specific recorded track the audio is pulled from.

Example sequence on the vocals channel:

```
439 ISMT vocals  →  DREPTO CE3o vocals  →  439 ISMT vocals  →  DREPTO CE3o vocals …
```

The bass channel runs its own independent sequence:

```
DREPTO CE3o bass  →  439 ISMT bass  →  DREPTO CE3o bass …
```

At any given moment you might be hearing 439 ISMT vocals over DREPTO bass over 439 ISMT drums over DREPTO melody. This is the core generative behaviour.

---

## Terminology

| Term | Meaning |
|------|---------|
| **stem type** | One of: vocals, melody, bass, drums |
| **source track** | A demucs-separated recording (e.g. "439 ISMT", "DREPTO CE3o") |
| **slot** | Integer index assigned to each source track (sorted alphabetically). 439 ISMT = slot 0, DREPTO CE3o = slot 1, … |
| **slice** | A time segment within one source track's stem, identified by `{sourceTrack, stemType, startFrac, endFrac}` |
| **segment** | A consecutive run of slices (typically 4 bars) from a *single source track*, played end-to-end |

---

## Buffer Naming Convention

Each source track occupies one **slot** (0-based, alphabetical). For each slot there are four Max `buffer~` objects:

```
play_0_voc   play_0_drm   play_0_bss   play_0_mel
play_1_voc   play_1_drm   play_1_bss   play_1_mel
play_2_voc   play_2_drm   play_2_bss   play_2_mel
…  (up to MAX_SLOTS = 6)
```

Corresponding `karma~` objects read from these buffers:

```
karma~ play_0_voc  →  vocals playback (slot 0 active)
karma~ play_1_voc  →  vocals playback (slot 1 active)
```

When a new segment starts on the vocals channel, `karma~` receives `set play_N_voc` to switch to the right slot, then a seek position, then `play`.

---

## Slot Assignment

Slot numbers are assigned **alphabetically** by source track name at `buildIndex` time in `slicer.js`. `track_loader.js` uses the same sort order when loading files at startup, so slot 0 always means the same track in both JS files.

```
439 ISMT      → slot 0
DREPTO CE3o   → slot 1
(next track)  → slot 2
```

---

## Data Flow

```
Analysis library (analysis_library.json)
          │
          ▼
    slicer.js buildIndex()
    — reads ALL source tracks from library
    — assigns slot numbers (alphabetical)
    — builds byTrack['vocals'] = [ ...slices from ALL source tracks... ]
    — each slice carries: { sourceTrack, slot, stemDurMs, time, … }
          │
          ▼ outlet 0 per stem: "vocals  slot  startFrac  endFrac  stretchRatio  segDurMs"
          │
    ┌─────┴──────┐
    │            │
ws_server.js  buffer_manager.js
(→ TUI)       — loads audio from disk into src buffers
              — fluid.bufcompose~ copies segment → ring buffer
              — passes stretchRatio through to slot_router
                    │
                    ▼ outlet 12: "vocals  ringSlot  segDurMs  stretchRatio"
              slot_router.js  (audio engine hub)
              — karma~ right inlet ← 1/stretchRatio  (tape speed, pitch follows)
              — karma~ left inlet  ← "set ring_N_voc" + seek 0
              — delay timer ← segDurMs × stretchRatio
              — pfft~/gizmo~ ← pitch ratio per stem  (independent of tempo)
              — delay fires → "next vocals" → slicer picks new segment
```

### Two Audio Axes

| Axis | Object | Control | Effect |
|------|--------|---------|--------|
| Tempo | karma~ right inlet | `speedFactor = 1/stretchRatio` | Slower/faster playback; pitch follows (tape-style) |
| Pitch | pfft~/gizmo~ | `ratio = 2^(semitones/12)` | Frequency shift only; duration unchanged |

These are independent. A track can be slowed down (karma~) while its melody stem is transposed up (gizmo~) at the same time.

TUI command: `:pitchShift melody 3` → raises melody 3 semitones, no tempo change.

---

## Segment Selection (slicer.js)

`selectSegment(stemType)` draws from `byTrack[stemType]`, which contains slices from **all** source tracks mixed together. The pool can include any source track.

Once a **start slice** is chosen (random or by descriptor matching), the segment **stays within that source track** — consecutive slices are accumulated only while `arr[i].sourceTrack === startSlice.sourceTrack`. This ensures each segment is a coherent excerpt, not a mid-phrase cut between tracks.

The next `selectSegment()` call (triggered when the segment ends) is free to land on any source track again.

---

## outlet 0 Message Format (slicer.js → downstream)

```
vocals  slot  startFrac  endFrac  stretchRatio  segDurMs
```

| Field | Type | Description |
|-------|------|-------------|
| `vocals` | symbol | stem type — routes the message |
| `slot` | int | source track slot (0 = first alphabetical track) |
| `startFrac` | float 0–1 | segment start as fraction of source buffer |
| `endFrac` | float 0–1 | segment end as fraction of source buffer |
| `stretchRatio` | float | srcBPM / globalBPM (1.0 when no override) |
| `segDurMs` | int | segment duration in ms — used for delay timer |

---

## Load Sequence

1. **Patch opens** → `track_loader.js` scans `htdemucs/` folder (alphabetical)
2. For each track at slot N: loads `play_N_voc`, `play_N_drm`, `play_N_bss`, `play_N_mel`
3. After all buffers loaded → load gate fires → `buildIndex` → `start`
4. `buildIndex` reads `analysis_library.json`, builds multi-track slice index
5. `start` fires all four stems simultaneously → each loops independently via `next <stem>`

---

## Component Responsibilities

| File | Role |
|------|------|
| `slicer.js` | **Sequencing brain** — segment selection, multi-track index, transport (start/stop/next), BPM math. No DSP. |
| `buffer_manager.js` | 2-level ring buffer manager — loads src buffers from disk, drives fluid.bufcompose~, passes stretchRatio downstream |
| `slot_router.js` | **Audio engine hub** — sole owner of karma~/pfft~ messages. Two axes: tempo (karma~ speed) + pitch (pfft~/gizmo~). No sequencing logic. |
| `ebys-pitch.maxpat` | pfft~ subpatch — frequency-domain pitch shifter (gizmo~). Duration unchanged. |
| `ws_server.js` | Bridges Max ↔ TUI WebSocket; intercepts `:pitchShift` and routes to slot_router |
| `sdj-tui.js` | Terminal UI |
| `ebys-analyze.maxpat` | Max patch: audio graph, karma~ objects, ring buffer~, pfft~ objects, route/prepend wiring |

---

## Max Slots (MAX_SLOTS = 6)

The patch pre-allocates 6 × 4 = 24 playback `buffer~` objects (`play_0_voc` … `play_5_mel`). If you have more than 6 analyzed tracks only the first 6 (alphabetically) will play. Increase `MAX_SLOTS` in `track_loader.js` and add corresponding buffer objects in the patch to expand.
