import { assertNonnegativeSafeInteger } from "../../common/assert.js";
import type { Ref } from "../../common/ref.js";
import type { Unit, Id } from "../unit/unit.js";
import type { BattlefieldRuntimeOptions } from "./contract.js";
import type { BattlefieldMap } from "./map/map.js";
import * as maps from "./map/navigation.js";
import * as navigation from "./navigation/state.js";
import { createBattlefieldState, maintain, type BattlefieldState } from "./storage/state.js";

export interface State<U extends Unit = Unit> extends BattlefieldState<U> {
    readonly map: BattlefieldMap;
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

function requireEntry<K extends number, V>(entries: ReadonlyMap<K, V>, key: K, name: string): V {
    const value = entries.get(key);

    if (value === undefined) {
        throw new RangeError(`unknown ${name}: ${key}`);
    }

    return value;
}

export function addUnit<U extends Unit>(state: State<U>, unit: U): State<U> {
    return addUnits(state, [unit]);
}

export function addUnits<U extends Unit>(state: State<U>, incoming: readonly U[]): State<U> {
    if (incoming.length === 0) {
        return state;
    }

    const units = new Map(state.units);
    const updatedUnitIds = new Set<Id>();

    for (const unit of incoming) {
        assertNonnegativeSafeInteger(unit.id, "unit id");

        if (units.has(unit.id)) {
            throw new RangeError(`duplicate unit: ${unit.id}`);
        }

        units.set(unit.id, unit);
        updatedUnitIds.add(unit.id);
    }

    return maintain(
        state,
        { ...state, units },
        {
            updatedUnitIds,
            unitOrderChanged: true,
        },
    );
}

export function replaceUnit<U extends Unit>(state: State<U>, unit: U): State<U> {
    return replaceUnits(state, [unit]);
}

export function replaceUnits<U extends Unit>(state: State<U>, incoming: readonly U[]): State<U> {
    let units: Map<Id, U> | undefined;
    const updatedUnitIds = new Set<Id>();

    for (const unit of incoming) {
        const previous = requireEntry(units ?? state.units, unit.id, "unit");

        if (previous.definition !== unit.definition) {
            throw new RangeError("unit definition cannot change during update");
        }

        if (previous !== unit) {
            units ??= new Map(state.units);
            units.set(unit.id, unit);
            updatedUnitIds.add(unit.id);
        }
    }

    return units === undefined
        ? state
        : maintain(
              state,
              { ...state, units },
              {
                  updatedUnitIds,
                  unitOrderChanged: false,
              },
          );
}

export function removeUnit<U extends Unit>(state: State<U>, reference: Ref<Unit>): State<U> {
    requireEntry(state.units, reference.id, "unit");
    const units = new Map(state.units);
    units.delete(reference.id);

    return maintain(
        state,
        { ...state, units },
        {
            updatedUnitIds: new Set([reference.id]),
            unitOrderChanged: true,
        },
    );
}

export function setNavigation<U extends Unit>(state: State<U>, next: navigation.State): State<U> {
    return state.navigation === next ? state : { ...state, navigation: next };
}
