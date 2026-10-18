import type { TilePosition } from "../../geometry/coordinate.js";
import type { Node } from "./field.js";
import type { Map } from "./map.js";
import { canSmooth } from "./segment.js";

export function smooth(map: Map, nodes: (Node | null)[]): void {
    for (const [index, node] of nodes.entries()) {
        if (node?.next == null) {
            continue;
        }

        const from: TilePosition = [Math.floor(index / map.columns), index % map.columns];
        let next = node.next;

        for (;;) {
            const candidate = nodes[next[0] * map.columns + next[1]]!.next;

            if (candidate === null || !canSmooth(map, nodes, from, candidate)) {
                break;
            }

            next = candidate;
        }

        nodes[index] = { distance: node.distance, next };
    }
}
