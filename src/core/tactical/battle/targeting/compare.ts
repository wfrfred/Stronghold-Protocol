import { World } from "../../geometry/coordinate.js";
import { hasVitality, resolveMaxHp } from "../../unit/capability/vitality/capability.js";
import { hasBlocker } from "../../unit/capability/blocking/blocker.js";
import { hasBlockable } from "../../unit/capability/blocking/blockable.js";
import { get } from "../../unit/query.js";
import type { Comparator } from "./contract.js";

export function combine(...comparators: readonly Comparator[]): Comparator {
    return (battle, request, left, right) => {
        for (const compare of comparators) {
            const order = compare(battle, request, left, right);

            if (order !== 0) {
                return order;
            }
        }

        return 0;
    };
}

export const distance: Comparator = (battle, request, left, right) => {
    const source = get(battle, request.source);

    return source === undefined
        ? 0
        : World.distanceSquared(source.position, left.position) -
              World.distanceSquared(source.position, right.position);
};

export const hpRatio: Comparator = (_battle, _request, left, right) => {
    const leftRatio = hasVitality(left)
        ? left.vitality.hp / resolveMaxHp(left.vitality, left.definition.vitality)
        : 1;
    const rightRatio = hasVitality(right)
        ? right.vitality.hp / resolveMaxHp(right.vitality, right.definition.vitality)
        : 1;

    return leftRatio - rightRatio;
};

export const blockedFirst: Comparator = (battle, request, left, right) => {
    const source = get(battle, request.source);

    const order = (id: number) => {
        if (source === undefined) {
            return -1;
        }
        if (hasBlockable(source) && source.blockable.blocker?.id === id) {
            return 0;
        }

        const index = hasBlocker(source)
            ? source.blocker.blocked.findIndex((ref) => ref.id === id)
            : -1;

        return index < 0 ? -1 : index + 1;
    };

    const leftOrder = order(left.id);
    const rightOrder = order(right.id);

    if (leftOrder < 0) {
        return rightOrder < 0 ? 0 : 1;
    }
    if (rightOrder < 0) {
        return -1;
    }

    return leftOrder - rightOrder;
};
