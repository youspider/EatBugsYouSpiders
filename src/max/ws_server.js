// ws_server.js — EBYS WebSocket bridge (no external dependencies)
// Uses Node.js built-in http + manual WebSocket handshake (RFC 6455)

const Max    = require('max-api');
const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const PORT = 8080;

// Register early — before any async code — so meter messages are never "Unhandled"
// even if they arrive during the N4M startup window before the real handler below.
Max.addHandler('meter', () => {});

// ── State cache ───────────────────────────────────────────────────────────────
const state = {
    running:      false,
    track:        'no track loaded',
    bpm:          0,
    key:          '?',
    slices:       [0, 0, 0, 0],
    analysisDone: false,   // set true when analysisDone arrives (or library already exists)
    stems: {
        vocals: { id: '--', pos: 0.0, C: 0, E: 0, F: 0, P: 0, H: 0, T: 0, track: '' },
        melody: { id: '--', pos: 0.0, C: 0, E: 0, F: 0, P: 0, H: 0, T: 0, track: '' },
        bass:   { id: '--', pos: 0.0, C: 0, E: 0, F: 0, P: 0, H: 0, T: 0, track: '' },
        drums:  { id: '--', pos: 0.0, C: 0, E: 0, F: 0, P: 0, H: 0, T: 0, track: '' },
    }
};

// Pre-check: if analysis_library.json already has entries, mark analysisDone now so
// new TUI clients that connect after the patch loads get the flag immediately.
try {
    const lib = parseMaxDictJSON(fs.readFileSync(path.join(__dirname, 'analysis_library.json'), 'utf8'));
    if (Object.keys(lib).length > 0) {
        state.analysisDone = true;
        Max.post('ws_server: library present — analysisDone pre-set\n');
    }
} catch(e) { /* no library yet — that's fine */ }

const clients = new Set();

// ── WebSocket frame helpers ───────────────────────────────────────────────────

function encodeFrame(data) {
    const payload = Buffer.from(data, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81; // FIN + text frame
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
}

function decodeFrames(buf) {
    const messages = [];
    let offset = 0;
    while (offset < buf.length) {
        if (offset + 2 > buf.length) break;
        const b1 = buf[offset];
        const b2 = buf[offset + 1];
        const opcode = b1 & 0x0f;
        const masked  = (b2 & 0x80) !== 0;
        let payloadLen = b2 & 0x7f;
        let headerLen = 2;
        if (payloadLen === 126) {
            if (offset + 4 > buf.length) break;
            payloadLen = buf.readUInt16BE(offset + 2);
            headerLen = 4;
        } else if (payloadLen === 127) {
            if (offset + 10 > buf.length) break;
            payloadLen = Number(buf.readBigUInt64BE(offset + 2));
            headerLen = 10;
        }
        const maskOffset = offset + headerLen;
        const dataOffset = maskOffset + (masked ? 4 : 0);
        if (dataOffset + payloadLen > buf.length) break;
        if (opcode === 8) { messages.push(null); offset = dataOffset + payloadLen; break; } // close
        if (opcode === 0x9) { // ping
            offset = dataOffset + payloadLen; continue;
        }
        const raw = buf.slice(dataOffset, dataOffset + payloadLen);
        let payload;
        if (masked) {
            const mask = buf.slice(maskOffset, maskOffset + 4);
            payload = Buffer.alloc(payloadLen);
            for (let i = 0; i < payloadLen; i++) payload[i] = raw[i] ^ mask[i % 4];
        } else {
            payload = raw;
        }
        messages.push(payload.toString('utf8'));
        offset = dataOffset + payloadLen;
    }
    // Return both messages and how many bytes were consumed so the caller can trim the buffer
    return { messages, consumed: offset };
}

// ── HTTP server + WebSocket upgrade ──────────────────────────────────────────

const server = http.createServer((req, res) => {
    // POST /progress — watch_demucs.py sends Demucs progress here; we broadcast to TUI
    if (req.method === 'POST' && req.url === '/progress') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try { broadcast(JSON.parse(body)); } catch(e) {}
            res.writeHead(200); res.end('ok');
        });
        return;
    }
    res.writeHead(200); res.end('EBYS ws_server');
});

