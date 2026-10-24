import { Projectiles } from "../projectile/projectiles.js";
import type { State as NavigationState } from "../navigation/state.js";
import type { Unit, Id } from "../../unit/unit.js";
import type { State as FieldState } from "../state.js";
import { deriveOccupancy } from "./indexes.js";
import type { TileOccupancy } from "../occupancy.js";

export interface BattlefieldContent<U extends Unit> {
    readonly projectiles: Projectiles;
    readonly units: ReadonlyMap<Id, U>;
}

export interface BattlefieldState<U extends Unit> extends BattlefieldContent<U> {
    readonly navigation: NavigationState;
    readonly occupancy: ReadonlyMap<number, TileOccupancy>;
}

export function createBattlefieldState<U extends Unit>(
    navigation: NavigationState,
): BattlefieldState<U> {
    const units = new Map<Id, U>();

    return {
        units,
        projectiles: Projectiles.empty(),
        occupancy: new Map(),
        navigation,
    };
}

function finishSettlement<U extends Unit>(
    previous: FieldState<U>,
    content: BattlefieldContent<U>,
    occupancy: ReadonlyMap<number, TileOccupancy>,
): FieldState<U> {
    const unchanged =
        content.units === previous.units &&
        content.projectiles === previous.projectiles &&
        occupancy === previous.occupancy;

    return unchanged ? previous : { ...previous, ...content, occupancy };
}

function changedUnitIds<U extends Unit>(
    previous: ReadonlyMap<Id, U>,
    next: ReadonlyMap<Id, U>,
): ReadonlySet<Id> {
    const changed = new Set<Id>();

    if (previous !== next) {
        for (const [id, unit] of previous) {
            if (next.get(id) !== unit) {
                changed.add(id);
            }
        }
        for (const id of next.keys()) {
            if (!previous.has(id)) {
                changed.add(id);
            }
        }
    }

    return changed;
}

export function maintain<U extends Unit>(
    previous: FieldState<U>,
    content: BattlefieldContent<U>,
    updatedUnitIds: ReadonlySet<Id> = changedUnitIds(previous.units, content.units),
): FieldState<U> {
    return finishSettlement(
        previous,
        content,
        deriveOccupancy(
            previous.map,
            previous.units,
            content.units,
            previous.occupancy,
            updatedUnitIds,
        ),
    );
}
