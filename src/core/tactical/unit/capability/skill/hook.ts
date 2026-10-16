import type { Ref } from "../../../../common/ref.js";
import type { State as BattleState } from "../../../battle/state.js";
import * as units from "../../query.js";
import * as hooks from "../../hook/hook.js";
import type { Unit } from "../../unit.js";
import type { Activation, End } from "./activation.js";
import type { Consumed, Replenished } from "./ammo.js";
import type { Skill } from "./capability.js";
import type { Recovered, Paid, Modified } from "./sp.js";

export interface Events {
    readonly spRecovered: Recovered;
    readonly spPaid: Paid;
    readonly spModified: Modified;
    readonly ammoConsumed: Consumed;
    readonly ammoReplenished: Replenished;
    readonly activated: Activation;
    readonly ended: { readonly activation: Activation; readonly end: End };
}

export type Key = keyof Events;

export interface Context<E> {
    readonly host: Ref<Unit & Skill>;
    readonly event: E;
}

export type Hook<E> = hooks.Hook<Context<E>, void>;

export function dispatch<K extends Key>(
    battle: BattleState,
    host: Ref<Unit & Skill>,
    key: K,
    event: Events[K],
): BattleState {
    return hooks.dispatch(battle, { host, event }, undefined, {
        candidates: (current) => units.get(current, host)?.skill[key].map(({ id }) => id) ?? [],
        find: (current, id) => {
            const entries = units.get(current, host)?.skill[key] as
                readonly Hook<Events[K]>[] | undefined;

            return entries?.find((entry) => entry.id === id);
        },
    }).state;
}
