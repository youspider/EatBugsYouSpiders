# Split Equation — How Tips Are Divided

When a listener tips a mix, the payment is split between the curator (DJ) and the contributing artists.

By default:
- **Curator** receives a guaranteed floor of **40%**
- **Artists** receive the remaining **60%**

The curator can earn above the floor through creative contribution — but that extra comes directly out of the artist pool. The more the curator invents, the more they claim. The artists keep what the curator doesn't earn.

```
curator_share = floor + (1 − floor) × creative_factor
artist_pool   = 1 − curator_share
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
- How many different genres are blended together
- The full `followStem` graph — who is following who, and at what weight

---

## The Curator's Share

The curator always earns the floor — they showed the music to the world, and that work has value regardless of how simple the set was. Everything above the floor is earned through creative contribution: more sources, more active switching, more spectral contrast, more genre mixing. This variable bonus is drawn from the artist pool.

```
curator_share = 0.40 + 0.60 × (1 − 1/N) × edit_rate_normalized × avg_descriptor_distance × genre_diversity
```

Where:
- **0.40** = floor. Minimum guaranteed curator share. Configurable per deployment — 40% is a placeholder, not a final value.
- **0.60** = the artist pool. The curator's variable earnings come out of this.
- **N** = number of distinct source tracks. N=1 → only the floor is earned (no diversity possible).
- **edit_rate_normalized** = how frequently EBYS switched between sources.
- **avg_descriptor_distance** = how spectrally different the combined slices were.
- **genre_diversity** = how many different genres are blended. More genre-crossing → more curator credit.

The curator's credit above the floor comes entirely from contrast, activity, and genre invention — not from the music itself.

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

---

## TODO — Solidify Curator Equation

The current creative factors (sonic contrast, edit rate, genre diversity) need rethinking. The core question: **what actually justifies a curator earning more from the artist pool?** Sonic contrast as a proxy feels shaky — why would playing more different-sounding tracks earn you more money? The factors should map to genuine creative labor or risk, not just signal variance. Revisit before wiring these up from Max.
