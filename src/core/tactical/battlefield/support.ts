import type { Ref } from "../../common/ref.js";
import type { TilePosition } from "../geometry/coordinate.js";
import { hasOccupancy, type Occupancy } from "../unit/capability/occupancy/capability.js";
import { hasTileBinding, type TileBinding } from "../unit/capability/tile-binding/capability.js";
import { ref } from "../unit/query.js";
import type { Unit } from "../unit/unit.js";
import { at } from "./occupancy.js";
import type { State } from "./state.js";

export interface Relation {
    readonly tile: TilePosition;
    readonly support: Unit & Occupancy & TileBinding;
    readonly occupant: Unit & Occupancy;
}

export function of(field: State, reference: Ref<Unit>): Relation | undefined {
    const occupant = field.units.get(reference.id);

    if (occupant === undefined || !hasOccupancy(occupant)) {
        return undefined;
    }

    const registration = occupant.occupancy.registration;

    if (registration?.slot !== "OCCUPANT") {
        return undefined;
    }

    const entry = at(field, registration.tile);

    if (entry?.occupant?.id !== occupant.id || entry.support === null) {
        return undefined;
    }

    const support = field.units.get(entry.support.id);

    return support !== undefined &&
        hasOccupancy(support) &&
        hasTileBinding(support) &&
        support.definition.tileBinding.buildableType !== "NONE"
        ? { tile: registration.tile, support, occupant }
        : undefined;
}

export function all(field: State): readonly Relation[] {
    const relations: Relation[] = [];

    for (const entry of field.occupancy.values()) {
        const relation = entry.occupant === null ? undefined : of(field, entry.occupant);

        if (relation !== undefined) {
            relations.push(relation);
        }
    }

    return relations;
}

export function lost(previous: State, next: State): readonly Relation[] {
    if (previous.occupancy === next.occupancy) {
        return [];
    }

    return all(previous).filter(
        (relation) =>
            next.units.has(relation.occupant.id) &&
            of(next, ref(relation.occupant))?.support.id !== relation.support.id,
    );
}
