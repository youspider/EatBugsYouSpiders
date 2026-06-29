# EBYS — Eat Bugs You Spider!

A generative DJ instrument. A web radio. An open tipping protocol. A cricket protein powder company.

Built in Montreal. Open source. Named after eating bugs.

---

## The Business in One Sentence

EBYS sells cricket protein powder, and the radio, the instrument, and the tipping protocol are the marketing machine for it.

---

## The Instrument

EBYS is a generative DJ instrument. It takes tracks submitted by artists, separates them into stems (vocals, melody, bass, drums), analyzes them across seven audio descriptors, and recombines them in real time into a continuous mix. The DJ shapes the mix through commands — adjusting weights, building a follow graph, setting segment lengths. The more they manipulate, the more the mix becomes theirs.

The software is free and open source (AGPL-3.0). Anyone can download it. The hardware — a dedicated machine with EBYS pre-installed, ready to perform out of the box — is for sale. Free software, paid hardware.

The instrument demonstrates itself through use. Every DJ set, every radio stream, every live performance is a demonstration of what it can do. The radio runs 24/7 as a live showcase. The website is where you download it or buy the hardware.

→ See `EBYS_SYSTEM.md`, `CRICKET.md`, `ARCHITECTURE.md`

---

## The Website and Radio

A website and a continuous radio for the Montreal music scene.

**The website** aggregates upcoming Montreal shows — scraped automatically and submitted by the community. No accounts required, no editorial hierarchy. Filter by genre, date, venue, artist. A living calendar of the scene. Artists submit tracks here too — those submissions feed the radio corpus.

**The radio** runs 24/7 in three modes:

```
Clean track       → plays fully, no manipulation, 100% to artist if tipped
Noisy transition  → glitchy stretch between two tracks
Original mix      → EBYS composes from the corpus, splits 60/40, EBYS/artists.

```

Most of the time it plays tracks cleanly. Occasionally it transitions with noise. When the playlist runs thin — late nights, quiet periods — EBYS fills the time with original mixes, compositing stems from different artists into something new.

Artists opt in to generative use when they submit. Standard submission means clean playback and clean transitions only — their tracks are never decomposed. Generative opt-in means their stems can appear in noisy transitions and original mixes. EBYS only earns a curator cut when it actually does something — pure playback earns nothing for EBYS.

A mixer console on the radio page shows what's happening in real time: which tracks are playing, which stems, which artists are contributing. When EBYS is compositing, the listener can see it. Tipping is informed — you see where your money goes before you send it.

The cricket protein powder shop is promoted through a spider that lives on the website. It crawls across the interface, sits on buttons, weaves webs over text. Click it — it opens the shop. It's the ad. It's also the joke. It knows what it is.

→ See `EBYS_SYSTEM.md`

---

## The Tipping Protocol

An open protocol that lets listeners tip DJ sets with a card tap or a web button. Any venue, any platform, any DJ setup can implement it.

**This is a tool EBYS offers to DJs.** It stands on its own — useful regardless of anything else. DJs use it, their crowd tips them, they get paid directly. No apps, no crypto required on the listener side.

The protocol comes in two forms:

**Web** — tip button on the radio page or event page. Works anywhere online.

**Physical** — a small card reader at the venue. Listeners tap their card or phone. Done in one second.

When EBYS is running behind the protocol, the tip splits automatically between the DJ and every contributing artist, calculated from the full session log. When another DJ setup is running, the tip goes to the DJ only.

→ See `TIPPING_PROTOCOL.md`

---

## CRKT — The Optional Layer

Once a DJ or artist is earning tips, they can choose what to do with them:

```
Cash out in dollars   → bank account, no crypto involved
Convert to CRKT       → connect a Solana wallet, earn from powder sales
```

CRKT is a revenue share in the Cricket Protein Powder Company. Hold CRKT, receive a proportional share of monthly powder margin. That's it.

CRKT is not tradeable, not on any exchange. The only way to get it is to convert tips earned through the tipping protocol. No buying in. No speculation.

The conversion is entirely optional. A DJ who just wants to get paid gets paid in dollars. A DJ who wants a stake in the powder company converts. No pressure, no lock-in, opt out anytime.

→ See `TOKEN.md`

---

## Why DJs Promote the Powder

They don't have to think about it. They perform, their crowd tips them, they optionally convert to CRKT. If their crowd then buys powder — because the buy link is on the radio page, because the brand is on the instrument they're using — they earn from those sales through their CRKT stake.

No contract. No obligation to mention it. No commission structure. Just: use the tool, get tipped, optionally hold a small stake in a food company that pays out monthly. The brand travels with the performance because the instrument and the brand share a name.

The more DJs using EBYS, the more audiences see the name. The more audiences see the name, the more powder sells. The more powder sells, the more CRKT earns. The more CRKT earns, the more reason DJs have to convert their tips.

---

## Why Artists Submit Tracks

The radio plays their music to a live audience. They get credited. When a listener tips a mix containing their track, they receive a share of the tip automatically — without performing, without being there, without knowing which DJ played them.

That tip can be cashed out in dollars or converted to CRKT for a small passive income from powder sales. Either way, their music earns while they sleep.

→ See `SPLIT_EQUATION.md`

---

## The Cricket Protein Powder Company

White-label supplier, EBYS branding. The margin after operating costs distributes entirely to CRKT holders monthly, proportional to holdings. EBYS covers its costs and earns CRKT the same way any curator does — by running sets and converting tips.

The powder is the real business. Everything else — the instrument, the radio, the protocol, the token — is infrastructure that makes the powder visible to the right people.

→ See `CRICKET_PROTEIN_POWDER_CIE.md`

---

## Licence

AGPL-3.0. The software is free. The hardware is not.

---

## File Map

| File                            | What it covers                                   |
|---------------------------------|--------------------------------------------------|
| `EBYS_SYSTEM.md`                | Full system — radio, corpus, temperature trigger |
| `CRICKET.md`                    | The AI agent — descriptors, learning, commands   |
| `LINK.md`                       | The LINK protocol between two EBYS units         |
| `SPLIT_EQUATION.md`             | How tips split between DJ and artists            |
| `TIPPING_PROTOCOL.md`           | The tipping protocol — web and venue             |
| `TOKEN.md`                      | CRKT token mechanics                             |
| `CRICKET_PROTEIN_POWDER_CIE.md` | The powder company and revenue distribution      |
| `MONETISATION_MODELS.md`        | Full monetisation overview                       |
| `ARCHITECTURE.md`               | Technical architecture                           |
| `TECH_STACK.md`                 | Software stack                                   |
