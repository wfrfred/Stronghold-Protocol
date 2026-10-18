import type { Unit } from "../unit/unit.js";
import type {
    BattlefieldChange,
    BattlefieldChangeResult,
    BattlefieldRuntimeOptions,
} from "./contract.js";
import type { BattlefieldMap } from "./map/map.js";
import * as maps from "./map/navigation.js";
import * as navigation from "./navigation/state.js";
import { applyBattlefieldChanges } from "./storage/changes.js";
import {
    createBattlefieldState,
    settleBattlefieldState,
    type BattlefieldState,
} from "./storage/state.js";

export interface State<U extends Unit = Unit> extends BattlefieldState<U> {
    readonly map: BattlefieldMap;
}

export interface Result<U extends Unit = Unit> {
    readonly state: State<U>;
    readonly facts: BattlefieldChangeResult<U>;
}

export function create<U extends Unit = Unit>(options: BattlefieldRuntimeOptions): State<U> {
    const state = navigation.create({
        WALK: maps.create(options.map, "WALK"),
        FLY: maps.create(options.map, "FLY"),
    });

    return {
        map: options.map,
        ...createBattlefieldState<U>(options.map, state),
    };
}

export function transition<U extends Unit>(
    previous: State<U>,
    changes: readonly BattlefieldChange<U>[],
): Result<U> {
    const applied = applyBattlefieldChanges<U>(previous, changes);
    const settled = settleBattlefieldState<U>(
        previous.map,
        previous,
        applied.content,
        applied.dependencies,
    );

    return {
        state: settled.state === previous ? previous : { map: previous.map, ...settled.state },
        facts: { ...applied.facts, ...settled.facts },
    };
}

export function setNavigation<U extends Unit>(state: State<U>, next: navigation.State): State<U> {
    return state.navigation === next ? state : { ...state, navigation: next };
}
