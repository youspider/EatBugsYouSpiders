# Split Equation — How Tips Are Divided

When a listener tips a mix, the payment is split automatically between the curator and the contributing artists. This document defines how that split is calculated.

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

## How Leadership Is Determined

Leadership is defined by the `followStem` graph at tip time. A stem that is followed by others — without fully following anyone itself — is the leader. Leadership is gradient, not binary. A stem can lead some and follow some simultaneously.

The follow graph can form chains and loops. Influence flows up the chain and dilutes with each step. Loops are valid — they resolve into a stable distribution where the most-followed stem still earns the most.

---

## The Curator's Share

The more EBYS authored the mix, the more the curator earns.

```
curator_share = (1 - 1/N) × edit_rate_normalized × avg_descriptor_distance
```

Where:
- **N** = number of distinct source tracks. Single track = 0 curator share.
- **edit_rate_normalized** = how frequently EBYS switched between sources.
- **avg_descriptor_distance** = how spectrally different the combined slices were.

The remaining `(1 - curator_share)` goes to the artists.

---

## The Artist Split

Every stem earns a base credit just for playing — its material is present and contributing regardless of the follow relationship. On top of that, the follow hierarchy distributes a bonus toward leaders.

```
credit[stem] = base_credit + hierarchy_bonus[stem]

base_credit        = 0.80 / number_of_active_stems
hierarchy_bonus    = 0.20 × normalised_hierarchy_score[stem]
```

The 80/20 split is the default. Configurable per deployment.

---

## The Influence Score

Influence is simply how much total attention from other stems is pointed at a given stem. The follow percentage is the signal — no weighting, no authority multiplier.

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
melody = 20       = 20 pts
vocals = 0        = 0 pts
bass   = 0        = 0 pts

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

Drums earns the most because the most read-head attention is structurally pointed at it. Vocals and bass earn only their base — they are leaders in the graph (no one follows them here) but the influence pool rewards being followed, not following.

---

## The Role at the Moment of the Tip

The mix is a fire — leaders interchange constantly. The split is calculated at the moment the tip is sent, from the follow graph active at that exact second. The math is local to the tip, the fairness is global over time.

---

## Open Questions

- Should deep chain influence dilute further with each step, or stay proportional?
- How to handle a stem with no follow relationships at all — equal base only?
