// EBYS — Slicer  v2
//
// Changes from v1:
//   - selectSegment() replaces selectRandom() — groups consecutive slices
//     into musically meaningful segments (SEGMENT_BARS bars long).
//   - Bar-aligned starts: when QUANTIZE_BARS is on (default), the chosen
//     start slice is snapped to the nearest bar boundary so segments always
//     begin on beat 1.  This is the single biggest factor for sounding good.
//   - next(track) carries the track name, so each stem loops independently
//     and all four fire simultaneously on start().
//   - Probabilistic stay/change: STAY_PROB (0–1) controls how likely a track
//     is to replay the same segment instead of jumping to a new one.
//     0 = always random,  1 = never move.  Default 0.
//
// ── Inlet messages ────────────────────────────────────────────────────────────
//   buildIndex              — read dict, rebuild index
//   start                   — fire all 4 stems simultaneously
//   stop                    — halt
//   next <track>            — re-select segment for that track only
//                             Max patch sends: "next vocals", "next melody", etc.
//   dumpDescriptors [track] — outlet 2 descriptor stream
//   selectRange <track> Clo Chi Elo Ehi Flo Fhi Plo Phi
//   setSegmentBars N        — bars per segment (default 4)
//   setQuantize 0|1         — snap starts to bar grid (default 1 = on)
//   setStayProb 0-1         — probability of staying on same position (default 0)
//   setFallbackBPM N        — BPM when detection returned 0 (default 120)
//   setTrackWeight t N      — future cross-track bias
//   info                    — print state summary
//   reset                   — clear index, stop
//
// ── Outlets ───────────────────────────────────────────────────────────────────
//   0  playback trigger  → list: track  start_ms  dur_ms
//   1  status strings
//   2  descriptor dump
//   3  query result count

autowatch = 1;
inlets    = 1;
outlets   = 4;

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
var TRACKS                 = ["vocals", "melody", "bass", "drums"];
var DICT_NAME              = "analysisLib";
var LAST_SLICE_DEFAULT_DUR = 0.005; // fraction — fallback dur for the last slice (~0.5% of buffer)

// ── MUSICAL PARAMETERS ────────────────────────────────────────────────────────
// Per-track segment bars and stay probability
// Commands: setSegmentBars N  (all tracks)  or  setSegmentBars vocals N  (one track)
//           setStayProb P     (all tracks)  or  setStayProb drums P      (one track)
var SEGMENT_BARS  = { vocals: 4, melody: 4, bass: 4, drums: 4 };
var QUANTIZE_BARS = true;   // snap start to bar grid  (setQuantize 0|1)
var STAY_PROB     = { vocals: 0.0, melody: 0.0, bass: 0.0, drums: 0.0 };
var FALLBACK_BPM  = 120;    // used when BPM detection returned 0
var GLOBAL_BPM    = 0;      // when > 0, overrides ALL analyzed BPM values (setGlobalBPM N)
var BAR_SNAP_MS       = 30;  // ms tolerance for "close enough to a bar boundary"
var MAX_SLICES_PER_STEM = 0; // 0 = unlimited; set via :setMaxSlices N to cap for large libraries

// Timing is driven by play~'s done bang in the Max patch.
// play~ fires done bang when it reaches endFrac → next() → selectSegment() → new segment.
// BPM controls how many slices to select (segment length), not transition timing.

// ── STEM DURATIONS (ms) ───────────────────────────────────────────────────────
// Set from Max via:  setStemDurMs vocals 187420
// info~ stem_vocals → [* 1000] → prepend setStemDurMs vocals → js slicer.js
// Without these, slice.time fractions can't be compared to barMs (ms).
var stemDurMs = { vocals: 0, melody: 0, bass: 0, drums: 0 };

function setStemDurMs(track, ms) {
    if (stemDurMs.hasOwnProperty(track)) {
        var newMs = parseFloat(ms);
        if (newMs <= 0) return;  // ignore empty-buffer reports (0ms on patch open)
        stemDurMs[track] = newMs;
        post("EBYS Slicer: stemDurMs[" + track + "] = "
             + (stemDurMs[track] / 1000).toFixed(2) + "s\n");
        outlet(1, "stemDurMs", track, stemDurMs[track]);
    }
}

// ── INDEX STATE ───────────────────────────────────────────────────────────────
var idx          = [];
var byTrack      = {};
var meta         = {};
var ranges       = {};

// ── DOWNBEAT STATE ────────────────────────────────────────────────────────────
// Populated by loadDownbeats() from ../downbeats.json (written by allin1_tagger.py).
// trackDownbeats[track] = { meter, bpm, avgBarMs, downbeats_ms: [...], confidence }
// All four stems share the same data (analysed from the mix).
// When confidence < DOWNBEAT_MIN_CONF the BPM grid is used instead.
var trackDownbeats        = {};
var DOWNBEAT_MIN_CONF     = 0.4;  // below this, fall back to BPM grid
var trackWeights = { vocals: 1.0, melody: 1.0, bass: 1.0, drums: 1.0 };
var lastIdx      = { vocals: 0, melody: 0, bass: 0, drums: 0 };

// ── PER-STEM LOOP STATE ───────────────────────────────────────────────────────
// loopState[track] = { bars: N, startIdx: i, startTime: fraction, endTime: fraction }
// When set, next() replays the same segment instead of selecting a new one.
var loopState = { vocals: null, melody: null, bass: null, drums: null };

// ── PLAYBACK STATE ────────────────────────────────────────────────────────────
var running   = false;
var lastSlice = null;

// ── TRANSITION MATCHING ───────────────────────────────────────────────────────
// MATCH_PROB[d] — 0 = ignore transition, 1 = strict match
//   How tightly the START of the next slice must match the END of the current one.
//   setMatchProb C 0.8  → centroid must match at 80%
var MATCH_PROB = { C: 0.0, E: 0.0, F: 0.0, P: 0.0, H: 0.0, T: 0.0 };

// DIR_PREF[d] — -1 = prefer decreasing, 0 = neutral, +1 = prefer increasing
//   Biases selection toward slices that evolve in a given direction.
//   setDirPref E 1  → prefer slices where energy is rising
var DIR_PREF   = { C: 0.0, E: 0.0, F: 0.0, P: 0.0, H: 0.0, T: 0.0 };
var DIR_WEIGHT = 1.0;  // global scale for direction influence

// End-descriptor memory per track — updated after each slice fires.
// Stores the END values of the last played slice so the next selection
// can match against them.
var lastEndDesc = { vocals: null, melody: null, bass: null, drums: null };