server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    clients.add(socket);
    Max.post('ws_server: TUI connected (' + clients.size + ')\n');

    // Send full state snapshot
    socket.write(encodeFrame(JSON.stringify({ type: 'full', ...state })));
    // If analysis was already complete before this client connected, tell it now
    if (state.analysisDone) socket.write(encodeFrame(JSON.stringify({ type: 'analysisDone' })));

    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        const { messages, consumed } = decodeFrames(buf);
        buf = buf.slice(consumed); // trim processed bytes so old frames aren't replayed
        messages.forEach(msg => {
            if (msg === null) { socket.destroy(); return; }
            try {
                const m = JSON.parse(msg);

                // :bake — save training snapshot (intent + Cricket cmds + user corrections + live state)
                if (m.type === 'bake') {
                    const snapshot = {
                        timestamp:        new Date().toISOString(),
                        intent:           m.intent           || '',
                        cricket_cmds:     m.cricket_cmds     || [],
                        user_corrections: m.user_corrections || [],
                        final_cmds:       m.final_cmds       || [],
                        track:            state.track,
                        bpm:              state.bpm,
                        stems:            JSON.parse(JSON.stringify(state.stems)),
                    };
                    const logPath = path.join(__dirname, '..', 'training_log.jsonl');
                    fs.appendFileSync(logPath, JSON.stringify(snapshot) + '\n');
                    Max.post('ws_server: 🫳 baked\n');
                    broadcast({ type: 'sys', msg: '🫳 baked' });
                    return;
                }

                if (m.type === 'command' && m.text) {
                    const parts = m.text.trim().split(/\s+/);
                    const atoms = parts.map(p => isNaN(p) ? p : parseFloat(p));
                    if (atoms[0] === 'pitchShift') {
                        // :pitchShift <stem> <semitones>
                        // stem = vocals | melody | bass | drums | all
                        // semitones = positive (up) or negative (down), e.g. 3 or -2
                        const stem      = String(atoms[1] || 'all');
                        const semitones = parseFloat(atoms[2]) || 0;
                        broadcast({ type: 'param', key: 'pitchShift', stem, semitones });
                        Max.outlet('pitchShift', stem, semitones);
                    } else if (atoms[0] === 'buildIndex') {
                        // Pre-populate the named dict from Node before triggering slicer.js,
                        // then run t-SNE in the background (no patch wiring needed).
                        prepareLibraryDict()
                            .then(() => {
                                Max.outlet(...atoms);
                                Max.post('ws_server: scheduling t-SNE in 500ms…\n');
                                setTimeout(() => {
                                    Max.post('ws_server: t-SNE timer fired\n');
                                    try { computeAndWriteUMAP(); }
                                    catch(e) { Max.post('ws_server: UMAP error: ' + String(e) + '\n'); }
                                }, 500);
                            })
                            .catch(e => {
                                Max.post('ws_server: library prep failed: ' + String(e) + '\n');
                                Max.outlet(...atoms);
                            });
                    } else {
                        Max.outlet(...atoms);
                    }
                }  // end command
            } catch(e) {}
        });
    });

    socket.on('close', () => {
        clients.delete(socket);
        Max.post('ws_server: TUI disconnected (' + clients.size + ')\n');
    });

    socket.on('error', () => { clients.delete(socket); });
});

server.listen(PORT, () => {
    Max.post('ws_server: ready on port ' + PORT + '\n');
    Max.outlet('ws_ready');   // signals the patch to start the meter metro
});

// ── Library dict pre-loader ───────────────────────────────────────────────────
// Max's JS Dict.readfromfile() is unavailable; instead we read the JSON in Node
// (no size limit) and push it into a named Max dict via Max.setDict().
// slicer.js then opens the same named dict — no file I/O in the JS object needed.
let cachedLibraryData = null;

