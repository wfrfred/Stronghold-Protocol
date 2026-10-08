import { Tile, type TilePosition } from "../../geometry/coordinate.js";
import type { NavigationField, NavigationFieldNode } from "./field.js";
import { NavigationMap } from "./map.js";
import { navigationSegmentCost } from "./segment.js";

const WALK_SHORTCUT_COST_LIMIT = 1000;

export function smoothNavigationField(field: NavigationField): NavigationField {
    const nodes: NavigationFieldNode[] = field.nodes.slice();

    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index]!;

        if (node.type !== "REACHABLE") {
            continue;
        }

        const from: TilePosition = [
            Math.floor(index / field.map.columns),
            index % field.map.columns,
        ];
        let next = node.rawNext;

        for (;;) {
            const cursor = field.nodes[next[0] * field.map.columns + next[1]]!;

            if (cursor.type !== "REACHABLE") {
                break;
            }

            const candidate = cursor.rawNext;

            if (
                !field.query.allowDiagonalMove &&
                from[0] !== candidate[0] &&
                from[1] !== candidate[1]
            ) {
                break;
            }

            const cost = navigationSegmentCost(
                field.map,
                Tile.center(from),
                Tile.center(candidate),
                (cell) =>
                    field.map.pathMotionMode === "FLY" || cell.moveCost < WALK_SHORTCUT_COST_LIMIT,
            );
            const destination = field.nodes[candidate[0] * field.map.columns + candidate[1]]!;

            if (destination.type === "UNREACHABLE") {
                break;
            }

            const sourceCost = NavigationMap.get(field.map, from)!.moveCost;
            const destinationCost = NavigationMap.get(field.map, candidate)!.moveCost;
            const budget =
                node.distance - destination.distance + (destinationCost - sourceCost) / 2;

            if (cost === null || cost > budget + Number.EPSILON * Math.max(1, budget)) {
                break;
            }

            next = candidate;
        }

        nodes[index] = Object.freeze({ ...node, next });
    }

    return Object.freeze({ map: field.map, query: field.query, nodes: Object.freeze(nodes) });
}