// ── UTILITY ───────────────────────────────────────────────────────────────────
function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = "0" + s;
    return s;
}
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// ── BUILD INDEX ───────────────────────────────────────────────────────────────
function buildIndex() {
    idx     = [];
    byTrack = {};
    meta    = {};
    ranges  = {};

    var d = new Dict(DICT_NAME);
    var topKeys = d.getkeys();
    if (!topKeys || topKeys.length === 0) {
        post("EBYS slicer: dict '" + DICT_NAME + "' is empty — no analysis yet\n");
        return;
    }

    // dict analysisLib is keyed by stem filename (e.g. "track_vocals.wav").
    // Find which filename belongs to each stem by matching the suffix.
    var STEM_SUFFIXES = {
        vocals: "_vocals.wav",
        melody: "_other.wav",   // htdemucs calls it "other"
        bass:   "_bass.wav",
        drums:  "_drums.wav"
    };
    var stemFile = {};
    for (var ki = 0; ki < topKeys.length; ki++) {
        var kl = String(topKeys[ki]).toLowerCase();
        for (var s in STEM_SUFFIXES) {
            if (kl.indexOf(STEM_SUFFIXES[s]) !== -1) { stemFile[s] = String(topKeys[ki]); break; }
        }
    }

    for (var t = 0; t < TRACKS.length; t++) {
        var track = TRACKS[t];
        // prefix = "filename::" so all dict paths resolve inside the right sub-dict
        var prefix = stemFile[track] ? stemFile[track] + "::" : "";
        byTrack[track] = [];

        meta[track] = {
            BPM:            parseFloat(d.get(prefix + track + "::metadata::BPM"))            || 0,
            BPM_confidence: parseFloat(d.get(prefix + track + "::metadata::BPM_confidence")) || 0,
            key:            String(d.get(prefix + track + "::metadata::key")                 || ""),
            track_name:     String(d.get(prefix + track + "::metadata::track_name")          || "")
        };

        // Restore stem duration from library so playback works on fresh open
        // (buffers are empty until audio is loaded — no need to wait for info~)
        var storedDurMs = parseFloat(d.get(prefix + track + "::metadata::stemDurMs")) || 0;
        if (storedDurMs > 0) {
            stemDurMs[track] = storedDurMs;
            post("EBYS Slicer: stemDurMs[" + track + "] = "
                 + (storedDurMs / 1000).toFixed(2) + "s (from library)\n");
        }

        var n = 1;
        while (true) {
            var id   = "slice_" + pad(n, 4);
            var base = prefix + track + "::slices::" + id + "::";
            if (!d.contains(base + "time")) break;
            var t_ms = d.get(base + "time");

            var slice = {
                track : track,
                id    : id,
                n     : n,
                time  : parseFloat(t_ms),
                C     : parseFloat(d.get(base + "C"))  || 0,
                P     : parseFloat(d.get(base + "P"))  || 0,
                E     : parseFloat(d.get(base + "E"))  || -60,
                F     : parseFloat(d.get(base + "F"))  || 0,
                H     : parseFloat(d.get(base + "H"))  || 0,
                M0    : parseFloat(d.get(base + "M0")) || 0,
                M1    : parseFloat(d.get(base + "M1")) || 0,
                M2    : parseFloat(d.get(base + "M2")) || 0,
                M3    : parseFloat(d.get(base + "M3")) || 0,
                M4    : parseFloat(d.get(base + "M4")) || 0,
                M5    : parseFloat(d.get(base + "M5")) || 0,
                BPM   : meta[track].BPM,
                key   : meta[track].key,
                dur   : LAST_SLICE_DEFAULT_DUR
            };
            byTrack[track].push(slice);
            idx.push(slice);
            n++;
        }

        // Cap slice count if MAX_SLICES_PER_STEM is set
        if (MAX_SLICES_PER_STEM > 0 && byTrack[track].length > MAX_SLICES_PER_STEM) {
            var step = byTrack[track].length / MAX_SLICES_PER_STEM;
            var sampled = [];
            for (var si = 0; si < MAX_SLICES_PER_STEM; si++) {
                sampled.push(byTrack[track][Math.round(si * step)]);
            }
            byTrack[track] = sampled;
        }

        // Infer duration from successive start times
        var arr = byTrack[track];
        for (var i = 0; i < arr.length - 1; i++) {
            arr[i].dur = arr[i + 1].time - arr[i].time;
        }

        // Compute end-descriptors and deltas for transition matching.
        // end* = descriptor at the start of the NEXT slice (= approximate end of this one).
        // delta* = direction of change (positive = rising, negative = falling).
        // T = RMS of MFCC1–M5 (timbral complexity; M0 is energy-correlated so excluded).
        for (var i = 0; i < arr.length; i++) {
            var m1 = arr[i].M1, m2 = arr[i].M2, m3 = arr[i].M3;
            var m4 = arr[i].M4, m5 = arr[i].M5;
            arr[i].T = Math.sqrt((m1*m1 + m2*m2 + m3*m3 + m4*m4 + m5*m5) / 5.0);
        }
        for (var i = 0; i < arr.length - 1; i++) {
            arr[i].endC = arr[i+1].C;  arr[i].deltaC = arr[i+1].C - arr[i].C;
            arr[i].endE = arr[i+1].E;  arr[i].deltaE = arr[i+1].E - arr[i].E;
            arr[i].endF = arr[i+1].F;  arr[i].deltaF = arr[i+1].F - arr[i].F;
            arr[i].endP = arr[i+1].P;  arr[i].deltaP = arr[i+1].P - arr[i].P;
            arr[i].endH = arr[i+1].H;  arr[i].deltaH = arr[i+1].H - arr[i].H;
            arr[i].endT = arr[i+1].T;  arr[i].deltaT = arr[i+1].T - arr[i].T;
        }
        if (arr.length > 0) {
            var last = arr[arr.length - 1];
            last.endC = last.C; last.endE = last.E;
            last.endF = last.F; last.endP = last.P;
            last.endH = last.H; last.endT = last.T;
            last.deltaC = 0; last.deltaE = 0; last.deltaF = 0; last.deltaP = 0;
            last.deltaH = 0; last.deltaT = 0;
        }

        if (arr.length === 0) { ranges[track] = {}; continue; }

        var rC={min:Infinity,max:-Infinity}, rP={min:Infinity,max:-Infinity};
        var rE={min:Infinity,max:-Infinity}, rF={min:Infinity,max:-Infinity};
        var rDur={min:Infinity,max:-Infinity};
        for (var i = 0; i < arr.length; i++) {
            var s = arr[i];
            if (s.C<rC.min)rC.min=s.C; if(s.C>rC.max)rC.max=s.C;
            if (s.P<rP.min)rP.min=s.P; if(s.P>rP.max)rP.max=s.P;
            if (s.E<rE.min)rE.min=s.E; if(s.E>rE.max)rE.max=s.E;
            if (s.F<rF.min)rF.min=s.F; if(s.F>rF.max)rF.max=s.F;
            if (s.dur<rDur.min)rDur.min=s.dur; if(s.dur>rDur.max)rDur.max=s.dur;
        }
        ranges[track] = { C:rC, P:rP, E:rE, F:rF, dur:rDur };

        // Compute H and T ranges
        var rH={min:Infinity,max:-Infinity}, rT={min:Infinity,max:-Infinity};
        for (var i = 0; i < arr.length; i++) {
            if (arr[i].H < rH.min) rH.min = arr[i].H; if (arr[i].H > rH.max) rH.max = arr[i].H;
            if (arr[i].T < rT.min) rT.min = arr[i].T; if (arr[i].T > rT.max) rT.max = arr[i].T;
        }
        ranges[track].H = rH;
        ranges[track].T = rT;

        // Update global normalisation ranges across all tracks
        if (rC.max > rC.min) norm.C = Math.max(norm.C, rC.max - rC.min);
        if (rE.max > rE.min) norm.E = Math.max(norm.E, rE.max - rE.min);
        if (rF.max > rF.min) norm.F = Math.max(norm.F, rF.max - rF.min);
        if (rP.max > rP.min) norm.P = Math.max(norm.P, rP.max - rP.min);
        if (rH.max > rH.min) norm.H = Math.max(norm.H, rH.max - rH.min);
        if (rT.max > rT.min) norm.T = Math.max(norm.T, rT.max - rT.min);

        var bpm = meta[track].BPM || FALLBACK_BPM;
        post("EBYS Slicer [" + track + "]: " + arr.length + " slices"
             + "  BPM=" + bpm.toFixed(1)
             + "  key=" + meta[track].key
             + "  E=[" + rE.min.toFixed(1) + "," + rE.max.toFixed(1) + "] LUFS"
             + "  C=[" + Math.round(rC.min) + "," + Math.round(rC.max) + "] Hz\n");
    }

    post("EBYS Slicer: index ready — " + idx.length + " total slices\n");
    outlet(1, "ready", idx.length);
    outlet(1, "slices",
        byTrack.vocals ? byTrack.vocals.length : 0,
        byTrack.melody ? byTrack.melody.length : 0,
        byTrack.bass   ? byTrack.bass.length   : 0,
        byTrack.drums  ? byTrack.drums.length  : 0
    );
    // Emit track name from vocals metadata (all stems share the same track)
    var rawName = (meta["vocals"] && meta["vocals"].track_name) ? meta["vocals"].track_name : "";
    var trackName = rawName.replace(/_(vocals|melody|bass|drums|melo)(\.\w+)?$/i, "").trim();
    if (trackName) outlet(1, "track_name", trackName);
    // Ask Max to resend stem durations — stemDurMs resets on every autowatch reload
    outlet(1, "need_stemDurs");
    // Load downbeat data from allin1_tagger.py output (if present)
    loadDownbeats();
    // Persist index to JSON so it survives patch reloads
    saveIndex();
}

