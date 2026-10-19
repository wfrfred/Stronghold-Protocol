import type { TilePosition } from "../../geometry/coordinate.js";
import { build, type Field } from "./field.js";
import type { Map as NavigationMap } from "./map.js";
import { apply } from "./overlay.js";
import type { MotionMode, State } from "./state.js";

const maps = new WeakMap<State, Partial<Record<MotionMode, NavigationMap>>>();
const fields = new WeakMap<NavigationMap, Map<string, Field>>();

export function effectiveMap(state: State, mode: MotionMode): NavigationMap {
    let modes = maps.get(state);
    const cached = modes?.[mode];

    if (cached !== undefined) {
        return cached;
    }

    const map = apply(state.baseline[mode], state.overlays[mode]);

    if (modes === undefined) {
        modes = {};
        maps.set(state, modes);
    }

    modes[mode] = map;

    return map;
}

export function field(map: NavigationMap, target: TilePosition): Field {
    let targets = fields.get(map);
    const key = `${target[0]}:${target[1]}`;
    const cached = targets?.get(key);

    if (cached !== undefined) {
        return cached;
    }

    const result = build(map, target);

    if (targets === undefined) {
        targets = new Map();
        fields.set(map, targets);
    }

    targets.set(key, result);

    return result;
}
