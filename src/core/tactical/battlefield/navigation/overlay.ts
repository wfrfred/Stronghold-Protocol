import { assertNonnegativeSafeInteger, assertPositiveSafeInteger } from "../../../common/assert.js";
import type { Identified } from "../../../common/ref.js";
import { createTilePosition, type TilePosition } from "../../geometry/coordinate.js";
import type { Direction } from "../../geometry/direction.js";

export type Id = number;

export interface Overlay extends Identified<{ readonly id: Id }> {
    readonly id: Id;
    readonly cells: readonly TilePosition[];
    readonly denyPassage: boolean;
    readonly denyDepartures: readonly Direction[];
    readonly cost?: number;
}

export function create(input: Overlay): Overlay {
    assertNonnegativeSafeInteger(input.id, "navigation overlay id");

    if (input.cost !== undefined) {
        assertPositiveSafeInteger(input.cost, "navigation overlay cost");
    }

    return Object.freeze({
        id: input.id,
        cells: Object.freeze(
            input.cells.map((position) => createTilePosition(position[0], position[1])),
        ),
        denyPassage: input.denyPassage,
        denyDepartures: Object.freeze([...input.denyDepartures]),
        ...(input.cost === undefined ? {} : { cost: input.cost }),
    });
}
