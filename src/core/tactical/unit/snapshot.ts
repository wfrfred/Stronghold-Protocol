import type { NavigationMaps } from "../navigation/map.js";
import { copyLocomotionState, hasLocomotion, reconcileLocomotionNavigation } from "./locomotion/state.js";
import type { Unit, UnitDefinition } from "./unit.js";
import { copyVitalityState, hasVitality } from "./vitality.js";

export function copyUnitSnapshot<D extends UnitDefinition>(unit: Readonly<Unit<D>>): Unit<D> {
    const snapshot = { ...unit };
    if (hasVitality(unit)) {
        Object.assign(snapshot, { vitality: copyVitalityState(unit.vitality) });
    }
    if (hasLocomotion(unit)) {
        Object.assign(snapshot, { locomotion: copyLocomotionState(unit.locomotion) });
    }
    return snapshot;
}

export function reconcileUnitNavigation<U extends Unit>(unit: U, maps: NavigationMaps): U {
    if (!hasLocomotion(unit)) return unit;
    const locomotion = reconcileLocomotionNavigation(unit.locomotion, maps);
    return locomotion === unit.locomotion ? unit : { ...unit, locomotion };
}
