# BAKE — Training the Machine on Behaviors

Baking is how EBYS learns what natural language commands mean for a specific user. Not as snapshots, but as behaviors — trajectories of machine parameters over time, corrected and approved by the user.

---

## The Problem With Slices

A single `:bake` at one moment can capture a state, but not a behavior. "Rise for 4 bars" has no meaning at a single point in time. Its meaning is the arc — the shape of how parameters move from start to finish. A slice cannot teach that. A trajectory can.

---

## The Commands

```
:bakeloop <bars>       set the loop window length (default: 4 bars)
:bake start <label>    open a training bracket for the named session
:bake end              close the bracket and store the session
:bake abort            close the bracket and discard everything
```

**`:bakeloop <bars>`** sets how long each loop runs before resetting to the snapshot. This is independent of the session label — set it before or during a bracket. The loop is the container. The behaviors the user triggers inside it are the content.

```
:bakeloop 8     ← each attempt loops for 8 bars
:bakeloop 2     ← tight 2-bar loop
:bakeloop 16    ← long phrase
```

**`:bake start <prompt>`** takes a free natural language prompt — not just a name, but the actual command fed to the machine's translation system. The machine interprets it and generates an initial parameter set from it, exactly as it would during a live session.

```
:bake start rise like a tornado
:bake start slow tension build then collapse
:bake start everything drops except the bass
```

The prompt is both the training label and the generative seed. Richer prompts produce more specific initial parameters — and give the model more to learn from when the user corrects them. The current `:bakeloop` value defines the loop length.

**`:bake end`** closes the bracket after the current loop finishes. The last *fully completed* loop is stored as the last attempt — the loop in progress when `:bake end` is called is discarded. If called mid-loop, the end is queued and fires automatically at the next loop boundary. Releases the system back to normal probabilistic operation.

**`:bake abort`** closes the bracket immediately, writes nothing. Use this when the session went nowhere and you don't want to pollute the model with a bad example.

---

## What Happens at `:bake start`

Three things at once:

**1. Translation.** The label is passed through the natural language → machine command system. EBYS generates an initial parameter set for that behavior — its best current interpretation of what "rise" (or whatever) means.

**2. Snapshot.** The current system state is captured exactly — which tracks are loaded, which slices are playing, the follow graph, the descriptor state. This is the starting point every attempt will reset to.

**3. Bracket opens.** Recording begins. The first attempt starts immediately from the snapshot, running on the machine's initial parameter translation.

---

## The Attempt Loop

The user listens to the first attempt. If it isn't right, they tweak the parameters — correct the commands, adjust weights, modify the behavior — then trigger the label again to start a new attempt.

Each new attempt:
- Ends the previous one
- Resets the system back to the snapshot (same sonic starting point)
- Runs from there with the current parameter state

The journey is completely free within each attempt. Track switching happens, slices advance, the system moves — that's intentional. "Rise" requires the system to move. The lock isn't on the journey, it's on the departure point. Every attempt leaves from the same place, so attempts are comparable.

```
:bakeloop 8
:bake start rise into drop
  → machine translates label → initial parameters
  → loop 1 runs (8 bars): user triggers "rise" bars 1–4, "drop" bars 5–8
    resets to snapshot  ← stored as FIRST
  → loop 2 runs: user refines the rise, drop feels off
    resets to snapshot  ← discarded
  → loop 3 runs: user refines the drop
    resets to snapshot  ← discarded
  → loop 4 runs: full arc feels right
  → loop 5 starts → user hits :bake end
  → loop 4 stored as LAST, loop 5 discarded, bracket closes
```

`:bake end` always stores the last *fully completed* loop. Calling it mid-loop queues the close for the next loop boundary — the user doesn't have to be perfectly on time.

The session label ("rise into drop") names the whole arc. The individual behaviors ("rise", "drop") are triggered by the user during the loop — the model learns the full trajectory, not just isolated moments.

Middle attempts are discarded. They are rehearsal, not training data.

---

## What Gets Stored

At `:bake end`, two records are written:

**First attempt** — the machine's initial interpretation of the label. What it thought "rise" meant before correction.

**Last attempt** — the user-approved version. What "rise" actually should have been.

Each record contains:
- The label ("rise")
- The parameter trajectory — timestamped sequence of (command, params) from attempt start to attempt end
- The snapshot state — the sonic starting point the attempt departed from
- Normalized duration — the trajectory is normalized to relative time so a 2-bar rise and a 16-bar rise have the same learned shape

If there is only one attempt (user triggers label once and calls `:bake end`), first and last are the same record. It is stored once.

---

## What the Model Learns

The pair of first + last is a correction signal. The model sees:

- "rise" generated parameter trajectory A (first attempt)
- the user corrected it to trajectory B (last attempt)
- here is what changed between A and B

Over multiple bake sessions the model converges. Each session it starts closer to the approved version. The user's corrections become less dramatic over time as the model internalizes what each behavior means for this specific user and system.

---

## The Snapshot Lock

The snapshot locks the **departure point**, not the journey.

At the start of every loop, EBYS resets to the exact state captured at `:bake start` — same slices, same tracks, same playback position. This is the stable base. Every loop departs from the same place so the user can hear corrections cleanly without the material shifting under them.

What resets every loop:
- **Playback position** — back to the snapshot slice
- **Track content** — same tracks loaded, no new material
- **Slicer position** — back to the starting slice

What carries over loop to loop:
- **Parameter state** — all corrections and tweaks the user made accumulate. The next loop runs with the updated parameters. The user doesn't re-enter anything — they just listen, adjust, and the next loop reflects the change.
- **Follow graph** — any `:followStem` commands issued during the session persist

What stays active throughout:
- The audio engine — EBYS is still playing
- Descriptor analysis — still computing in real time, the user needs feedback
- All commands — the user has full control

The probabilistic engine is suspended — no autonomous slice selection, no spontaneous track switching, no self-directed graph updates. The user is the only agent. The system plays, resets, and plays again — each time from the same starting point, each time with whatever the user has built so far.

---

## Edge Cases

**`:bake end` without `:bake start`** — ignored or error. Nothing to close.

**`:bake start` while a bracket is already open** — either error, or implicitly abort the previous session and open a new one. TBD.

**User calls `:bake end` on first attempt without any correction** — valid. One attempt stored as both first and last. The machine's initial translation was already good enough.

---

## Implementation Notes

**Ring buffer snapshot.** At `:bake start`, copy the full content of all active ring buffers (`ring_N_stem`) into dedicated snapshot buffers. On every loop reset, restore from those snapshot buffers before restarting playback. This guarantees identical material on every loop departure regardless of what `buffer_manager` does in the meantime.

**NL translation sequence.** `:bake start <prompt>` must follow this order:
1. Capture audio snapshot (ring buffer copy)
2. Send prompt to NL translator
3. Wait for translation to return
4. Apply translated parameters
5. Start loop 1

If loop 1 starts before translation returns, it runs on whatever parameters were active before the session — the first attempt is dirty. The user sees a brief pause at `:bake start` while translation processes. That is expected behavior, not a bug. NL command latency (a couple of seconds) is acceptable throughout the system — the user is listening and reacting, not operating in hard real-time.

**Generalization requires volume.** A bake session trains "rise like a tornado" from one specific starting material. The model learns "rise from this context." Many sessions across varied starting points are needed for the model to generalize the behavior across contexts.

---

## TODO

- Define how the trajectory is normalized for duration
- Define the training file format (JSON sequence? binary?)
- Wire snapshot buffer copy/restore into buffer_manager.js
- Decide behavior of `:bake start` when bracket already open
