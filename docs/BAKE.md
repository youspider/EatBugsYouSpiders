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

**`:bake start <label>`** requires a natural language label naming the session. The label can be a single behavior ("rise") or a phrase ("rise into drop", "tension release"). The label is what the model will learn to map to. The current `:bakeloop` value defines the loop length.

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

During a bake bracket, the probabilistic engine does not make autonomous decisions. Specifically:

- **Slicer does not advance** on its own — no spontaneous jumps to new positions
- **Track loading is frozen** — buffer_manager does not swap in new content
- **Follow graph is frozen** — no autonomous graph updates

What stays active:
- The audio engine — EBYS is still playing
- Descriptor analysis — still computing in real time, the user needs feedback
- All commands — the user has full control

The lock is not silence and not pause. It is the removal of the system's agency for the duration of the session. The user is the only agent making decisions until `:bake end` or `:bake abort`.

---

## Edge Cases

**`:bake end` without `:bake start`** — ignored or error. Nothing to close.

**`:bake start` while a bracket is already open** — either error, or implicitly abort the previous session and open a new one. TBD.

**User calls `:bake end` on first attempt without any correction** — valid. One attempt stored as both first and last. The machine's initial translation was already good enough.

---

## TODO

- Define how the trajectory is normalized for duration
- Define the training file format (JSON sequence? binary?)
- Define how `:bake start` triggers the NL → command translation pipeline
- Wire snapshot capture and reset into slicer.js and buffer_manager.js
- Decide behavior of `:bake start` when bracket already open
