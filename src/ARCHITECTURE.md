# EBYS Architecture

## Three Phases

### Analysis Phase — run once per track

```
Original mix file (mp3/wav)
    → genre_tagger.py      Essentia + Discogs-EffNet → genres.json
    → madmom_tagger.py     madmom DBNDownBeatTracker → downbeats.json
    → Demucs               stem separation → htdemucs/TrackName/{vocals,drums,bass,other}.wav

Separated stems (in Max)
    → FluCoMa objects      onset detection, spectral shape, loudness, pitch, chroma, MFCC
    → analyze_reader.js    reads FluCoMa buffers, orchestrates write sequence
    → slice_writer.js      formats and commits descriptors
    → analysis_library.json    permanent store on disk
```

**Essentia** (`genre_tagger.py`) classifies the original mix using the Discogs-EffNet model — always the full mix, never the stems, since the model was trained on complete tracks.

**Madmom** (`madmom_tagger.py`) runs downbeat tracking on the original mix to extract time signature, BPM, and the timestamp of every bar 1. This feeds `downbeats.json`, which `slicer.js` reads at playback time to snap segment boundaries to the nearest bar.

`analyze_reader.js` reads `stream.txt` to know which stems to process, drives FluCoMa's onset detection / spectral / loudness / pitch / chroma / MFCC buffers, then sends all descriptor values to `slice_writer.js`, which commits them to `analysis_library.json`.

---

### Playback Phase — every session

```
analysis_library.json  ──┐
genres.json            ──┤→ ws_server.js    reads all three files via Node.js, sends as 2 KB chunks
downbeats.json         ──┘       ↓
                            slicer.js        assembles chunks, builds index, tags slices with genre,
                                             snaps segment starts to bar 1 timestamps from downbeats
                                ↓  outlet 0: stem  slot  startFrac  endFrac  stretchRatio  segDurMs
                        buffer_manager.js    2-level ring buffer (src buffers → ring buffers via fluid.bufcompose~)
                                ↓  outlet 12: stem  ringSlot  segDurMs  stretchRatio
                          slot_router.js     audio engine hub — translates play commands to DSP messages:
                                             · karma~ right inlet ← speedFactor (1/stretchRatio)  [tempo axis]
                                             · karma~ left inlet  ← "set ring_N_stem" + seek 0    [buffer switch]
                                             · pfft~/gizmo~       ← pitch ratio per stem          [pitch axis]
                                ↓
                     karma~ → pfft~/gizmo~   karma~ plays at variable speed (tape stretch);
                                             pfft~/gizmo~ shifts pitch independently per stem
```

`ws_server.js` is the bridge between the TUI (WebSocket) and the Max patch (N4M). It reads all three data files via Node.js (no size limit) and delivers them to `slicer.js` in 2 KB chunks over Max's message bus, because Max's built-in JS engine has a hard 32 767-byte file read limit.

`slicer.js` uses the data as follows:
- **analysis_library.json** — slice descriptors (C, S, E, F, P, H, T) and BPM per stem per track
- **genres.json** — top-5 genre tags per track, stored on each slice for runtime filtering
- **downbeats.json** — bar 1 timestamps per track, used to snap segment starts to the nearest downbeat

---

## Key Files

| File | Role |
|------|------|
| `genre_tagger.py` | Essentia — classifies original mix → `genres.json` |
| `madmom_tagger.py` | Madmom — downbeat tracking on original mix → `downbeats.json` |
| `analysis_library.json` | Permanent descriptor store — written by analysis, read by playback (descriptors: C S E F P H T) |
| `downbeats.json` | Bar timestamps per track — used by slicer for bar-aligned segment starts |
| `genres.json` | Genre classification results per track — fed to slicer for runtime filtering |
| `analyze_reader.js` | Analysis orchestrator — reads FluCoMa buffers, drives slice_writer |
| `slice_writer.js` | Writes slice descriptors and metadata to analysis_library.json |
| `ws_server.js` | WebSocket bridge (Node.js / N4M) — reads library, delivers chunks to slicer |
| `slicer.js` | **Sequencing brain** — assembles library, builds index, picks segments, owns transport |
| `buffer_manager.js` | 2-level ring buffer manager — loads stems, drives fluid.bufcompose~ |
| `slot_router.js` | **Audio engine hub** — sole owner of karma~/pfft~ messages; tempo axis (speed) + pitch axis (gizmo~) |
| `ebys-pitch.maxpat` | pfft~ subpatch — `fftin~` → `gizmo~` → `fftout~`; `in 2` receives pitch ratio from slot_router |
| `CRICKET.md` | Cricket's operational memory — descriptor meanings, command vocabulary, musical translations |
| `training_log.jsonl` | Append-only bake log — intent + Cricket commands + user corrections + live descriptor state |
| `convert_bakes.py` | Converts `training_log.jsonl` → MLX fine-tuning JSONL (instruction/response pairs) |
| `finetune.sh` | LoRA fine-tune on Apple Silicon via `mlx-lm` — produces a Cricket model tuned to your taste |

---

---

### Training Phase — ongoing, session-by-session

Cricket is a local Ollama language model that controls EBYS through natural language. Over time it learns your taste via a correction loop:

```
User instruction ("make it darker")
          │
          ▼
    Cricket (Ollama LLM)        interprets intent → outputs slicer commands
          │
          ▼
    User listens → corrects     sends additional commands manually if needed
          │
          ▼
    :bake                       TUI command — writes a training snapshot
          │
          ▼
    training_log.jsonl          append-only JSONL, one line per bake:
                                  intent, cricket_cmds, user_corrections,
                                  final_cmds, live descriptor state (C/S/E/F/P/H/T),
                                  track name, BPM at bake time
```

The **correction delta** is the training signal — not just "darker = these commands" but "when Cricket tried X and you corrected to Y, Y was closer to what darker means in this context and this descriptor state."

After enough bakes (200–500), the log becomes a fine-tuning dataset:

```
training_log.jsonl
          │
          ▼
    convert_bakes.py            converts bake snapshots → MLX fine-tuning JSONL
                                (instruction/response pairs with descriptor context)
          │
          ▼
    finetune.sh                 one-command LoRA fine-tune on Apple Silicon via mlx-lm
                                (runs inside ~/ebys-mlx-env)
          │
          ▼
    fine-tuned local model      Cricket that knows this library and your taste specifically
```

This loop runs offline, entirely on-device. No data leaves the machine.

---

## Genre Filtering

Once `buildIndex` has run, every slice in the index carries a `genres` array from `genres.json`. You can filter playback by genre at any time with TUI commands:

```
setGenreFilter Techno      # only play slices from tracks tagged with "Techno"
setGenreFilter Deep House  # substring match, case-insensitive
clearGenreFilter           # back to all tracks
listGenres                 # print available genres to the Max console
```

If the filter matches nothing for a given stem, slicer falls back to all slices for that stem so playback never stops.

---

## Why Chunks?

Max's built-in JavaScript engine caps file reads at **32 767 bytes**. `analysis_library.json` is ~1 MB. Rather than fight that limit, `ws_server.js` (Node.js, no restrictions) reads the file and sends it to `slicer.js` broken into 2 KB pieces. Slicer glues them back together in memory before parsing.