// Max Dict JSON export uses `{}` as a preamble — byte 1 is `}` where standard JSON
// needs `"`. Fix: replace the leading `{}` with `{"` before parsing.
function parseMaxDictJSON(raw) {
    if (raw.charCodeAt(0) === 0x7b && raw.charCodeAt(1) === 0x7d) {
        raw = '{"' + raw.slice(2);
    }
    return JSON.parse(raw);
}

function prepareLibraryDict() {
    const libPath = path.join(__dirname, 'analysis_library.json');
    const raw  = fs.readFileSync(libPath, 'utf8');
    cachedLibraryData = parseMaxDictJSON(raw);

    // Max.setDict fails for large nested objects (>~1 MB), and Max's built-in
    // JsFile API is capped at 32 767 bytes — both too small for analysis_library.json.
    // Solution: send the JSON string to slicer.js in 2 KB chunks via Max outlet.
    // slicer.js accumulates libchunk messages and parses once all arrive.
    const jsonStr = JSON.stringify(cachedLibraryData);
    const CHUNK   = 2048;
    const total   = Math.ceil(jsonStr.length / CHUNK);
    Max.post('ws_server: sending library in ' + total + ' chunks (' + jsonStr.length + ' chars)…\n');
    for (let i = 0; i < total; i++) {
        Max.outlet('libchunk', i, total, jsonStr.substring(i * CHUNK, (i + 1) * CHUNK));
    }
    Max.post('ws_server: library chunks sent\n');

    // Send genres.json the same way — slicer.js uses it to tag slices for genre filtering.
    try {
        const genresPath = path.join(__dirname, '..', 'genres.json');
        const genresStr  = fs.readFileSync(genresPath, 'utf8');
        const gt = Math.ceil(genresStr.length / CHUNK);
        for (let i = 0; i < gt; i++) {
            Max.outlet('genrechunk', i, gt, genresStr.substring(i * CHUNK, (i + 1) * CHUNK));
        }
        Max.post('ws_server: genres sent (' + gt + ' chunks)\n');
    } catch(e) {
        Max.post('ws_server: genres.json not found — genre filtering unavailable\n');
    }

    return Promise.resolve();  // keep .then()/.catch() callers happy
}

// ── Node-side t-SNE (replaces fluid.umap~ — no patch wiring needed) ──────────

