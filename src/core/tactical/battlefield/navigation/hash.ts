import { DIRECTIONS } from "../../geometry/direction.js";
import type { Map } from "./map.js";

export type Hash = number;

function append(hash: number, value: number): number {
    const low = value >>> 0;
    const high = Math.floor(value / 0x1_0000_0000);

    return Math.imul(Math.imul(hash ^ low, 0x0100_0193) ^ high, 0x0100_0193);
}

export function hash(map: Map): Hash {
    let result = append(append(0x811c_9dc5, map.rows), map.columns);

    for (const cell of map.cells) {
        result = append(append(result, Number(cell.passable)), cell.cost);

        for (const direction of DIRECTIONS) {
            result = append(result, Number(cell.departures[direction]));
        }
    }

    return result >>> 0;
}
