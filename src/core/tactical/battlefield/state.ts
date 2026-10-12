import type { Unit } from "../unit/unit.js";
import type {
    BattlefieldChange,
    BattlefieldChangeResult,
    BattlefieldRuntimeOptions,
} from "./contract.js";
import type { BattlefieldMap } from "./map/map.js";
import type { NavigationMaps } from "./navigation/map.js";
import { projectStaticNavigationMap } from "./navigation/projection.js";
import { applyBattlefieldChanges } from "./storage/changes.js";
import {
    createBattlefieldState,
    settleBattlefieldState,
    type BattlefieldState,
} from "./storage/state.js";

export interface State<U extends Unit = Unit> extends BattlefieldState<U> {
    readonly map: BattlefieldMap;
    readonly baseline: NavigationMaps;
}

export interface Result<U extends Unit = Unit> {
    readonly state: State<U>;
    readonly facts: BattlefieldChangeResult<U>;
}

export function create<U extends Unit = Unit>(options: BattlefieldRuntimeOptions): State<U> {
    const baseline: NavigationMaps = {
        WALK: projectStaticNavigationMap(options.map, "WALK", 0),
        FLY: projectStaticNavigationMap(options.map, "FLY", 0),
    };

    return {
        map: options.map,
        baseline,
        ...createBattlefieldState<U>(options.map, baseline),
    };
}

export function transition<U extends Unit>(
    previous: State<U>,
    changes: readonly BattlefieldChange<U>[],
): Result<U> {
    const applied = applyBattlefieldChanges<U>(previous, changes);
    const settled = settleBattlefieldState<U>(
        previous.map,
        previous.baseline,
        previous,
        applied.content,
        applied.dependencies,
    );

    return {
        state:
            settled.state === previous
                ? previous
                : { map: previous.map, baseline: previous.baseline, ...settled.state },
        facts: { ...applied.facts, ...settled.facts },
    };
}