// ── INDEX PERSISTENCE ─────────────────────────────────────────────────────────
var INDEX_FILE = "ebys_index.json";

function saveIndex() {
    try {
        var payload = { meta: meta, byTrack: byTrack, ranges: ranges };
        var f = new File(INDEX_FILE, "write", "TEXT");
        f.open();
        f.writestring(JSON.stringify(payload));
        f.close();
        post("EBYS Slicer: index saved to " + INDEX_FILE + "\n");
    } catch(e) {
        post("EBYS Slicer: save failed — " + e + "\n");
    }
}

function loadIndex() {
    try {
        var f = new File(INDEX_FILE, "read", "TEXT");
        if (!f.isopen) { post("EBYS Slicer: no saved index found\n"); return false; }
        var raw = "";
        while (!f.eof) raw += f.readline();
        f.close();
        var payload = JSON.parse(raw);
        meta    = payload.meta    || {};
        ranges  = payload.ranges  || {};
        byTrack = payload.byTrack || {};
        // Rebuild flat idx from byTrack
        idx = [];
        for (var t = 0; t < TRACKS.length; t++) {
            var arr = byTrack[TRACKS[t]] || [];
            for (var i = 0; i < arr.length; i++) idx.push(arr[i]);
        }
        // Rebuild norm
        for (var t = 0; t < TRACKS.length; t++) {
            var r = ranges[TRACKS[t]];
            if (!r) continue;
            if (r.C && r.C.max > r.C.min) norm.C = Math.max(norm.C, r.C.max - r.C.min);
            if (r.E && r.E.max > r.E.min) norm.E = Math.max(norm.E, r.E.max - r.E.min);
            if (r.F && r.F.max > r.F.min) norm.F = Math.max(norm.F, r.F.max - r.F.min);
            if (r.P && r.P.max > r.P.min) norm.P = Math.max(norm.P, r.P.max - r.P.min);
            if (r.H && r.H.max > r.H.min) norm.H = Math.max(norm.H, r.H.max - r.H.min);
            if (r.T && r.T.max > r.T.min) norm.T = Math.max(norm.T, r.T.max - r.T.min);
        }
        post("EBYS Slicer: loaded " + idx.length + " slices from " + INDEX_FILE + "\n");
        loadDownbeats();
        outlet(1, "ready", idx.length);
        var rawName = (meta["vocals"] && meta["vocals"].track_name) ? meta["vocals"].track_name : "";
        var trackName = rawName.replace(/_(vocals|melody|bass|drums|melo)(\.\w+)?$/i, "").trim();
        if (trackName) outlet(1, "track_name", trackName);
        outlet(1, "need_stemDurs");
        return true;
    } catch(e) {
        post("EBYS Slicer: load failed — " + e + "\n");
        return false;
    }
}

// Auto-load on script start
loadIndex();

