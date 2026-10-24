import type { Ref } from "../../../common/ref.js";
import type { State as BattleState } from "../state.js";
import type { Unit } from "../../unit/unit.js";
import * as units from "../../unit/query.js";
import * as hooks from "../../unit/hook/hook.js";
import { hasBlocker } from "../../unit/capability/blocking/blocker.js";
import { hasBlockable } from "../../unit/capability/blocking/blockable.js";
import type { Relation } from "./contract.js";

export type Key = "acquired" | "released";

export interface Context<U extends Unit> {
    readonly host: Ref<U>;
    readonly relation: Relation;
}

export type Hook<U extends Unit> = hooks.Hook<Context<U>, void>;

export function dispatch(battle: BattleState, key: Key, relation: Relation): BattleState {
    battle = hooks.dispatch(battle, { host: relation.blocker, relation }, undefined, {
        candidates: (current) => {
            const host = units.get(current, relation.blocker);

            return host !== undefined && hasBlocker(host)
                ? host.blocker[key].map(({ id }) => id)
                : [];
        },
        find: (current, id) => {
            const host = units.get(current, relation.blocker);

            return host !== undefined && hasBlocker(host)
                ? host.blocker[key].find((entry) => entry.id === id)
                : undefined;
        },
    }).state;

    return hooks.dispatch(battle, { host: relation.blocked, relation }, undefined, {
        candidates: (current) => {
            const host = units.get(current, relation.blocked);

            return host !== undefined && hasBlockable(host)
                ? host.blockable[key].map(({ id }) => id)
                : [];
        },
        find: (current, id) => {
            const host = units.get(current, relation.blocked);

            return host !== undefined && hasBlockable(host)
                ? host.blockable[key].find((entry) => entry.id === id)
                : undefined;
        },
    }).state;
}
