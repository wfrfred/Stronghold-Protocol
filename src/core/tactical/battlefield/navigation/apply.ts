import { Map } from "./map.js";
import type { Overlay } from "./overlay.js";

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