// ── CANDIDATE SCORING ────────────────────────────────────────────────────────
// Lower score = better candidate.
//
// Two independent criteria:
//   1. TRANSITION MATCH — how closely does candidate.start match current.end?
//      Weighted by MATCH_PROB per descriptor (0=ignore, 1=strict).
//   2. DIRECTION PREFERENCE — does the candidate evolve the way Cricket wants?
//      Weighted by DIR_PREF per descriptor (-1=down, 0=neutral, +1=up).
//
// When both MATCH_PROB and DIR_PREF are all zero the score is always 0
// and the caller falls back to random / descriptor distance as before.

function scoreCandidate(candidate, endDesc) {
    var score = 0;
    var dims  = ['C', 'E', 'F', 'P', 'H', 'T'];
    for (var i = 0; i < dims.length; i++) {
        var d = dims[i];

        // 1. Transition match
        if (MATCH_PROB[d] > 0 && endDesc) {
            var val = (d === 'T') ? (candidate.T || 0) : candidate[d];
            var ref = (d === 'T') ? (endDesc.T  || 0) : endDesc[d];
            var diff = (val - ref) / (norm[d] || 1);
            score += MATCH_PROB[d] * diff * diff;
        }

        // 2. Direction preference
        // delta > 0 means this slice is evolving upward in descriptor d.
        // DIR_PREF[d] = 1 → want rising → reward high delta → subtract from score.
        if (DIR_PREF[d] !== 0) {
            var delta = (candidate['delta' + d] || 0) / (norm[d] || 1);
            score -= DIR_PREF[d] * delta * DIR_WEIGHT;
        }
    }
    return score;
}

function hasActiveCriteria() {
    return (MATCH_PROB.C > 0 || MATCH_PROB.E > 0 || MATCH_PROB.F > 0 || MATCH_PROB.P > 0 ||
            MATCH_PROB.H > 0 || MATCH_PROB.T > 0 ||
            DIR_PREF.C !== 0 || DIR_PREF.E !== 0 || DIR_PREF.F !== 0 || DIR_PREF.P !== 0 ||
            DIR_PREF.H !== 0 || DIR_PREF.T !== 0);
}

// ── DOWNBEAT HELPERS ──────────────────────────────────────────────────────────

// loadDownbeats — reads ../downbeats.json and populates trackDownbeats for all stems.
// Called at the end of buildIndex() and loadIndex(), and via "reloadDownbeats" message.
function loadDownbeats() {
    trackDownbeats = {};
    try {
        var f = new File("../downbeats.json", "read", "TEXT");
        if (!f.isopen) { post("EBYS Slicer: no downbeats.json found (run allin1_tagger.py first)\n"); return; }
        var raw = "";
        while (!f.eof) raw += f.readline();
        f.close();
        var db = JSON.parse(raw);

        // Match by track base name: strip stem suffix from meta[track].track_name
        var rawName  = (meta["vocals"] && meta["vocals"].track_name) ? meta["vocals"].track_name : "";
        var baseName = rawName.replace(/_(vocals|melody|bass|drums|other|melo)(\.\w+)?$/i, "").trim();

        if (!baseName) {
            post("EBYS Slicer: loadDownbeats — no track_name in meta yet\n");
            return;
        }

        // Try exact match first, then case-insensitive prefix
        var entry = db[baseName];
        if (!entry) {
            var bnLower = baseName.toLowerCase();
            for (var k in db) {
                if (k.toLowerCase() === bnLower) { entry = db[k]; break; }
            }
        }

        if (!entry) {
            post("EBYS Slicer: loadDownbeats — no entry for '" + baseName + "' in downbeats.json\n");
            return;
        }

        // Assign the same entry to all four stem slots
        for (var t = 0; t < TRACKS.length; t++) {
            trackDownbeats[TRACKS[t]] = entry;
        }

        post("EBYS Slicer: downbeats loaded — track='" + baseName
             + "'  meter=" + entry.meter
             + "  bpm=" + entry.bpm
             + "  downbeats=" + (entry.downbeats_ms ? entry.downbeats_ms.length : 0)
             + "  conf=" + entry.confidence + "\n");

    } catch(e) {
        post("EBYS Slicer: loadDownbeats error — " + e + "\n");
    }
}

// getBarMs — average bar duration in ms for this track.
// Uses madmom avgBarMs when confidence is high enough; falls back to BPM grid.
function getBarMs(track, bpm) {
    var db = trackDownbeats[track];
    if (db && db.confidence >= DOWNBEAT_MIN_CONF && db.avgBarMs > 0) {
        return db.avgBarMs;
    }
    // BPM fallback — assume 4/4 (or use meter if stored)
    var meter = (db && db.meter > 0) ? db.meter : 4;
    return (60000.0 / bpm) * meter;
}

// isNearDownbeat — true if posMs is within BAR_SNAP_MS of any stored downbeat.
// Falls back to posMs % barMs < BAR_SNAP_MS when no confident downbeats available.
function isNearDownbeat(posMs, track, barMs) {
    var db = trackDownbeats[track];
    if (db && db.confidence >= DOWNBEAT_MIN_CONF && db.downbeats_ms && db.downbeats_ms.length > 1) {
        var beats = db.downbeats_ms;
        for (var i = 0; i < beats.length; i++) {
            if (Math.abs(posMs - beats[i]) <= BAR_SNAP_MS) return true;
        }
        return false;
    }
    // BPM grid fallback
    var offset = posMs % barMs;
    return offset < BAR_SNAP_MS || (barMs - offset) < BAR_SNAP_MS;
}