function runTSNE(features, opts) {
    opts = opts || {};
    const perplexity = Math.min(opts.perplexity || 30, Math.floor(features.length / 3));
    const nIter = opts.nIter || 250;
    const lr    = opts.lr    || 200;
    const n = features.length;
    const dim = features[0].length;

    if (n < 5) return features.map(() => [(Math.random()-0.5)*0.1, (Math.random()-0.5)*0.1]);

    // Normalise each dimension to [0,1]
    const mins = [], rngs = [];
    for (let j = 0; j < dim; j++) {
        let mn = Infinity, mx = -Infinity;
        for (let i = 0; i < n; i++) {
            if (features[i][j] < mn) mn = features[i][j];
            if (features[i][j] > mx) mx = features[i][j];
        }
        mins.push(mn); rngs.push(mx > mn ? mx - mn : 1);
    }
    const X = features.map(f => f.map((v, j) => (v - mins[j]) / rngs[j]));

    // Pairwise squared distances
    const D2 = Array.from({length: n}, (_, i) =>
        Array.from({length: n}, (_, j) => {
            if (i === j) return 0;
            let s = 0;
            for (let k = 0; k < dim; k++) { const d = X[i][k] - X[j][k]; s += d*d; }
            return s;
        })
    );

    // Conditional probabilities with perplexity-based bandwidth search
    const P = Array.from({length: n}, () => new Array(n).fill(0));
    const logPerp = Math.log(perplexity);
    for (let i = 0; i < n; i++) {
        let lo = -Infinity, hi = Infinity, beta = 1;
        for (let t = 0; t < 50; t++) {
            let sum = 0;
            for (let j = 0; j < n; j++) { if (i !== j) sum += Math.exp(-D2[i][j] * beta); }
            if (sum === 0) sum = 1e-10;
            let H = 0;
            for (let j = 0; j < n; j++) {
                if (i === j) continue;
                const p = Math.exp(-D2[i][j] * beta) / sum;
                if (p > 1e-12) H -= p * Math.log(p);
            }
            const diff = H - logPerp;
            if (Math.abs(diff) < 1e-5) break;
            if (diff > 0) { lo = beta; beta = hi === Infinity ? beta * 2 : (beta + hi) / 2; }
            else          { hi = beta; beta = lo === -Infinity ? beta / 2 : (beta + lo) / 2; }
        }
        let sum = 0;
        for (let j = 0; j < n; j++) { if (i !== j) sum += Math.exp(-D2[i][j] * beta); }
        if (sum === 0) sum = 1e-10;
        for (let j = 0; j < n; j++) P[i][j] = i === j ? 0 : Math.exp(-D2[i][j] * beta) / sum;
    }

    // Symmetrise P_ij = (P_i|j + P_j|i) / 2n, clipped for stability
    const Ps = Array.from({length: n}, (_, i) =>
        Array.from({length: n}, (_, j) => Math.max((P[i][j] + P[j][i]) / (2*n), 1e-12))
    );

    // Random init in low-D
    const Y     = Array.from({length: n}, () => [(Math.random()-0.5)*0.01, (Math.random()-0.5)*0.01]);
    const iY    = Array.from({length: n}, () => [0, 0]);
    const gains = Array.from({length: n}, () => [1, 1]);

    for (let iter = 0; iter < nIter; iter++) {
        const exag = iter < 100 ? 4 : 1;

        // Student-t kernel in low-D
        const num = Array.from({length: n}, (_, i) =>
            Array.from({length: n}, (_, j) => {
                if (i === j) return 0;
                const dx = Y[i][0]-Y[j][0], dy = Y[i][1]-Y[j][1];
                return 1 / (1 + dx*dx + dy*dy);
            })
        );
        let sumQ = 0;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) sumQ += num[i][j];
        if (sumQ === 0) sumQ = 1e-10;

        // Gradient
        const dY = Array.from({length: n}, () => [0, 0]);
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                if (i === j) continue;
                const pq   = exag * Ps[i][j] - num[i][j] / sumQ;
                const mult = 4 * pq * num[i][j];
                dY[i][0] += mult * (Y[i][0] - Y[j][0]);
                dY[i][1] += mult * (Y[i][1] - Y[j][1]);
            }
        }

        // Update with momentum + adaptive gains
        const mom = iter < 20 ? 0.5 : 0.8;
        for (let i = 0; i < n; i++) {
            for (let k = 0; k < 2; k++) {
                const sameSign = (dY[i][k] > 0) === (iY[i][k] > 0);
                gains[i][k] = sameSign ? Math.max(0.01, gains[i][k] * 0.8) : gains[i][k] + 0.2;
                iY[i][k] = mom * iY[i][k] - lr * gains[i][k] * dY[i][k];
                Y[i][k] += iY[i][k];
            }
        }

        // Re-centre every 50 iters
        if (iter % 50 === 0) {
            let cx = 0, cy = 0;
            for (let i = 0; i < n; i++) { cx += Y[i][0]; cy += Y[i][1]; }
            cx /= n; cy /= n;
            for (let i = 0; i < n; i++) { Y[i][0] -= cx; Y[i][1] -= cy; }
        }
    }
    return Y;
}

