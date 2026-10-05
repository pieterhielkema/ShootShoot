/*
 *  Game settings
 */
export const TICK_RATE = 60;
const DT = 1 / TICK_RATE;

export const MAP_WIDTH = 2000;
export const MAP_HEIGHT = 2000;

const PLAYER_HALF = 25;
const PLAYER_SPEED = 400;       // px/s
const MAX_HEALTH = 100;
const START_AMMO = 25;
const START_RANGE = 3;
const MAX_RANGE = 7;

const BALL_HALF = 5;
export const BALL_SPEED = 3000;        // px/s
const BALL_RANGE_UNIT = 30;     // px travelled per range point
const BALL_DAMAGE = 10;
const BALL_SUBSTEPS = 2;        // keeps fast balls from tunneling through players

const ITEM_HALF = 10;
const ITEM_SPAWN_TICKS = TICK_RATE; // one item per second
const MAX_ITEMS = 100;

const COLORS = ["#1abc9c", "#16a085", "#27ae60", "#2ecc71", "#3498db", "#9b59b6", "#34495e", "#2980b9", "#8e44ad",
    "#2c3e50", "#f1c40f", "#e67e22", "#e74c3c", "#95a5a6", "#f39c12", "#d35400", "#c0392b", "#bdc3c7", "#7f8c8d"];

/*
 *  Item types. `life` in seconds, `consume` removes the item on pickup,
 *  `apply` runs every tick while a player touches the item (dt in seconds).
 */
export const ITEM_TYPES = [
    { emoji: '🔥', life: 50, consume: false, apply: (p, dt) => { p.hp -= 100 * dt; } },
    { emoji: '💚', life: 50, consume: true,  apply: (p) => { p.hp = Math.min(MAX_HEALTH, p.hp + 20); } },
    { emoji: '💛', life: 5,  consume: false, apply: (p, dt) => { p.hp = Math.min(MAX_HEALTH, p.hp + 500 * dt); } },
    { emoji: '👋', life: 50, consume: true,  apply: (p) => { p.range = Math.min(MAX_RANGE, p.range + 1); p.statsDirty = true; } },
    { emoji: '🎾', life: 50, consume: true,  apply: (p) => { p.ammo += 10; p.statsDirty = true; } },
    { emoji: '🥎', life: 50, consume: true,  apply: (p) => { p.ammo += 10; p.statsDirty = true; } },
];

const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (v, min, max) => v < min ? min : v > max ? max : v;

export class Game {
    constructor() {
        this.tick = 0;
        this.nextId = 1;
        this.players = new Map();   // id -> player (alive and dead)
        this.items = new Map();     // id -> item
        this.balls = [];
        this.onDeath = null;
        this.resetEvents();
    }

    /*
     *  Events collected between two broadcasts, flat arrays to keep messages small
     */
    resetEvents() {
        this.events = {
            balls: [],        // x, y, angle, distance
            itemsAdded: [],   // id, type, x, y
            itemsRemoved: [], // id
            meta: [],         // id, name, color
            left: [],         // id
        };
    }

    /*
     *  Game loop
     */
    step() {
        this.tick++;
        this.movePlayers();
        this.moveBalls();
        this.updateItems();

        for (const p of this.players.values()) {
            if (p.alive && p.hp <= 0)
                this.kill(p);
        }

        if (this.tick % ITEM_SPAWN_TICKS === 0 && this.items.size < MAX_ITEMS)
            this.spawnItem();
    }

    movePlayers() {
        const d = PLAYER_SPEED * DT;
        for (const p of this.players.values()) {
            if (!p.alive || !p.walking)
                continue;
            p.x = clamp(p.x + Math.cos(p.a) * d, PLAYER_HALF, MAP_WIDTH - PLAYER_HALF);
            p.y = clamp(p.y + Math.sin(p.a) * d, PLAYER_HALF, MAP_HEIGHT - PLAYER_HALF);
        }
    }

    moveBalls() {
        const step = BALL_SPEED * DT / BALL_SUBSTEPS;
        const reach = PLAYER_HALF + BALL_HALF;
        const balls = this.balls;

        for (let i = balls.length - 1; i >= 0; i--) {
            const b = balls[i];
            let done = false;

            for (let s = 0; s < BALL_SUBSTEPS && !done; s++) {
                const d = Math.min(step, b.left);
                b.x += b.dx * d;
                b.y += b.dy * d;
                b.left -= d;

                for (const p of this.players.values()) {
                    if (p.alive && p !== b.owner && Math.abs(p.x - b.x) < reach && Math.abs(p.y - b.y) < reach) {
                        p.hp -= BALL_DAMAGE;
                        done = true;
                        break;
                    }
                }
                if (b.left <= 0)
                    done = true;
            }

            if (done) {
                // Swap-remove, order doesn't matter
                balls[i] = balls[balls.length - 1];
                balls.pop();
            }
        }
    }