// ── SEGMENT SELECTION ─────────────────────────────────────────────────────────
//
// How bar-alignment works (madmom mode):
//   When downbeats.json has a confident entry, isNearDownbeat() checks proximity
//   to actual detected downbeat timestamps — works for any meter, any tempo,
//   any phase offset, and electroacoustic music with drifting tempo.
//
// Fallback (BPM grid):
//   bar_ms = 60000 / BPM * meter  — assumes bar1 = t0, fixed grid.
//   Used when confidence < DOWNBEAT_MIN_CONF or no downbeats.json present.
//
// Why this matters musically:
//   Random cuts that begin mid-bar sound like edits; cuts on beat 1 of a bar
//   feel intentional and maintain the rhythmic pulse across all 4 stems.
//
function selectSegment(track) {
    var arr = (track && byTrack[track]) ? byTrack[track] : null;
    if (!arr || arr.length === 0) {
        outlet(1, "empty_pool", track || "?");
        return;
    }

    // Effective BPM for this track
    var bpm      = effectiveBPM(track);
    var barMs    = getBarMs(track, bpm);
    var targetMs = barMs * SEGMENT_BARS[track];

    // Convert fractions to ms using known stem duration.
    // stemDurMs[track] must be set via setStemDurMs before start().
    var durMs = stemDurMs[track] || 0;
    var hasDur = durMs > 0;

    // Build candidate pool (bar-aligned or full).
    // Bar-alignment only makes sense when we have real ms positions.
    var pool = null;
    if (QUANTIZE_BARS && hasDur) {
        var aligned = [];
        for (var i = 0; i < arr.length; i++) {
            var posMs = arr[i].time * durMs;
            if (isNearDownbeat(posMs, track, barMs)) aligned.push(i);
        }
        if (aligned.length >= 2) pool = aligned;
    }
    if (!pool) {
        pool = [];
        for (var i = 0; i < arr.length; i++) pool.push(i);
    }

    // Stay-or-move decision
    var startIdx;
    if (STAY_PROB[track] > 0 && Math.random() < STAY_PROB[track]
        && lastIdx[track] !== undefined && lastIdx[track] < arr.length) {
        startIdx = lastIdx[track];
    } else if (hasActiveCriteria()) {
        // Score every candidate — pick the one with the lowest combined score.
        var endDesc   = lastEndDesc[track];
        var bestScore = Infinity;
        startIdx = pool[0];
        for (var pi = 0; pi < pool.length; pi++) {
            var sc = scoreCandidate(arr[pool[pi]], endDesc);
            if (sc < bestScore) { bestScore = sc; startIdx = pool[pi]; }
        }
    } else {
        startIdx = pool[Math.floor(Math.random() * pool.length)];
    }
    lastIdx[track] = startIdx;

    var startSlice = arr[startIdx];

    // Accumulate consecutive slices until targetMs covered.
    // dur fields are fractions; convert to ms on the fly.
    var totalFrac = 0;
    var i = startIdx;
    if (hasDur) {
        while (i < arr.length && (totalFrac * durMs) < targetMs) {
            totalFrac += arr[i].dur;
            i++;
        }
        // Ensure minimum 1 bar
        if ((totalFrac * durMs) < barMs) totalFrac = barMs / durMs;
    } else {
        // No stem duration known — use SEGMENT_BARS * 8 slices as proxy
        // so setSegmentBars still has an effect even before stemDurMs is set
        var fallbackCount = Math.max(4, Math.round(SEGMENT_BARS[track] * 8));
        var count = 0;
        while (i < arr.length && count < fallbackCount) {
            totalFrac += arr[i].dur;
            i++;
            count++;
        }
    }

    // Emit — both values are 0-1 fractions of buffer length.
    // outlet 0: track  start_frac  end_frac
    // In Max:  start_frac * buf_ms → prepend start → play~
    //          (end_frac - start_frac) * buf_ms → delay
    var endFrac = Math.min(startSlice.time + totalFrac, 1.0);
    lastSlice = { track: track, time: startSlice.time, dur: totalFrac };

    // Store end-descriptors so next selection can match against them
    lastEndDesc[track] = {
        C: startSlice.endC, E: startSlice.endE,
        F: startSlice.endF, P: startSlice.endP,
        H: startSlice.endH, T: startSlice.endT
    };

    // Compute actual duration in ms for Task scheduling
    var segDurMs;
    if (hasDur) {
        segDurMs = totalFrac * durMs;
    } else {
        // stemDurMs unknown — estimate from BPM alone
        var bpmEst = effectiveBPM(track);
        segDurMs = (60000.0 / bpmEst) * 4.0 * SEGMENT_BARS;
    }
    // Emit absolute time position in ms so TUI can display a timestamp
    var sliceMs = (hasDur) ? Math.round(startSlice.time * durMs) : 0;

    outlet(0, track, startSlice.time, endFrac, stretchRatioFor(track));
    outlet(1, "desc",     track, startSlice.C, startSlice.E, startSlice.F, startSlice.P);
    outlet(1, "slice_ms", track, sliceMs);
    outlet(1, "seg",
           track,
           startSlice.id,
           hasDur ? (Math.round(segDurMs) + "ms") : (totalFrac.toFixed(3) + " frac"),
           "(" + (segDurMs / ((60000.0 / effectiveBPM(track)) * 4.0)).toFixed(1) + " bars)");
}

// ── TRANSPORT ─────────────────────────────────────────────────────────────────

function start() {
    if (idx.length === 0) { outlet(1, "index_empty"); return; }
    running = true;
    // Fire all 4 stems simultaneously — they then loop independently via "next <track>"
    for (var t = 0; t < TRACKS.length; t++) {
        selectSegment(TRACKS[t]);
    }
    post("EBYS Slicer: started — bars=" + JSON.stringify(SEGMENT_BARS)
         + "  quantize=" + QUANTIZE_BARS
         + "  stay=" + JSON.stringify(STAY_PROB) + "\n");
}

function stop() {
    running = false;
    outlet(1, "stopped");
}

// Called by play~'s done bang: "next vocals" / "next melody" / etc.
function next(track) {
    if (!running) return;
    if (track) {
        // If this stem is looping, replay the locked position
        if (loopState[track]) {
            var lp = loopState[track];
            outlet(0, track, lp.startTime, lp.endTime, stretchRatioFor(track));
            outlet(1, "seg", track, "loop", lp.bars + "bars", "(looping)");
        } else {
            selectSegment(track);
        }
    } else {
        for (var t = 0; t < TRACKS.length; t++) selectSegment(TRACKS[t]);
    }
}

