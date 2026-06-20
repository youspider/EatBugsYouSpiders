// EBYS — Buffer Manager  v2
//
// Two-level ring buffer architecture for scalable multi-source-track playback.
//
// ── LEVEL 1: Source buffers (src_N_stem) ─────────────────────────────────────
//   2 per stem × 4 stems = 8 buffer~ objects (src_0/1_voc/drm/bss/mel).
//   src.active  = slot currently used for composition (don't overwrite)
//   src.staging = slot available for loading the next source track
//
// ── LEVEL 2: Ring buffers (ring_N_stem) ──────────────────────────────────────
//   2 per stem × 4 stems = 8 small pre-allocated buffer~ objects.
//   fluid.bufcompose~ copies the exact segment from src → ring.staging (~1ms).
//   After compose: ring.active ↔ ring.staging swap; karma~ plays ring.active.
//
// ── Inlet 0 messages ─────────────────────────────────────────────────────────
//   vocals    sourceSlot  startFrac  endFrac  stretchRatio  segDurMs  → play
//   melody    sourceSlot  ...
//   bass      sourceSlot  ...
//   drums     sourceSlot  ...
//   preload   stem  sourceSlot    → speculative disk preload
//   sourceTrack  slotIdx  ...nameParts  → register slot → track name mapping
//   src_done  stemShort  srcSlot   → src buffer~ finished loading from disk
//   ring_done stemShort            → fluid.bufcompose~ finished copy
//
// ── Outlets ───────────────────────────────────────────────────────────────────
//   0  → buffer~ src_0_voc   "read <path>"
//   1  → buffer~ src_1_voc   "read <path>"
//   2  → buffer~ src_0_drm   "read <path>"
//   3  → buffer~ src_1_drm   "read <path>"
//   4  → buffer~ src_0_bss   "read <path>"
//   5  → buffer~ src_1_bss   "read <path>"
//   6  → buffer~ src_0_mel   "read <path>"
//   7  → buffer~ src_1_mel   "read <path>"
//   8  → fluid.bufcompose~ voc  (source/startframe/numframes/destination/deststartframe/bang)
//   9  → fluid.bufcompose~ drm
//  10  → fluid.bufcompose~ bss
//  11  → fluid.bufcompose~ mel
//  12  → slot_router inlet 0  "vocals ringSlot segDurMs stretchRatio"
//  13  → status / print

autowatch = 1;
inlets    = 1;
outlets   = 14;

// ── Configuration ────────────────────────────────────────────────────────────
var HT_PATH  = "/Users/alexandregagne/Documents/EBYS/EBYS_INFRA/stems/htdemucs";
var SUFFIXES = { voc: "_vocals.wav", drm: "_drums.wav", bss: "_bass.wav", mel: "_other.wav" };
var SHORT    = { vocals: "voc", melody: "mel", bass: "bss", drums: "drm" };
var FULL     = { voc: "vocals", mel: "melody", bss: "bass", drm: "drums" };
var STEMS    = ["voc", "drm", "bss", "mel"];

// Outlets to each src buffer pair per stem
var SRC_OUTLETS  = { voc: [0, 1], drm: [2, 3], bss: [4, 5], mel: [6, 7] };
// Outlet to each fluid.bufcompose~ per stem
var COMP_OUTLET  = { voc: 8, drm: 9, bss: 10, mel: 11 };

// ── Slot → track name map ─────────────────────────────────────────────────────
var slotToTrack = {};

// ── Per-stem state ────────────────────────────────────────────────────────────
function makeSrc() {
    return {
        active:   0,
        staging:  1,
        contents: [-1, -1],
        loading:  false,
        pendingCompose: null
    };
}
function makeRing() {
    return { active: 0, staging: 1 };
}

var src          = { voc: makeSrc(),  mel: makeSrc(),  bss: makeSrc(),  drm: makeSrc()  };
var ring         = { voc: makeRing(), mel: makeRing(), bss: makeRing(), drm: makeRing() };
var composePend  = { voc: null,       mel: null,       bss: null,       drm: null       };

// ── Core helpers ──────────────────────────────────────────────────────────────

function findSrc(sh, sourceSlot) {
    var s = src[sh];
    if (s.contents[0] === sourceSlot) return 0;
    if (s.contents[1] === sourceSlot) return 1;
    return -1;
}

function loadSrc(sh, sourceSlot) {
    var trackName = slotToTrack[sourceSlot];
    if (!trackName) {
        post("buffer_manager: no name for sourceSlot " + sourceSlot + " — send buildIndex first\n");
        return false;
    }
    var s = src[sh];
    var path = HT_PATH + "/" + trackName + "/" + trackName + SUFFIXES[sh];
    s.contents[s.staging] = sourceSlot;
    s.loading = true;
    outlet(SRC_OUTLETS[sh][s.staging], "read", path);
    post("buffer_manager [" + sh + "]: loading slot " + sourceSlot
         + " (" + trackName + ") → src_" + s.staging + "_" + sh + "\n");
    return true;
}

function triggerCompose(sh, srcSlot, startFrac, endFrac, stretchRatio, segDurMs) {
    var srcBuf  = new Buffer("src_" + srcSlot + "_" + sh);
    var total   = srcBuf.framecount();
    if (total <= 0) {
        post("buffer_manager [" + sh + "]: src_" + srcSlot + "_" + sh + " is empty\n");
        return;
    }

    var startFrame = Math.round(parseFloat(startFrac) * total);
    var numFrames  = Math.round((parseFloat(endFrac) - parseFloat(startFrac)) * total);
    if (numFrames <= 0) {
        post("buffer_manager [" + sh + "]: zero-length segment, skipping\n");
        return;
    }

    var dstBuf = "ring_" + ring[sh].staging + "_" + sh;
    composePend[sh] = {
        srcSlot:      srcSlot,
        segDurMs:     parseFloat(segDurMs) || 1000,
        stretchRatio: parseFloat(stretchRatio) || 1.0
    };

    var co = COMP_OUTLET[sh];
    outlet(co, "source",          "src_" + srcSlot + "_" + sh);
    outlet(co, "startframe",      startFrame);
    outlet(co, "numframes",       numFrames);
    outlet(co, "destination",     dstBuf);
    outlet(co, "deststartframe",  0);
    outlet(co, "bang");

    post("buffer_manager [" + sh + "]: compose src_" + srcSlot + "_" + sh
         + "[" + startFrame + "+" + numFrames + "] → " + dstBuf + "\n");
}

