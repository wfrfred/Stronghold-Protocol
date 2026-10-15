import type { Ref } from "../../../../common/ref.js";
import type { State as BattleState } from "../../../battle/state.js";
import * as units from "../../query.js";
import type { Unit } from "../../unit.js";
import type { Activation, End } from "./activation.js";
import type { Consumed, Replenished } from "./ammo.js";
import type { Skill } from "./capability.js";
import type { Recovered, Paid, Modified } from "./sp.js";

export interface Events<S extends object, A extends object> {
    readonly spRecovered: Recovered;
    readonly spPaid: Paid;
    readonly spModified: Modified;
    readonly ammoConsumed: Consumed<S, A>;
    readonly ammoReplenished: Replenished<S, A>;
    readonly activated: Activation<S, A>;
    readonly ended: { readonly activation: Activation<S, A>; readonly end: End };
}

export type Key = keyof Events<object, object>;

export interface Hook<S extends object, A extends object, E> {
    readonly id: string;
    readonly enabled: (battle: BattleState, self: Unit & Skill<S, A>, event: E) => boolean;
    readonly invoke: (battle: BattleState, self: Unit & Skill<S, A>, event: E) => BattleState;
}

export function dispatch<S extends object, A extends object, K extends Key>(
    battle: BattleState,
    host: Ref<Unit & Skill<S, A>>,
    key: K,
    event: Events<S, A>[K],
): BattleState {
    const unit = units.get(battle, host);
    const entries = unit?.skill[key] as readonly Hook<S, A, Events<S, A>[K]>[] | undefined;
    const candidates = entries?.map(({ id }) => id) ?? [];

    for (const id of candidates) {
        const current = units.get(battle, host);
        const registered = current?.skill[key] as
            readonly Hook<S, A, Events<S, A>[K]>[] | undefined;
        const candidate = registered?.find((entry) => entry.id === id);

        if (current !== undefined && candidate?.enabled(battle, current, event)) {
            battle = candidate.invoke(battle, current, event);
        }
    }

    return battle;
}
