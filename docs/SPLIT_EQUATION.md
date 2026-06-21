# Split Equation — How Tips Are Divided

When a listener tips a mix, the payment is split between the curator (DJ) and the contributing artists. The curator earns a share proportional to how much they actively authored the result. Artists split the remainder according to the follow graph.

```
artist_pool = 1 - curator_share
```

---

## Bottom Up

The system is bottom up. Artists are the raw material. The curator shapes from what exists. The tip flows back down to the source. Value originates at the track level, rises through curation, returns to where it came from.

---

## What EBYS Knows at Tip Time

EBYS has full visibility into the mix at every moment:

- Which slices are playing across all 4 stems (vocals, melody, bass, drums)
- Which track each slice came from
- How many distinct tracks are contributing
- How rapidly EBYS has been switching between sources
- How spectrally different those sources are from each other
- The full `followStem` graph — who is following who, and at what weight

---

## The Curator's Share

The curator earns more when the mix is more inventive — more sources, more active switching, more spectral contrast between them. If only one track is playing, the curator earns nothing.

```
curator_share = (1 - 1/N) × edit_rate_normalized × avg_descriptor_distance
```

Where:
- **N** = number of distinct source tracks. N=1 → curator share = 0.
- **edit_rate_normalized** = how frequently EBYS switched between sources.
- **avg_descriptor_distance** = how spectrally different the combined slices were.

The curator's credit comes entirely from contrast and activity — not from the music itself.

---

## The Artist Split

Artists split `(1 - curator_share)` using an 80/20 rule, modifiable by the user. 80% is distributed equally — every stem gets paid just for being present. The remaining 20% is distributed unequally according to the follow graph. The more attention other stems point at you, the larger your share of that 20%.

**Variables:**
- π_i = payout for stem i (as a fraction of the artist pool)
- N = number of stems = 4
- Φᵢ = sum of all follow weights pointing at stem i
- Φ = sum of all follow weights in the entire graph

```
πᵢ = 0.8/N  +  0.2 · (Φᵢ / Φ)
```

```
payout[i] = (0.8 / N)  +  0.2 * (sum_incoming[i] / total_follows)
```

N = 4, so the base simplifies to:

```
πᵢ = 0.2  +  0.2 · (Φᵢ / Φ)
```

```
payout[i] = 0.2  +  0.2 * (sum_incoming[i] / total_follows)
```

Existence share + proportional share of attention.

The default state — every stem following itself at 100% — produces a perfectly equal split. The equation only redistributes when the graph becomes asymmetric.

---

## The Influence Score

Influence is how much total attention from other stems is pointed at a given stem. The follow percentage is the signal — no weighting, no authority multiplier.

**Step 1 — Sum incoming follows per stem:**
```
influence[stem] = sum of all follow(j → stem) for every j
```

**Step 2 — Normalise** so all shares sum to 1.0:
```
normalised[stem] = influence[stem] / sum(all influences)
```

A stem with no incoming follows gets 0% of the influence pool — but still receives its full base share from the 80% layer.

---

## Worked Example

**Setup (`:followStem` commands in effect at tip time):**
- vocals → drums at 60%
- vocals → melody at 20%
- bass → drums at 40%

**Step 1 — Sum incoming follows:**
```
drums  = 60 + 40 = 100 pts
melody = 20       =  20 pts
vocals = 0        =   0 pts
bass   = 0        =   0 pts

total  = 120 pts
```

**Step 2 — Normalise (divide each by 120):**
```
drums  = 100 / 120 = 83.3%
melody =  20 / 120 = 16.7%
vocals =   0 / 120 =  0%
bass   =   0 / 120 =  0%
```

**Step 3 — Final payout (base 80% + influence pool 20%):**
```
drums  = 20% + (20% × 0.833) = 36.7%
melody = 20% + (20% × 0.167) = 23.3%
vocals = 20% + (20% × 0)     = 20.0%
bass   = 20% + (20% × 0)     = 20.0%
```

**Total = 100%** ✓

Drums earns the most because the most read-head attention is structurally pointed at it. Vocals and bass earn only their base — the influence pool rewards being followed, not following.

---

## The Role at the Moment of the Tip

The mix is a fire — leaders interchange constantly. The split is calculated at the moment the tip is sent, from the follow graph active at that exact second. The math is local to the tip, the fairness is global over time.

---

## Open Questions

- Should deep chain influence dilute further with each step, or stay proportional?
- How to handle a stem with no follow relationships at all — equal base only?