function computeAndWriteUMAP() {
    const data = cachedLibraryData;
    if (!data) { Max.post('ws_server: UMAP skipped — no library cached\n'); return; }

    const SUFFIXES = { vocals:'_vocals.wav', melody:'_other.wav', bass:'_bass.wav', drums:'_drums.wav' };
    const topKeys  = Object.keys(data);
    const stemFile = {};
    for (const k of topKeys) {
        const kl = k.toLowerCase();
        for (const s in SUFFIXES) {
            if (kl.includes(SUFFIXES[s])) { stemFile[s] = k; break; }
        }
    }

    const umapResults = {};
    for (const stem of ['vocals','melody','bass','drums']) {
        const filename = stemFile[stem];
        if (!filename) continue;
        const stemData = data[filename] && data[filename][stem];
        if (!stemData || !stemData.slices) continue;

        const sliceKeys = Object.keys(stemData.slices).filter(k => k.startsWith('slice_')).sort();
        const ids = [], features = [];
        for (const id of sliceKeys) {
            const sd = stemData.slices[id];
            const M1=parseFloat(sd.M1)||0, M2=parseFloat(sd.M2)||0, M3=parseFloat(sd.M3)||0;
            const M4=parseFloat(sd.M4)||0, M5=parseFloat(sd.M5)||0;
            const T = Math.sqrt((M1*M1+M2*M2+M3*M3+M4*M4+M5*M5)/5);
            ids.push(id);
            features.push([
                parseFloat(sd.C)||0,
                parseFloat(sd.E)||-60,
                parseFloat(sd.F)||0,
                parseFloat(sd.P)||0,
                parseFloat(sd.H)||0,
                T
            ]);
        }
        if (features.length < 5) continue;

        const nIter = features.length > 400 ? 150 : features.length > 200 ? 200 : 250;
        Max.post('ws_server: t-SNE [' + stem + ']: ' + features.length + ' slices (' + nIter + ' iters)…\n');
        const t0 = Date.now();
        const embedding = runTSNE(features, { nIter });
        Max.post('ws_server: t-SNE [' + stem + ']: done in ' + (Date.now()-t0) + 'ms\n');

        const coords = {};
        for (let i = 0; i < ids.length; i++) coords[ids[i]] = [embedding[i][0], embedding[i][1]];
        umapResults[stem] = coords;
    }

    const outPath = path.join(__dirname, 'umap_coords.json');
    fs.writeFileSync(outPath, JSON.stringify(umapResults));
    Max.post('ws_server: umap_coords.json written\n');

    // Compute per-stem descriptor ranges and write stem_ranges.json (bypasses
    // the 32767-byte JsFile limit in Max's built-in JS engine / slicer.js).
    const stemRanges = {};
    for (const stem of ['vocals','melody','bass','drums']) {
        const filename = stemFile[stem];
        if (!filename) continue;
        const stemData = data[filename] && data[filename][stem];
        if (!stemData || !stemData.slices) continue;
        const sliceKeys = Object.keys(stemData.slices).filter(k => k.startsWith('slice_'));
        if (!sliceKeys.length) continue;
        const acc = {};
        for (const d of ['C','E','F','P','H']) { acc[d] = { min: Infinity, max: -Infinity }; }
        acc['T'] = { min: Infinity, max: -Infinity };
        for (const id of sliceKeys) {
            const sd = stemData.slices[id];
            for (const d of ['C','E','F','P','H']) {
                const v = parseFloat(sd[d]);
                if (isFinite(v)) { if (v < acc[d].min) acc[d].min=v; if (v > acc[d].max) acc[d].max=v; }
            }
            const M1=parseFloat(sd.M1)||0, M2=parseFloat(sd.M2)||0, M3=parseFloat(sd.M3)||0;
            const M4=parseFloat(sd.M4)||0, M5=parseFloat(sd.M5)||0;
            const T = Math.sqrt((M1*M1+M2*M2+M3*M3+M4*M4+M5*M5)/5);
            if (T < acc['T'].min) acc['T'].min=T; if (T > acc['T'].max) acc['T'].max=T;
        }
        stemRanges[stem] = acc;
    }
    const rangesPath = path.join(__dirname, 'stem_ranges.json');
    fs.writeFileSync(rangesPath, JSON.stringify(stemRanges));
    Max.post('ws_server: stem_ranges.json written\n');

    // Defer broadcast to next event-loop tick so the WebSocket layer recovers
    // from the ~5s synchronous t-SNE block before we try to write to the socket.
    setImmediate(() => {
        broadcast({ type: 'umapDone' });
        Max.post('ws_server: umapDone broadcast sent (' + clients.size + ' clients)\n');
        Max.outlet('umapDone');
    });
}

