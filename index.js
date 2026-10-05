import http from 'http';
import { readFileSync } from 'fs';
import { gzipSync } from 'zlib';
import { WebSocketServer } from 'ws';
import { Game, ITEM_TYPES, MAP_WIDTH, MAP_HEIGHT, TICK_RATE, BALL_SPEED } from './game.js';

const port = process.env.PORT || 3000;

const SEND_EVERY = 2;                 // broadcast every 2 ticks (30 Hz)
const MAX_BUFFERED = 64 * 1024;       // skip snapshots for clients that can't keep up
const HEARTBEAT_MS = 30000;

/*
 *  Static files, loaded and compressed once
 */
const file = (path, type, cache) => {
    const body = readFileSync(new URL(path, import.meta.url));
    return { body, gzip: gzipSync(body, { level: 9 }), type, cache };
};
const files = {
    '/': file('./index.html', 'text/html; charset=utf-8', 'no-cache'),
    '/assets/img/grass.jpg': file('./public/assets/img/grass.jpg', 'image/jpeg', 'public, max-age=604800'),
};

const server = http.createServer((req, res) => {
    const f = files[req.url.split('?')[0]];
    if (f === undefined) {
        res.writeHead(404).end();
        return;
    }
    const useGzip = f.type.startsWith('text/') && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const body = useGzip ? f.gzip : f.body;
    res.writeHead(200, {
        'Content-Type': f.type,
        'Content-Length': body.length,
        'Cache-Control': f.cache,
        ...(useGzip ? { 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' } : {}),
    });
    res.end(body);
});

/*
 *  Game
 */
const game = new Game();
const wss = new WebSocketServer({ server, maxPayload: 256, perMessageDeflate: false });
const sockets = new Map(); // player id -> socket

const send = (ws, msg) => {
    if (ws.readyState === ws.OPEN)
        ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
};

game.onDeath = (p) => {
    const ws = sockets.get(p.id);
    if (ws !== undefined)
        send(ws, ['d']);
};

const broadcast = () => {
    const e = game.events;
    // Serialize once, send the same string to everyone
    const snapshot = JSON.stringify(['s', Math.round(performance.now()), game.snapshotPlayers(),
        e.balls, e.itemsAdded, e.itemsRemoved, e.meta, e.left]);
    game.resetEvents();

    for (const [id, ws] of sockets) {
        if (ws.readyState !== ws.OPEN || ws.bufferedAmount > MAX_BUFFERED)
            continue;
        ws.send(snapshot);

        const p = game.players.get(id);
        if (p.statsDirty) {
            p.statsDirty = false;
            ws.send(JSON.stringify(['m', p.ammo, p.range]));
        }
    }
};

/*
 *  Main loop: fixed timestep, catches up if the timer fires late
 */
const TICK_MS = 1000 / TICK_RATE;
let last = performance.now();
let acc = 0;
setInterval(() => {
    const now = performance.now();
    acc = Math.min(acc + now - last, TICK_MS * 5);
    last = now;
    while (acc >= TICK_MS) {
        acc -= TICK_MS;
        game.step();
        if (game.tick % SEND_EVERY === 0)
            broadcast();
    }
}, TICK_MS);

/*
 *  Connections
 */
wss.on('connection', (ws) => {
    const p = game.addPlayer();
    sockets.set(p.id, ws);
    ws.isAlive = true;

    send(ws, ['w', p.id, MAP_WIDTH, MAP_HEIGHT, BALL_SPEED, ITEM_TYPES.map(t => t.emoji),
        game.snapshotMeta(), game.snapshotItems()]);

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
        let m;
        try { m = JSON.parse(data); } catch { return; }
        if (!Array.isArray(m))
            return;

        switch (m[0]) {
            case 'k': game.setWalking(p, m[1]); break;   // walk forward on/off
            case 'l': game.setAngle(p, m[1]); break;     // look angle (radians)
            case 'f': game.shoot(p); break;              // fire
            case 'n': game.setName(p, m[1]); break;      // set name
            case 'r': game.respawn(p); break;            // play again
        }
    });

    ws.on('close', () => {
        sockets.delete(p.id);
        game.removePlayer(p);
    });
});

// Drop dead connections
setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) {
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        ws.ping();
    }
}, HEARTBEAT_MS);

server.listen(port, () => {
    console.log('listening on *:' + port);
});
