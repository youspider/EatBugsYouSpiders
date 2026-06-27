# EBYS LINK Protocol

A custom open network protocol for synchronizing two or more EBYS-A1 units in a live performance context. Unlike Ableton Link (tempo/beat only), EBYS LINK transmits generative state — descriptor weights, directional preferences, entropy, and audio parameters — allowing two units to converge, diverge, and interact compositionally.

---

## Philosophy

EBYS LINK is not automatic sync. It is a deliberate performance gesture. The DJ chooses what to send and when to send it. The receiving unit chooses whether to accept it.

Two units can drift apart independently — different weights, different entropy, different BPM — then snap into alignment on demand. The tension between divergence and alignment is the musical material.

---

## The Missile Switch

A safety-cover toggle switch on the EBYS-A1 panel is the primary LINK control. What it sends depends on the current selection context, built by drilling down through the channel strip controls before firing.

---

## Send Scope — Hierarchical Drill-Down

The scope of a missile switch fire is determined by how far down the selection tree the DJ has navigated:

```
(no context)
    → flip switch = last touched parameter only

hold track button (button under channel fader)
    → flip switch = full descriptor state for that channel
                    (all weights + all dirs)

hold track button → press 1 (setWeight) or 2 (setDir)
    → flip switch = all weights OR all dirs for that channel

hold track button → press 1 or 2 → touch descriptor encoder (e.g. C)
    → flip switch = single descriptor (e.g. setWeight C)
```

Each step narrows the scope. The missile switch fires at whatever level the DJ stopped at.

### Examples

```
flip switch (no context)            →  sends: setWeight C 3.0   (last touched)
hold VOC + flip                     →  sends: all VOC weights + dirs
hold VOC + press 1 + flip           →  sends: all VOC setWeights
hold VOC + press 1 + touch C + flip →  sends: setWeight VOC C 3.0
```

### Full state dump
Hold the missile switch for 2 seconds (no channel context needed). Sends the complete current state of all parameters:

```
setTempo 124.0
setBeat <current phase>
setWeight C 3.0
setWeight S 1.0
setWeight E 2.5
setWeight F 0.5
setWeight P 1.5
setWeight H 1.0
setWeight T 1.5
setDirPref C 0.8
setDirPref S 0.2
... (all descriptors, all stems)
setEntropy 0.4
setMatchProb 0.6
setStayProb 0.3
setDirWeight 1.2
```

A progress bar on the TUI screen fills during the hold, confirming a full dump is about to fire.

The receiving unit applies all parameters simultaneously on the next beat boundary to avoid discontinuities.

---

## Hardware Controls Involved

- **Track button** (button under each channel fader) — selects channel context when held
- **1 / 2 buttons** in the descriptor section — selects setWeight (1) or setDir (2) scope
- **Descriptor encoders** (C S E F P H T) — narrows to a single descriptor when touched
- **Missile switch** — fires the transmission at the current scope level

---

## Sync Layers

Parameters are grouped into sync layers. The receiving unit can accept or reject by layer:

| Layer | Parameters |
|-------|-----------|
| TEMPO | BPM, beat phase |
| WEIGHT | setWeight per descriptor, per stem |
| DIR | setDirPref per descriptor, per stem |
| ENTROPY | setMatchProb, setStayProb, setDirWeight, entropy macro |

Individual sends always bypass layer filtering — they go through regardless. Layer filtering only applies to full state dumps.

---

## Receive Side

The receiving unit displays incoming transmissions on the TUI screen:

```
INCOMING ─────────────────────
  from: EBYS-A1 [unit name]
  param: setWeight C 3.0
  [ACCEPT]  [REJECT]
──────────────────────────────
```

A second missile switch on the receiving unit accepts or rejects. Or the unit can be set to **auto-accept** mode — all incoming transmissions apply immediately without confirmation.

Auto-accept is useful for follower/leader setups where one unit always mirrors the other. Manual accept is for adversarial or collaborative performance where both DJs have agency.

---

## Transport

- **Protocol**: UDP broadcast over local network
- **Port**: TBD (custom, open standard)
- **Discovery**: Devices announce themselves on join via broadcast ping
- **Format**: Plain text commands (same syntax as TUI commands)
- **Latency target**: < 10ms on local network
- **Clock sync**: Ableton Link (open source SDK, Apache 2.0) handles tempo and beat phase alignment

EBYS LINK handles generative state. Ableton Link handles clock. They run in parallel.

---

## Hardware

- **Ethernet RJ45** on back panel — primary LINK connection
- **Missile switch with safety cover** on front panel — send control
- **TUI screen** — displays outgoing last-touched parameter, incoming transmissions, accept/reject prompt
- **Unit name** — configurable in TUI, used to identify source in multi-unit setups

---

## Multi-Unit

More than two units on the same network form a LINK session. Each missile switch tap broadcasts to all connected units. Each unit independently accepts or rejects incoming transmissions.

In a multi-unit setup, the screen shows the source unit name so the receiving DJ knows who is sending.

---

## Open Standard

EBYS LINK is an open protocol. Specification will be published so any compatible system can implement it. Command syntax mirrors the EBYS TUI command set, making it human-readable and easy to implement in any language.