// loop <track> <bars>  — lock stem to current or next segment of N bars
function loop(track, bars) {
    var arr = byTrack[track];
    if (!arr || arr.length === 0) {
        post("EBYS Slicer: loop — no slices for " + track + "\n");
        return;
    }
    bars = parseFloat(bars) || SEGMENT_BARS;

    var bpm      = effectiveBPM(track);
    var barMs    = getBarMs(track, bpm);
    var targetMs = barMs * bars;
    var durMs    = stemDurMs[track] || 0;

    // Select a fresh segment as the loop anchor (same logic as selectSegment)
    var pool = [];
    for (var pi = 0; pi < arr.length; pi++) pool.push(pi);
    var startIdx = hasActiveCriteria()
        ? (function() {
            var best = pool[0], bestSc = Infinity;
            for (var pi = 0; pi < pool.length; pi++) {
                var sc = scoreCandidate(arr[pool[pi]], lastEndDesc[track]);
                if (sc < bestSc) { bestSc = sc; best = pool[pi]; }
            }
            return best;
          })()
        : pool[Math.floor(Math.random() * pool.length)];
    var startSlice = arr[startIdx];

    var totalFrac = 0, i = startIdx;
    if (durMs > 0) {
        while (i < arr.length && (totalFrac * durMs) < targetMs) {
            totalFrac += arr[i].dur; i++;
        }
        if ((totalFrac * durMs) < barMs) totalFrac = barMs / durMs;
    } else {
        var count = 0;
        while (i < arr.length && count < Math.max(4, Math.round(SEGMENT_BARS * 8))) { totalFrac += arr[i].dur; i++; count++; }
    }

    var endTime = Math.min(startSlice.time + totalFrac, 1.0);
    loopState[track] = { bars: bars, startIdx: startIdx,
                         startTime: startSlice.time, endTime: endTime };

    post("EBYS Slicer: loop " + track + " @" + bars + " bars"
         + "  [" + startSlice.time.toFixed(3) + " → " + endTime.toFixed(3) + "]\n");
    outlet(1, "loop", track, bars, "locked");
}

// unloop <track>  — release stem back to normal selection
function unloop(track) {
    if (loopState.hasOwnProperty(track)) {
        loopState[track] = null;
        post("EBYS Slicer: unloop " + track + "\n");
        outlet(1, "unloop", track);
    }
}

// unloopAll  — release all stems
function unloopAll() {
    var tracks = Object.keys(loopState);
    for (var i = 0; i < tracks.length; i++) loopState[tracks[i]] = null;
    post("EBYS Slicer: all loops released\n");
    outlet(1, "unloop", "all");
}

// ── NEAREST-NEIGHBOUR SELECTION ───────────────────────────────────────────────
//
// In Max, replace [msg "next melody"] with this chain:
//
//   outlet 1 of js slicer.js outputs after each slice:
//     "desc melody C E F P"   ← current slice descriptors
//
//   Store C E F P in four [f] boxes.
//   When delay fires → instead of "next melody", send:
//     "nextNearest melody C E F P"
//   to js slicer.js inlet.
//
// Weights control how much each descriptor matters in the distance formula.
// Send "setWeight C 1.0" etc. to tune from Max.
//
var WEIGHTS = { C: 1.0, E: 2.0, F: 0.5, P: 1.5, H: 1.0, T: 1.5 };
// E weighted highest: energy continuity is most audible.
// P second: pitch continuity holds harmonic coherence.
// T second: timbre (MFCC RMS) fingerprints instrument character well.
// C: brightness continuity.
// H: chroma (harmonic colour) — same weight as C.
// F lowest: flatness/noisiness matters less.

function setWeight(dim, val) {
    if (WEIGHTS.hasOwnProperty(dim)) {
        WEIGHTS[dim] = parseFloat(val);
        post("EBYS Slicer: weight[" + dim + "] = " + WEIGHTS[dim] + "\n");
    }
}

// Normalisation ranges — updated at buildIndex time.
// Keeps C (0–22000 Hz) and P (0–4000 Hz) on the same scale as E (-60–0).
// H is already 0–1; T (MFCC RMS) varies ~0–200 depending on material.
var norm = { C: 1, E: 1, F: 1, P: 1, H: 1, T: 1 };

function normalisedDist(a, b) {
    var dC = (a.C - b.C) / (norm.C || 1);
    var dE = (a.E - b.E) / (norm.E || 1);
    var dF = (a.F - b.F) / (norm.F || 1);
    var dP = (a.P - b.P) / (norm.P || 1);
    var dH = (a.H - b.H) / (norm.H || 1);
    var dT = ((a.T || 0) - (b.T || 0)) / (norm.T || 1);
    return WEIGHTS.C * dC*dC
         + WEIGHTS.E * dE*dE
         + WEIGHTS.F * dF*dF
         + WEIGHTS.P * dP*dP
         + WEIGHTS.H * dH*dH
         + WEIGHTS.T * dT*dT;
}

// Max sends: nextNearest melody <C> <E> <F> <P>
function nextNearest(track, C, E, F, P) {
    if (!running) return;
    var arr = byTrack[track];
    if (!arr || arr.length === 0) { selectSegment(track); return; }

    var ref = { C: parseFloat(C), E: parseFloat(E),
                F: parseFloat(F), P: parseFloat(P) };

    // Find slice with smallest descriptor distance to ref.
    // Skip the slice that just played (lastIdx) to avoid looping the same cut.
    var endDesc = lastEndDesc[track];
    var bestIdx = -1, bestDist = Infinity;
    for (var i = 0; i < arr.length; i++) {
        if (i === lastIdx[track]) continue;
        var d = normalisedDist(arr[i], ref) + scoreCandidate(arr[i], endDesc);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx < 0) bestIdx = lastIdx[track]; // fallback: repeat if only 1 slice

    lastIdx[track] = bestIdx;

    // Same duration accumulation as selectSegment
    var durMs    = stemDurMs[track] || 0;
    var hasDur   = durMs > 0;
    var bpm      = effectiveBPM(track);
    var barMs    = getBarMs(track, bpm);
    var targetMs = barMs * SEGMENT_BARS[track];

    var totalFrac = 0, i = bestIdx;
    if (hasDur) {
        while (i < arr.length && (totalFrac * durMs) < targetMs) {
            totalFrac += arr[i].dur; i++;
        }
        if ((totalFrac * durMs) < barMs) totalFrac = barMs / durMs;
    } else {
        var count = 0;
        var fallbackCount = Math.max(4, Math.round(SEGMENT_BARS[track] * 8));
        while (i < arr.length && count < fallbackCount) {
            totalFrac += arr[i].dur; i++; count++;
        }
    }

    var s      = arr[bestIdx];
    var endFrac = Math.min(s.time + totalFrac, 1.0);
    lastSlice   = { track: track, time: s.time, dur: totalFrac };

    lastEndDesc[track] = { C: s.endC, E: s.endE, F: s.endF, P: s.endP, H: s.endH, T: s.endT };

    var sliceMs = hasDur ? Math.round(s.time * durMs) : 0;

    outlet(0, track, s.time, endFrac, stretchRatioFor(track));
    outlet(1, "desc",     track, s.C, s.E, s.F, s.P);
    outlet(1, "slice_ms", track, sliceMs);
    outlet(1, "seg", track, s.id,
           hasDur ? (Math.round(totalFrac * durMs) + "ms") : (totalFrac.toFixed(3) + " frac"),
           "dist=" + bestDist.toFixed(2));
}