    updateItems() {
        const reach = PLAYER_HALF + ITEM_HALF;
        for (const item of this.items.values()) {
            if (this.tick >= item.expires) {
                this.removeItem(item);
                continue;
            }
            const type = ITEM_TYPES[item.type];
            for (const p of this.players.values()) {
                if (!p.alive || Math.abs(p.x - item.x) >= reach || Math.abs(p.y - item.y) >= reach)
                    continue;
                type.apply(p, DT);
                if (type.consume) {
                    this.removeItem(item);
                    break;
                }
            }
        }
    }

    spawnItem() {
        const type = Math.floor(Math.random() * ITEM_TYPES.length);
        const item = {
            id: this.nextId++,
            type,
            x: Math.round(rand(60, MAP_WIDTH - 60)),
            y: Math.round(rand(60, MAP_HEIGHT - 60)),
            expires: this.tick + ITEM_TYPES[type].life * TICK_RATE,
        };
        this.items.set(item.id, item);
        this.events.itemsAdded.push(item.id, item.type, item.x, item.y);
    }

    removeItem(item) {
        this.items.delete(item.id);
        this.events.itemsRemoved.push(item.id);
    }

    /*
     *  Player functions
     */
    addPlayer() {
        const p = {
            id: this.nextId++,
            name: '',
            color: COLORS[Math.floor(Math.random() * COLORS.length)],
            x: 0, y: 0, a: 0,
            hp: 0, ammo: 0, range: 0,
            walking: false,
            alive: false,
            statsDirty: true,
        };
        this.players.set(p.id, p);
        this.spawn(p);
        return p;
    }

    spawn(p) {
        p.x = rand(125, MAP_WIDTH - 125);
        p.y = rand(125, MAP_HEIGHT - 125);
        p.hp = MAX_HEALTH;
        p.ammo = START_AMMO;
        p.range = START_RANGE;
        p.walking = false;
        p.alive = true;
        p.statsDirty = true;
        this.events.meta.push(p.id, p.name, p.color);
    }

    respawn(p) {
        if (!p.alive)
            this.spawn(p);
    }

    kill(p) {
        p.alive = false;
        p.walking = false;
        this.events.left.push(p.id);
        if (this.onDeath !== null)
            this.onDeath(p);
    }

    removePlayer(p) {
        if (p.alive)
            this.events.left.push(p.id);
        this.players.delete(p.id);
        for (const b of this.balls) {
            if (b.owner === p)
                b.owner = null;
        }
    }

    setName(p, name) {
        if (typeof name !== 'string')
            return;
        p.name = name.trim().slice(0, 16);
        if (p.alive)
            this.events.meta.push(p.id, p.name, p.color);
    }

    setWalking(p, walking) {
        p.walking = p.alive && !!walking;
    }

    setAngle(p, a) {
        if (typeof a === 'number' && Number.isFinite(a))
            p.a = a;
    }

    shoot(p) {
        if (!p.alive || p.ammo < 1)
            return;
        p.ammo--;
        p.statsDirty = true;

        const distance = (p.range + 1) * BALL_RANGE_UNIT;
        this.balls.push({
            owner: p,
            x: p.x, y: p.y,
            dx: Math.cos(p.a), dy: Math.sin(p.a),
            left: distance,
        });
        this.events.balls.push(Math.round(p.x), Math.round(p.y), Math.round(p.a * 100), distance);
    }

    /*
     *  Serialization
     */
    snapshotPlayers() {
        const out = [];
        for (const p of this.players.values()) {
            if (p.alive)
                out.push(p.id, Math.round(p.x), Math.round(p.y), Math.round(p.a * 100), Math.ceil(p.hp));
        }
        return out;
    }

    snapshotMeta() {
        const out = [];
        for (const p of this.players.values()) {
            if (p.alive)
                out.push(p.id, p.name, p.color);
        }
        return out;
    }

    snapshotItems() {
        const out = [];
        for (const item of this.items.values())
            out.push(item.id, item.type, item.x, item.y);
        return out;
    }
}
