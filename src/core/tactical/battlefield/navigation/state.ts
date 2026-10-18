import type { Ref } from "../../../common/ref.js";
import { Tile, World, type WorldPosition } from "../../geometry/coordinate.js";
import { effectiveMap, field } from "./cache.js";
import type { Map } from "./map.js";
import * as overlays from "./overlay.js";

export type MotionMode = "WALK" | "FLY";

export interface State {
    readonly baseline: Readonly<Record<MotionMode, Map>>;
    readonly overlays: Readonly<Record<MotionMode, readonly overlays.Overlay[]>>;
}

export function create(baseline: Readonly<Record<MotionMode, Map>>): State {
    if (
        baseline.WALK.rows !== baseline.FLY.rows ||
        baseline.WALK.columns !== baseline.FLY.columns
    ) {
        throw new RangeError("navigation map dimensions must match");
    }
    if (baseline.FLY.cells.some((cell) => cell.cost !== 1)) {
        throw new RangeError("FLY navigation costs must be 1");
    }

    return Object.freeze({
        baseline: Object.freeze({ WALK: baseline.WALK, FLY: baseline.FLY }),
        overlays: Object.freeze({ WALK: Object.freeze([]), FLY: Object.freeze([]) }),
    });
}

export function setOverlay(state: State, mode: MotionMode, overlay: overlays.Overlay): State {
    if (mode === "FLY" && overlay.cost !== undefined && overlay.cost !== 1) {
        throw new RangeError("FLY navigation overlay cost must be 1");
    }

    const stored = overlays.create(overlay);
    const entries = [...state.overlays[mode]];
    const index = entries.findIndex((entry) => entry.id === stored.id);

    if (index === -1) {
        entries.push(stored);
    } else {
        entries[index] = stored;
    }

    return Object.freeze({
        baseline: state.baseline,
        overlays: Object.freeze({ ...state.overlays, [mode]: Object.freeze(entries) }),
    });
}

export function removeOverlay(state: State, mode: MotionMode, ref: Ref<overlays.Overlay>): State {
    const entries = state.overlays[mode];
    const index = entries.findIndex((entry) => entry.id === ref.id);

    if (index === -1) {
        return state;
    }

    return Object.freeze({
        baseline: state.baseline,
        overlays: Object.freeze({
            ...state.overlays,
            [mode]: Object.freeze(entries.filter((_, entryIndex) => entryIndex !== index)),
        }),
    });
}

export function nextPoint(
    state: State,
    mode: MotionMode,
    current: WorldPosition,
    target: WorldPosition,
): WorldPosition | null {
    const map = effectiveMap(state, mode);
    const currentTile = World.toTile(current);
    const targetTile = World.toTile(target);

    if (!map.contains(currentTile) || map.get(targetTile)?.passable !== true) {
        return null;
    }

    const node = field(map, targetTile).nodes[currentTile[0] * map.columns + currentTile[1]];

    if (node === undefined || node === null) {
        return null;
    }

    const next = node.next;

    return next === null || (next[0] === targetTile[0] && next[1] === targetTile[1])
        ? target
        : Tile.center(next);
}
