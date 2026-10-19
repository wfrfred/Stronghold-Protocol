import { assertNonnegativeSafeInteger, assertPositiveSafeInteger } from "../../../common/assert.js";
import type { Identified } from "../../../common/ref.js";
import { createTilePosition, type TilePosition } from "../../geometry/coordinate.js";
import type { Direction } from "../../geometry/direction.js";
import { Map } from "./map.js";

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

export function apply(base: Map, overlays: readonly Overlay[]): Map {
    const cells = base.cells.slice();
    let changed = false;

    for (const overlay of overlays) {
        for (const position of overlay.cells) {
            if (!base.contains(position)) {
                continue;
            }

            const index = position[0] * base.columns + position[1];
            const cell = cells[index]!;
            let departures = cell.departures;

            for (const direction of overlay.denyDepartures) {
                if (departures[direction]) {
                    departures = { ...departures, [direction]: false };
                }
            }

            const passable = cell.passable && !overlay.denyPassage;
            const cost = Math.max(cell.cost, overlay.cost ?? 1);

            if (
                passable !== cell.passable ||
                cost !== cell.cost ||
                departures !== cell.departures
            ) {
                cells[index] = { passable, cost, departures };
                changed = true;
            }
        }
    }

    return changed ? new Map(base.rows, base.columns, cells) : base;
}