// ── Broadcast ─────────────────────────────────────────────────────────────────
function broadcast(obj) {
    const frame = encodeFrame(JSON.stringify(obj));
    clients.forEach(s => { try { s.write(frame); } catch(e) {} });
}

// ── Slicer outlet 1 — status messages ────────────────────────────────────────
Max.addHandler('desc', (track, C, E, F, P, H, T, tC, tE, tF, tP, tH, tT) => {
    if (!state.stems[track]) return;
    const tension = (v) => (v === undefined || v === null || v === '') ? null : parseFloat(v);
    Object.assign(state.stems[track], {
        C: parseFloat(C)||0, E: parseFloat(E)||0,
        F: parseFloat(F)||0, P: parseFloat(P)||0,
        H: parseFloat(H)||0, T: parseFloat(T)||0,
        tC: tension(tC), tE: tension(tE), tF: tension(tF),
        tP: tension(tP), tH: tension(tH), tT: tension(tT),
    });
    // 'desc' type lets the TUI compute novelty the instant fresh descriptors arrive
    broadcast({ type: 'desc', name: track, ...state.stems[track] });
});

Max.addHandler('seg', (track, id, durStr, distStr, startFrac, endFrac) => {
    if (!state.stems[track]) return;
    state.stems[track].id = String(id);
    if (startFrac !== undefined) state.stems[track].sliceStart = parseFloat(startFrac);
    if (endFrac   !== undefined) state.stems[track].sliceEnd   = parseFloat(endFrac);
    broadcast({ type: 'stem', name: track, ...state.stems[track] });
});

Max.addHandler('track_name', (...args) => {
    state.track = args.join(' ');
    broadcast({ type: 'state', running: state.running,
                track: state.track, bpm: state.bpm,
                key: state.key, slices: state.slices });
    // Pre-populate all stem track fields so the name shows immediately (before playback)
    ['vocals', 'melody', 'bass', 'drums'].forEach(stem => {
        state.stems[stem].track = state.track;
        broadcast({ type: 'stemTrack', name: stem, track: state.track });
    });
});

Max.addHandler('globalBPM', (n) => {
    broadcast({ type: 'param', key: 'globalBPM', value: n });
});

Max.addHandler('segmentBars', (n) => {
    broadcast({ type: 'param', key: 'bars', value: n });
});

Max.addHandler('stemTrack', (stem, trackName) => {
    if (!state.stems[stem]) return;
    state.stems[stem].track = String(trackName || '');
    broadcast({ type: 'stemTrack', name: String(stem), track: String(trackName || '') });
});

Max.addHandler('stemDurMs', (track, ms) => {
    broadcast({ type: 'stemDurMs', track: String(track), ms: parseFloat(ms) });
});

Max.addHandler('slice_ms', (track, ms) => {
    broadcast({ type: 'slice_ms', name: String(track), timeMs: parseFloat(ms) || 0 });
});

Max.addHandler('meter', (lufs, dbfs) => {
    const l = parseFloat(lufs);
    const d = parseFloat(dbfs);
    // Only broadcast valid numbers — NaN (no signal) serialises to null in JSON
    // which would poison state.lufs/dbfs in the TUI and reset the display to '--'
    if (isFinite(l) && isFinite(d)) {
        broadcast({ type: 'meter', lufs: l, dbfs: d });
    }
});

