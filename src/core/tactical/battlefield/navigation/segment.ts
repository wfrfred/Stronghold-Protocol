import type { TilePosition } from "../../geometry/coordinate.js";
import { Direction } from "../../geometry/direction.js";
import type { Node } from "./field.js";
import type { Map } from "./map.js";

export function canSmooth(
    map: Map,
    nodes: readonly (Node | null)[],
    from: TilePosition,
    to: TilePosition,
): boolean {
    const steep = Math.abs(to[0] - from[0]) > Math.abs(to[1] - from[1]);
    let [x0, y0]: TilePosition = steep ? from : [from[1], from[0]];
    let [x1, y1]: TilePosition = steep ? to : [to[1], to[0]];
    const reversed = x0 > x1;

    if (reversed) {
        [x0, x1] = [x1, x0];
        [y0, y1] = [y1, y0];
    }

    const dx = x1 - x0;
    const dy = Math.abs(y1 - y0);
    const step = y0 < y1 ? 1 : -1;
    let major: Direction = steep ? "UP" : "RIGHT";
    let minor: Direction;

    if (steep) {
        minor = step > 0 ? "RIGHT" : "LEFT";
    } else {
        minor = step > 0 ? "UP" : "DOWN";
    }

    if (reversed) {
        major = Direction.opposite(major);
        minor = Direction.opposite(minor);
    }

    const position = (x: number, y: number): TilePosition => (steep ? [x, y] : [y, x]);

    const clear = (position: TilePosition): boolean => {
        const cell = map.get(position);

        return (
            cell !== undefined &&
            nodes[position[0] * map.columns + position[1]] !== null &&
            cell.passable &&
            cell.cost < 1000
        );
    };

    const allows = (position: TilePosition, direction: Direction): boolean =>
        map.get(position)?.departures[direction] === true;

    if (dy <= 1) {
        for (let row = Math.min(from[0], to[0]); row <= Math.max(from[0], to[0]); row++) {
            for (let col = Math.min(from[1], to[1]); col <= Math.max(from[1], to[1]); col++) {
                if (!clear([row, col])) {
                    return false;
                }
            }
        }
    }

    let error = -dx;
    let y = y0;

    for (let x = x0; x <= x1; x++) {
        if (!clear(position(x, y)) || !allows(position(x, y), major)) {
            return false;
        }

        error += 2 * dy;

        if (x < x1 && error >= 0) {
            if (!clear(position(x, y + step)) || !clear(position(x + 1, y))) {
                return false;
            }

            if (reversed) {
                if (
                    !allows(position(x + 1, y + step), minor) ||
                    !allows(position(x, y + step), minor) ||
                    !allows(position(x + 1, y), major)
                ) {
                    return false;
                }
            } else if (
                !allows(position(x, y), minor) ||
                !allows(position(x + 1, y), minor) ||
                !allows(position(x, y + step), major)
            ) {
                return false;
            }

            y += step;
            error -= 2 * dx;
        }
    }

    return true;
}
