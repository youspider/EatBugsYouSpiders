// ws_server.js — EBYS WebSocket bridge (no external dependencies)
// Uses Node.js built-in http + manual WebSocket handshake (RFC 6455)

const Max    = require('max-api');
const http   = require('http');
const crypto = require('crypto');

const PORT = 8080;

// ── State cache ───────────────────────────────────────────────────────────────
const state = {
    running: false,
    track:   'no track loaded',
    bpm:     0,
    key:     '?',
    slices:  [0, 0, 0, 0],
    stems: {
        vocals: { id: '--', pos: 0.0, E: 0, C: 0, F: 0, P: 0 },
        melody: { id: '--', pos: 0.0, E: 0, C: 0, F: 0, P: 0 },
        bass:   { id: '--', pos: 0.0, E: 0, C: 0, F: 0, P: 0 },
        drums:  { id: '--', pos: 0.0, E: 0, C: 0, F: 0, P: 0 },
    }
};

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

    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        const { messages, consumed } = decodeFrames(buf);
        buf = buf.slice(consumed); // trim processed bytes so old frames aren't replayed
        messages.forEach(msg => {
            if (msg === null) { socket.destroy(); return; }
            try {
                const m = JSON.parse(msg);
                if (m.type === 'command' && m.text) {
                    const parts = m.text.trim().split(/\s+/);
                    const atoms = parts.map(p => isNaN(p) ? p : parseFloat(p));
                    Max.outlet(...atoms);
                }
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
});

// ── Broadcast ─────────────────────────────────────────────────────────────────
function broadcast(obj) {
    const frame = encodeFrame(JSON.stringify(obj));
    clients.forEach(s => { try { s.write(frame); } catch(e) {} });
}

// ── Slicer outlet 1 — status messages ────────────────────────────────────────
Max.addHandler('desc', (track, C, E, F, P) => {
    if (!state.stems[track]) return;
    Object.assign(state.stems[track], {
        C: parseFloat(C)||0, E: parseFloat(E)||0,
        F: parseFloat(F)||0, P: parseFloat(P)||0
    });
    broadcast({ type: 'stem', name: track, ...state.stems[track] });
});

Max.addHandler('seg', (track, id) => {
    if (!state.stems[track]) return;
    state.stems[track].id = String(id);
    broadcast({ type: 'stem', name: track, ...state.stems[track] });
});

Max.addHandler('track_name', (...args) => {
    state.track = args.join(' ');
    broadcast({ type: 'state', running: state.running,
                track: state.track, bpm: state.bpm,
                key: state.key, slices: state.slices });
});

Max.addHandler('globalBPM', (n) => {
    broadcast({ type: 'param', key: 'globalBPM', value: n });
});

Max.addHandler('segmentBars', (n) => {
    broadcast({ type: 'param', key: 'bars', value: n });
});

Max.addHandler('stemDurMs', (track, ms) => {
    broadcast({ type: 'stemDurMs', track: String(track), ms: parseFloat(ms) });
});

Max.addHandler('meter', (lufs, dbfs) => {
    broadcast({ type: 'meter', lufs: parseFloat(lufs), dbfs: parseFloat(dbfs) });
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
function handlePlayback(track, pos) {
    if (!state.stems[track]) return;
    state.stems[track].pos = parseFloat(pos)||0;
    broadcast({ type: 'stem', name: track, ...state.stems[track] });
}
Max.addHandler('vocals', (pos) => {
    if (!state.running) {
        state.running = true;
        broadcast({ type: 'state', running: true,
                    track: state.track, bpm: state.bpm,
                    key: state.key, slices: state.slices });
    }
    handlePlayback('vocals', pos);
});
Max.addHandler('melody', (pos) => { handlePlayback('melody', pos); });
Max.addHandler('bass',   (pos) => { handlePlayback('bass',   pos); });
Max.addHandler('drums',  (pos) => { handlePlayback('drums',  pos); });

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

// resetMemory: TUI → ws_server → Max patch → slice_writer.js + analyze_reader.js
Max.addHandler('resetMemory', () => {
    Max.outlet('resetMemory');
});

Max.post('ws_server.js loaded\n');
