import { deriveNavigationFieldQuery } from "./field.js";
import type { NavigationField } from "./field.js";
import type { NavigationMap } from "./map.js";
import { buildNavigationField } from "./pathfinding.js";
import type { NavigationIntent } from "./request.js";

export interface NavigationFieldCache {
    get(
        map: NavigationMap,
        request: Pick<NavigationIntent, "targetTile" | "options">,
    ): NavigationField;
    invalidate(map: NavigationMap): void;
    clear(): void;
}

export function createNavigationFieldCache(): NavigationFieldCache {
    let maps = new WeakMap<NavigationMap, Map<string, NavigationField>>();
    return Object.freeze({
        get(
            map: NavigationMap,
            request: Pick<NavigationIntent, "targetTile" | "options">,
        ): NavigationField {
            const query = deriveNavigationFieldQuery(request);
            const key = `${query.targetTile[0]}:${query.targetTile[1]}:${query.allowDiagonalMove}`;
            let fields = maps.get(map);
            const cached = fields?.get(key);
            if (cached !== undefined) {
                return cached;
            }
            const field = buildNavigationField(map, query);
            if (fields === undefined) {
                fields = new Map();
                maps.set(map, fields);
            }
            fields.set(key, field);
            return field;
        },
        invalidate(map: NavigationMap): void {
            maps.delete(map);
        },
        clear(): void {
            maps = new WeakMap();
        },
    });
}