// ── PARAMETER SETTERS ─────────────────────────────────────────────────────────

function setSegmentBars(trackOrN, n) {
    // setSegmentBars 4           → all tracks
    // setSegmentBars vocals 2    → vocals only
    if (n === undefined) {
        // single-arg form: apply to all
        var val = parseFloat(trackOrN);
        if (val > 0 && val <= 64) {
            for (var t = 0; t < TRACKS.length; t++) SEGMENT_BARS[TRACKS[t]] = val;
            post("EBYS Slicer: segmentBars (all) = " + val + "\n");
            outlet(1, "segmentBars", "all", val);
            applyNow();
        }
    } else {
        var track = trackOrN;
        var val   = parseFloat(n);
        if (SEGMENT_BARS.hasOwnProperty(track) && val > 0 && val <= 64) {
            SEGMENT_BARS[track] = val;
            post("EBYS Slicer: segmentBars[" + track + "] = " + val + "\n");
            outlet(1, "segmentBars", track, val);
            if (running) selectSegment(track);
        }
    }
}

function setQuantize(v) {
    QUANTIZE_BARS = (parseInt(v) !== 0);
    post("EBYS Slicer: quantize = " + QUANTIZE_BARS + "\n");
    outlet(1, "quantize", QUANTIZE_BARS ? 1 : 0);
    applyNow();
}

// reloadDownbeats — hot-reload ../downbeats.json without re-running buildIndex.
// Send this message from Max after running allin1_tagger.py on a track that's
// already loaded (so you don't have to re-analyse in FluCoMa just to pick up
// the new downbeat data).
function reloadDownbeats() {
    loadDownbeats();
}

function setStayProb(trackOrV, v) {
    // setStayProb 0.5          → all tracks
    // setStayProb drums 0.8   → drums only
    if (v === undefined) {
        var val = clamp(parseFloat(trackOrV), 0.0, 1.0);
        for (var t = 0; t < TRACKS.length; t++) STAY_PROB[TRACKS[t]] = val;
        post("EBYS Slicer: stayProb (all) = " + val + "\n");
        outlet(1, "stayProb", "all", val);
    } else {
        var track = trackOrV;
        var val   = clamp(parseFloat(v), 0.0, 1.0);
        if (STAY_PROB.hasOwnProperty(track)) {
            STAY_PROB[track] = val;
            post("EBYS Slicer: stayProb[" + track + "] = " + val + "\n");
            outlet(1, "stayProb", track, val);
        }
    }
}

function setMaxSlices(n) {
    n = parseInt(n);
    MAX_SLICES_PER_STEM = (n > 0) ? n : 0;
    post("EBYS Slicer: maxSlices = " + (MAX_SLICES_PER_STEM || "unlimited") + "\n");
}

function setFallbackBPM(n) {
    n = parseFloat(n);
    if (n > 40 && n < 280) {
        FALLBACK_BPM = n;
        post("EBYS Slicer: fallbackBPM = " + FALLBACK_BPM + "\n");
        applyNow();
    }
}

// setGlobalBPM N  — force ALL stems to use N BPM, ignoring analysis
// setGlobalBPM 0  — clear override, resume using analyzed BPM
function setGlobalBPM(n) {
    n = parseFloat(n);
    if (n === 0) {
        GLOBAL_BPM = 0;
        post("EBYS Slicer: globalBPM cleared — using analyzed BPM\n");
        applyNow();
    } else if (n > 40 && n < 280) {
        GLOBAL_BPM = n;
        post("EBYS Slicer: globalBPM = " + GLOBAL_BPM + " — applying now, segBars=" + SEGMENT_BARS + "\n");
        outlet(1, "globalBPM", GLOBAL_BPM);
        applyNow();
    } else {
        post("EBYS Slicer: setGlobalBPM rejected value: " + n + "\n");
    }
}

// Internal helper — single source of truth for BPM resolution
function effectiveBPM(track) {
    if (GLOBAL_BPM > 0) return GLOBAL_BPM;
    var analyzed = meta[track] && meta[track].BPM;
    return (analyzed > 40 && analyzed < 280) ? analyzed : FALLBACK_BPM;
}

// Stretch ratio for fluid.bufstretch~ @timeratio
// = analyzedBPM / targetBPM  (>1 = stretch longer/slower, <1 = compress/faster)
// Returns 1.0 when no global BPM override is active (no stretching needed).
function stretchRatioFor(track) {
    if (GLOBAL_BPM <= 0) return 1.0;
    var analyzed = meta[track] && meta[track].BPM;
    var srcBPM   = (analyzed > 40 && analyzed < 280) ? analyzed : FALLBACK_BPM;
    return srcBPM / GLOBAL_BPM;
}

// Apply a parameter change immediately — restart all running stems now
function applyNow() {
    if (!running) { post("EBYS: not running — send :buildIndex then :start\n"); return; }
    if (idx.length === 0) { post("EBYS: index empty — send :buildIndex then :start\n"); return; }
    for (var t = 0; t < TRACKS.length; t++) selectSegment(TRACKS[t]);
}

// ── DESCRIPTOR DUMP ───────────────────────────────────────────────────────────
function dumpDescriptors(trackFilter) {
    var pool = (trackFilter && byTrack[trackFilter]) ? byTrack[trackFilter] : idx;
    for (var i = 0; i < pool.length; i++) {
        var s = pool[i];
        outlet(2, s.track, s.id, s.n,
               s.C.toFixed(2), s.P.toFixed(2),
               s.E.toFixed(2), s.F.toFixed(2),
               s.time.toFixed(2), s.dur.toFixed(2));
    }
    outlet(1, "dump_done", pool.length);
}

// ── RANGE QUERY ───────────────────────────────────────────────────────────────
function queryRange(trackFilter, Clo, Chi, Elo, Ehi, Flo, Fhi, Plo, Phi) {
    var pool = (trackFilter && byTrack[trackFilter]) ? byTrack[trackFilter] : idx;
    var result = [];
    for (var i = 0; i < pool.length; i++) {
        var s = pool[i];
        if (s.C < Clo || s.C > Chi) continue;
        if (s.E < Elo || s.E > Ehi) continue;
        if (s.F < Flo || s.F > Fhi) continue;
        if (s.P < Plo || s.P > Phi) continue;
        result.push(s);
    }
    return result;
}

