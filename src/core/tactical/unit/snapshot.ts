import { createWorldPosition } from "../geometry/coordinate.js";
import type { NavigationMaps } from "../navigation/map.js";
import { copyActionState, hasAction } from "./capability/action.js";
import { copyAllegianceState, hasAllegiance } from "./capability/allegiance.js";
import {
    copyBlockableState,
    copyBlockerState,
    hasBlockable,
    hasBlocker,
} from "./capability/blocking.js";
import {
    copyLocomotionState,
    hasLocomotion,
    reconcileLocomotionNavigation,
} from "./capability/locomotion/state.js";
import { copySpatialPresenceState, hasSpatialPresence } from "./capability/presence.js";
import { copyTargetableState, hasTargetable } from "./capability/targetable.js";
import type { Unit, UnitDefinition } from "./unit.js";
import { copyVitalityState, hasVitality } from "./capability/vitality.js";

export function copyUnitSnapshot<D extends UnitDefinition>(unit: Readonly<Unit<D>>): Unit<D> {
    const snapshot = {
        ...unit,
        position: Object.isFrozen(unit.position)
            ? unit.position
            : createWorldPosition(...unit.position),
    };

    if (hasVitality(unit)) {
        Object.assign(snapshot, { vitality: copyVitalityState(unit.vitality) });
    }
    if (hasLocomotion(unit)) {
        Object.assign(snapshot, { locomotion: copyLocomotionState(unit.locomotion) });
    }
    if (hasSpatialPresence(unit)) {
        Object.assign(snapshot, {
            spatialPresence: copySpatialPresenceState(unit.spatialPresence),
        });
    }
    if (hasAllegiance(unit)) {
        Object.assign(snapshot, { allegiance: copyAllegianceState(unit.allegiance) });
    }
    if (hasAction(unit)) {
        Object.assign(snapshot, { action: copyActionState(unit.action) });
    }
    if (hasTargetable(unit)) {
        Object.assign(snapshot, { targetable: copyTargetableState(unit.targetable) });
    }
    if (hasBlocker(unit)) {
        Object.assign(snapshot, { blocker: copyBlockerState(unit.blocker) });
    }
    if (hasBlockable(unit)) {
        Object.assign(snapshot, { blockable: copyBlockableState(unit.blockable) });
    }

    return snapshot;
}

export function reconcileUnitNavigation<U extends Unit>(unit: U, maps: NavigationMaps): U {
    if (!hasLocomotion(unit)) {
        return unit;
    }

    const locomotion = reconcileLocomotionNavigation(unit.locomotion, maps);

    return locomotion === unit.locomotion ? unit : { ...unit, locomotion };
}
