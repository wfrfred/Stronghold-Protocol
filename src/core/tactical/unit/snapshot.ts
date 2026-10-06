import { createWorldPosition } from "../geometry/coordinate.js";
import type { NavigationMaps } from "../navigation/map.js";
import { copyUnitCapabilities } from "./capability/catalog.js";
import { hasLocomotion, reconcileLocomotionNavigation } from "./capability/locomotion/state.js";
import type { Unit, UnitDefinition } from "./unit.js";

export function copyUnitSnapshot<D extends UnitDefinition>(unit: Readonly<Unit<D>>): Unit<D> {
    return {
        id: unit.id,
        definition: unit.definition,
        position: Object.isFrozen(unit.position)
            ? unit.position
            : createWorldPosition(...unit.position),
        ...copyUnitCapabilities(unit),
    };
}

export function reconcileUnitNavigation<U extends Unit>(unit: U, maps: NavigationMaps): U {
    if (!hasLocomotion(unit)) {
        return unit;
    }

    const locomotion = reconcileLocomotionNavigation(unit.locomotion, maps);

    return locomotion === unit.locomotion ? unit : { ...unit, locomotion };
}