Max.addHandler('ready', (n) => {
    broadcast({ type: 'state', running: state.running,
                track: state.track, bpm: state.bpm,
                key: state.key, slices: state.slices });
});

Max.addHandler('stopped', () => {
    state.running = false;
    broadcast({ type: 'state', running: false,
                track: state.track, bpm: state.bpm,
                key: state.key, slices: state.slices });
});

// ── Slicer outlet 0 — playback triggers ──────────────────────────────────────
// New format (v2 multi-track): track  slot  startFrac  endFrac  stretchRatio  segDurMs
// After Max routes by stem name, args here are: slot startFrac endFrac stretchRatio segDurMs
function handlePlayback(track, slot, startFrac) {
    if (!state.stems[track]) return;
    // slot = source track index (int); startFrac = 0–1 position in source buffer
    state.stems[track].pos  = parseFloat(startFrac) || 0;
    state.stems[track].slot = parseInt(slot) || 0;
    broadcast({ type: 'stem', name: track, ...state.stems[track] });
}
Max.addHandler('vocals', (slot, startFrac, endFrac, stretchRatio, segDurMs) => {
    if (!state.running) {
        state.running = true;
        broadcast({ type: 'state', running: true,
                    track: state.track, bpm: state.bpm,
                    key: state.key, slices: state.slices });
    }
    handlePlayback('vocals', slot, startFrac);
});
Max.addHandler('melody', (slot, startFrac) => { handlePlayback('melody', slot, startFrac); });
Max.addHandler('bass',   (slot, startFrac) => { handlePlayback('bass',   slot, startFrac); });
Max.addHandler('drums',  (slot, startFrac) => { handlePlayback('drums',  slot, startFrac); });

// ── State / meta ──────────────────────────────────────────────────────────────
Max.addHandler('state', (running) => {
    state.running = (parseInt(running) !== 0);
    broadcast({ type: 'state', running: state.running,
                track: state.track, bpm: state.bpm,
                key: state.key, slices: state.slices });
});

Max.addHandler('meta', (...args) => {
    if (args.length < 3) return;
    state.key   = String(args[args.length - 1]);
    state.bpm   = parseFloat(args[args.length - 2])||0;
    state.track = args.slice(0, args.length - 2).join(' ');
    broadcast({ type: 'state', running: state.running,
                track: state.track, bpm: state.bpm,
                key: state.key, slices: state.slices });
});

Max.addHandler('slices', (v, m, b, d) => {
    state.slices = [parseInt(v)||0, parseInt(m)||0, parseInt(b)||0, parseInt(d)||0];
    broadcast({ type: 'state', running: state.running,
                track: state.track, bpm: state.bpm,
                key: state.key, slices: state.slices });
});

Max.addHandler('param', (key, value) => {
    broadcast({ type: 'param', key, value });
});

// Silence unhandled-message log — slicer.js emits this when it needs stem durations
Max.addHandler('need_stemDurs', () => {});

Max.addHandler('index_empty', () => {
    broadcast({ type: 'sys', msg: '⚠ index empty — send :buildIndex before :start' });
});

// streamUpdated — sent when streamWatcher detects stream.txt changed.
// genre + madmom are already written to disk; FluCoMa is about to start.
Max.addHandler('streamUpdated', () => {
    broadcast({ type: 'streamUpdated' });
});

// analysisDone — sent by analyze_reader when all FluCoMa stems are done.
// Stops the TUI spinner that was started by :analyzeAll.
Max.addHandler('analysisDone', () => {
    state.analysisDone = true;
    broadcast({ type: 'analysisDone' });
});

// umapDone — slicer.js finished writing umap_coords.json; tell TUI to reload.
Max.addHandler('umapDone', () => {
    broadcast({ type: 'umapDone' });
});

// resetMemory: TUI → ws_server → Max patch → slice_writer.js + analyze_reader.js
Max.addHandler('resetMemory', () => {
    Max.outlet('resetMemory');
});

Max.post('ws_server.js loaded\n');
