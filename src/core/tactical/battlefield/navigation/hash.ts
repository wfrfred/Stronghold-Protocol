import { DIRECTIONS } from "../../geometry/direction.js";
import type { NavigationCell, NavigationMap, PathMotionMode } from "./map.js";

const UINT32_RANGE = 0x1_0000_0000;
const SEED = 0x6a09_e667;
const POSITION_SEED = 0xbb67_ae85;
const LOW_WORD_SEED = 0x3c6e_f372;
const HIGH_WORD_SEED = 0xa54f_f53a;

function mix(value: number): number {
    let mixed = Math.imul(value ^ (value >>> 16), 0x7feb_352d);

    mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846c_a68b);

    return (mixed ^ (mixed >>> 16)) >>> 0;
}

const ROWS = mix(SEED);
const COLUMNS = mix(SEED + 1);
const MOTION_MODE = mix(SEED + 2);
const PASSABLE = mix(SEED + 3);
const MOVE_COST = mix(SEED + 4);
const DEPARTURES = {
    UP: mix(SEED + 5),
    RIGHT: mix(SEED + 6),
    DOWN: mix(SEED + 7),
    LEFT: mix(SEED + 8),
};

/** Encode both words of a safe integer, with distinct position/field/word domains. */
function integerKey(value: number, domain: number): number {
    const low = value >>> 0;
    const high = Math.floor(value / UINT32_RANGE);

    return mix(domain ^ mix(low ^ LOW_WORD_SEED) ^ mix(high ^ HIGH_WORD_SEED));
}

function cellSeed(index: number): number {
    return integerKey(index, POSITION_SEED);
}

function key(position: number, field: number, value: number | boolean): number {
    return mix(position ^ integerKey(Number(value), field));
}

/** Fixed Zobrist keys depend on each position, field and full safe-integer value. */
export function createNavigationContentHash(
    rows: number,
    columns: number,
    pathMotionMode: PathMotionMode,
    cells: readonly NavigationCell[],
): number {
    let hash =
        integerKey(rows, ROWS) ^
        integerKey(columns, COLUMNS) ^
        integerKey(Number(pathMotionMode === "FLY"), MOTION_MODE);

    for (let index = 0; index < cells.length; index++) {
        const cell = cells[index]!;
        const position = cellSeed(index);

        hash ^= key(position, PASSABLE, cell.passable) ^ key(position, MOVE_COST, cell.moveCost);

        for (const direction of DIRECTIONS) {
            hash ^= key(position, DEPARTURES[direction], cell.departures[direction]);
        }
    }

    return hash >>> 0;
}

/** Null means no final cell changed; modifier operations do not enter the hash. */
export function updateNavigationContentHash(
    previous: NavigationMap,
    cells: readonly NavigationCell[],
): number | null {
    let hash = previous.contentHash;
    let changed = false;

    for (let index = 0; index < cells.length; index++) {
        const before = previous.cells[index]!;
        const after = cells[index]!;

        if (before === after) {
            continue;
        }

        const position = cellSeed(index);

        if (before.passable !== after.passable) {
            hash ^=
                key(position, PASSABLE, before.passable) ^ key(position, PASSABLE, after.passable);
            changed = true;
        }

        if (before.moveCost !== after.moveCost) {
            hash ^=
                key(position, MOVE_COST, before.moveCost) ^
                key(position, MOVE_COST, after.moveCost);
            changed = true;
        }

        for (const direction of DIRECTIONS) {
            if (before.departures[direction] !== after.departures[direction]) {
                const field = DEPARTURES[direction];

                hash ^=
                    key(position, field, before.departures[direction]) ^
                    key(position, field, after.departures[direction]);
                changed = true;
            }
        }
    }

    return changed ? hash >>> 0 : null;
}