function selectRange() {
    var args = [];
    for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
    var trackFilter = (typeof args[0] === "string") ? args.shift() : null;
    var Clo = (args[0] !== undefined) ? parseFloat(args[0]) : -Infinity;
    var Chi = (args[1] !== undefined) ? parseFloat(args[1]) :  Infinity;
    var Elo = (args[2] !== undefined) ? parseFloat(args[2]) : -Infinity;
    var Ehi = (args[3] !== undefined) ? parseFloat(args[3]) :  Infinity;
    var Flo = (args[4] !== undefined) ? parseFloat(args[4]) : -Infinity;
    var Fhi = (args[5] !== undefined) ? parseFloat(args[5]) :  Infinity;
    var Plo = (args[6] !== undefined) ? parseFloat(args[6]) : -Infinity;
    var Phi = (args[7] !== undefined) ? parseFloat(args[7]) :  Infinity;
    var pool = queryRange(trackFilter, Clo, Chi, Elo, Ehi, Flo, Fhi, Plo, Phi);
    outlet(3, pool.length);
    if (pool.length === 0) { outlet(1, "empty_range"); return; }
    var s = pool[Math.floor(Math.random() * pool.length)];
    lastSlice = s;
    outlet(0, s.track, s.time, s.dur, stretchRatioFor(s.track));
    outlet(1, "playing", s.track, s.id, s.E.toFixed(1), s.C.toFixed(0));
}

// ── TRACK WEIGHT ──────────────────────────────────────────────────────────────
// setMatchProb C 0.8  — centroid must match at 80% when selecting next slice
// setMatchProb E 0.0  — ignore energy for transition (pure descriptor search)
function setMatchProb(dim, val) {
    if (MATCH_PROB.hasOwnProperty(dim)) {
        MATCH_PROB[dim] = clamp(parseFloat(val), 0.0, 1.0);
        post("EBYS Slicer: matchProb[" + dim + "] = " + MATCH_PROB[dim] + "\n");
    }
}

// setDirPref E 1   — prefer slices where energy is rising
// setDirPref E -1  — prefer slices where energy is falling
// setDirPref E 0   — neutral (default)
function setDirPref(dim, val) {
    if (DIR_PREF.hasOwnProperty(dim)) {
        DIR_PREF[dim] = clamp(parseFloat(val), -1.0, 1.0);
        post("EBYS Slicer: dirPref[" + dim + "] = " + DIR_PREF[dim] + "\n");
    }
}

// setDirWeight 1.5 — amplify/reduce overall direction bias (default 1.0)
function setDirWeight(val) {
    DIR_WEIGHT = clamp(parseFloat(val), 0.0, 5.0);
    post("EBYS Slicer: dirWeight = " + DIR_WEIGHT + "\n");
}

function setTrackWeight(track, w) {
    if (trackWeights.hasOwnProperty(track)) {
        trackWeights[track] = clamp(parseFloat(w), 0.0, 1.0);
        post("EBYS Slicer: weight[" + track + "] = " + trackWeights[track] + "\n");
    }
}

// ── INSPECTOR ─────────────────────────────────────────────────────────────────
function info() {
    post("── EBYS Slicer v2 ──\n");
    post("  segmentBars : vocals=" + SEGMENT_BARS.vocals + " melody=" + SEGMENT_BARS.melody + " bass=" + SEGMENT_BARS.bass + " drums=" + SEGMENT_BARS.drums + "\n");
    post("  quantize    : " + QUANTIZE_BARS + "\n");
    post("  stayProb    : vocals=" + STAY_PROB.vocals + " melody=" + STAY_PROB.melody + " bass=" + STAY_PROB.bass + " drums=" + STAY_PROB.drums + "\n");
    post("  fallbackBPM : " + FALLBACK_BPM + "\n");
    post("  globalBPM   : " + (GLOBAL_BPM > 0 ? GLOBAL_BPM + " (OVERRIDE ACTIVE)" : "off") + "\n");
    var db = trackDownbeats["vocals"];
    if (db) {
        post("  downbeats   : meter=" + db.meter + "  bpm=" + db.bpm
             + "  avgBarMs=" + db.avgBarMs
             + "  n=" + (db.downbeats_ms ? db.downbeats_ms.length : 0)
             + "  conf=" + db.confidence
             + (db.confidence < DOWNBEAT_MIN_CONF ? " (BELOW THRESHOLD → BPM grid)" : "") + "\n");
    } else {
        post("  downbeats   : none (run allin1_tagger.py then send reloadDownbeats)\n");
    }
    post("  matchProb   : C=" + MATCH_PROB.C + " E=" + MATCH_PROB.E
                       + " F=" + MATCH_PROB.F + " P=" + MATCH_PROB.P + "\n");
    post("  dirPref     : C=" + DIR_PREF.C + " E=" + DIR_PREF.E
                       + " F=" + DIR_PREF.F + " P=" + DIR_PREF.P
                       + " weight=" + DIR_WEIGHT + "\n");
    post("  total slices: " + idx.length + "\n");
    for (var t = 0; t < TRACKS.length; t++) {
        var track = TRACKS[t];
        var arr   = byTrack[track] || [];
        var r     = ranges[track]  || {};
        var bpm   = (meta[track] && meta[track].BPM) ? meta[track].BPM : FALLBACK_BPM;
        var barMs = getBarMs(track, bpm);
        post("  " + track + ": " + arr.length + " slices"
             + "  BPM=" + bpm.toFixed(1)
             + "  key=" + (meta[track] ? meta[track].key : "?") + "\n");
        if (r.E) {
            post("    seg≈" + (barMs * SEGMENT_BARS).toFixed(0) + "ms"
                 + "  (" + SEGMENT_BARS + " bars)"
                 + "  E=[" + r.E.min.toFixed(1) + "," + r.E.max.toFixed(1) + "]\n");
        }
    }
    post("  running  : " + running + "\n");
    post("  lastSlice: " + (lastSlice
         ? lastSlice.track + " @" + lastSlice.time.toFixed(0) + "ms"
         : "none") + "\n");
}

// ── RESET ─────────────────────────────────────────────────────────────────────
function reset() {
    running   = false;
    idx       = [];
    byTrack   = {};
    meta      = {};
    ranges    = {};
    lastSlice = null;
    lastIdx   = { vocals: 0, melody: 0, bass: 0, drums: 0 };
    outlet(1, "reset");
    post("EBYS Slicer: reset\n");
}