// ── Play handler ──────────────────────────────────────────────────────────────
function handlePlay(sh, sourceSlot, startFrac, endFrac, stretchRatio, segDurMs) {
    var s = src[sh];
    var found = findSrc(sh, sourceSlot);

    if (found !== -1) {
        triggerCompose(sh, found, startFrac, endFrac, stretchRatio, segDurMs);
    } else if (s.loading && s.contents[s.staging] === sourceSlot) {
        s.pendingCompose = { sourceSlot: sourceSlot, startFrac: startFrac,
                             endFrac: endFrac, stretchRatio: stretchRatio, segDurMs: segDurMs };
        post("buffer_manager [" + sh + "]: waiting for src_" + s.staging + " to load slot " + sourceSlot + "\n");
    } else {
        s.pendingCompose = { sourceSlot: sourceSlot, startFrac: startFrac,
                             endFrac: endFrac, stretchRatio: stretchRatio, segDurMs: segDurMs };
        if (!loadSrc(sh, sourceSlot)) {
            post("buffer_manager [" + sh + "]: cannot load slot " + sourceSlot + "\n");
        }
    }
}

// ── Preload handler ───────────────────────────────────────────────────────────
function handlePreload(sh, sourceSlot) {
    var s = src[sh];
    if (findSrc(sh, sourceSlot) !== -1) return;
    if (s.loading) return;
    loadSrc(sh, sourceSlot);
}

// ── Message dispatchers ───────────────────────────────────────────────────────

function vocals(sourceSlot, startFrac, endFrac, stretchRatio, segDurMs) {
    handlePlay("voc", parseInt(sourceSlot), parseFloat(startFrac),
               parseFloat(endFrac), parseFloat(stretchRatio), parseFloat(segDurMs));
}
function melody(sourceSlot, startFrac, endFrac, stretchRatio, segDurMs) {
    handlePlay("mel", parseInt(sourceSlot), parseFloat(startFrac),
               parseFloat(endFrac), parseFloat(stretchRatio), parseFloat(segDurMs));
}
function bass(sourceSlot, startFrac, endFrac, stretchRatio, segDurMs) {
    handlePlay("bss", parseInt(sourceSlot), parseFloat(startFrac),
               parseFloat(endFrac), parseFloat(stretchRatio), parseFloat(segDurMs));
}
function drums(sourceSlot, startFrac, endFrac, stretchRatio, segDurMs) {
    handlePlay("drm", parseInt(sourceSlot), parseFloat(startFrac),
               parseFloat(endFrac), parseFloat(stretchRatio), parseFloat(segDurMs));
}

function preload(stem, sourceSlot) {
    var sh = SHORT[String(stem)];
    if (sh) handlePreload(sh, parseInt(sourceSlot));
}

function sourceTrack() {
    var args = arrayfromargs(arguments);
    if (args.length < 1) return;
    var slotIdx = parseInt(args[0]);
    var name = [];
    for (var i = 1; i < args.length; i++) name.push(String(args[i]));
    slotToTrack[slotIdx] = name.join(" ");
    post("buffer_manager: slot " + slotIdx + " = '" + slotToTrack[slotIdx] + "'\n");
    outlet(13, "registered", slotIdx, slotToTrack[slotIdx]);
}

// Called when a src buffer~ done-bang fires
function src_done(stemShort, srcSlot) {
    var sh = String(stemShort);
    srcSlot = parseInt(srcSlot);
    var s = src[sh];

    if (srcSlot !== s.staging) {
        post("buffer_manager [" + sh + "]: src_done for unexpected slot " + srcSlot + "\n");
        return;
    }

    s.loading = false;
    post("buffer_manager [" + sh + "]: src_" + srcSlot + "_" + sh + " ready (slot "
         + s.contents[srcSlot] + ")\n");

    var tmp = s.active; s.active = s.staging; s.staging = tmp;

    var pc = s.pendingCompose;
    if (pc && s.contents[s.active] === pc.sourceSlot) {
        s.pendingCompose = null;
        triggerCompose(sh, s.active, pc.startFrac, pc.endFrac, pc.stretchRatio, pc.segDurMs);
    }
}

// Called when fluid.bufcompose~ done-bang fires
function ring_done(stemShort) {
    var sh = String(stemShort);
    var r  = ring[sh];

    var tmp = r.active; r.active = r.staging; r.staging = tmp;

    var cp = composePend[sh];
    if (cp) {
        src[sh].active  = cp.srcSlot;
        src[sh].staging = 1 - cp.srcSlot;
        composePend[sh] = null;

        // Pass stretchRatio to slot_router so it can set karma~ speed factor
        outlet(12, FULL[sh], r.active, cp.segDurMs, cp.stretchRatio);
        post("buffer_manager [" + sh + "]: play ring_" + r.active + "_" + sh
             + "  " + Math.round(cp.segDurMs) + "ms"
             + "  stretch=" + cp.stretchRatio.toFixed(3) + "\n");
    }
}

// Catch-all: silently absorb status messages from slicer.js outlet 1
function anything() {}
