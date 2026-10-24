import type { Ref } from "../../../common/ref.js";
import type { State as BattleState } from "../state.js";
import type { Unit } from "../../unit/unit.js";
import * as units from "../../unit/query.js";
import * as hooks from "../../unit/hook/hook.js";
import { hasBlocker } from "../../unit/capability/blocking/blocker.js";
import { hasBlockable } from "../../unit/capability/blocking/blockable.js";
import type { Relation } from "./contract.js";
import { hasRelation } from "./query.js";

export type Key = "acquired" | "released";

export interface Context<U extends Unit> {
    readonly host: Ref<U>;
    readonly relation: Relation;
}

export type Hook<U extends Unit> = hooks.Hook<Context<U>, void>;

export function dispatch(battle: BattleState, key: Key, relation: Relation): BattleState {
    const blocker = units.get(battle, relation.blocker);
    const blocked = units.get(battle, relation.blocked);
    const blockerIds =
        blocker !== undefined && hasBlocker(blocker)
            ? blocker.blocker[key].map(({ id }) => id)
            : [];
    const blockedIds =
        blocked !== undefined && hasBlockable(blocked)
            ? blocked.blockable[key].map(({ id }) => id)
            : [];
    const stop = (current: BattleState) => key === "acquired" && !hasRelation(current, relation);

    battle = hooks.dispatch(battle, { host: relation.blocker, relation }, undefined, {
        candidates: () => blockerIds,
        find: (current, id) => {
            const host = units.get(current, relation.blocker);

            return host !== undefined && hasBlocker(host)
                ? host.blocker[key].find((entry) => entry.id === id)
                : undefined;
        },
        stop,
    }).state;

    return hooks.dispatch(battle, { host: relation.blocked, relation }, undefined, {
        candidates: () => blockedIds,
        find: (current, id) => {
            const host = units.get(current, relation.blocked);

            return host !== undefined && hasBlockable(host)
                ? host.blockable[key].find((entry) => entry.id === id)
                : undefined;
        },
        stop,
    }).state;
}
