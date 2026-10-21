import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import { topK } from "../../../common/collection.js";
import { createRng } from "../../../common/rng.js";
import { ref } from "../../unit/query.js";
import type { Comparator, Selector } from "./contract.js";

export function first(k: number, compare: Comparator): Selector {
    assertNonnegativeSafeInteger(k, "k");

    return (battle, request, candidates) => ({
        state: battle,
        value: topK(candidates, k, (left, right) => compare(battle, request, left, right)).map(ref),
    });
}

export function random(k: number): Selector {
    assertNonnegativeSafeInteger(k, "k");

    return (battle, _request, candidates) => {
        const count = Math.min(k, candidates.length);

        if (count === 0) {
            return { state: battle, value: [] };
        }

        const rng = createRng(battle.execution.rngState);
        const pool = [...candidates];

        for (let index = 0; index < count; index++) {
            const selected = index + rng.int(pool.length - index);

            [pool[index], pool[selected]] = [pool[selected]!, pool[index]!];
        }

        return {
            state: {
                ...battle,
                execution: { ...battle.execution, rngState: rng.state() },
            },
            value: pool.slice(0, count).map(ref),
        };
    };
}
