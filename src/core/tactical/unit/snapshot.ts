import { createWorldPosition } from "../geometry/coordinate.js";
import { copyUnitCapabilities } from "./capability/catalog.js";
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
