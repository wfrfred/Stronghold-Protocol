import type { Ref } from "../../../../common/ref.js";
import type { State as BattleState } from "../../../battle/state.js";
import * as units from "../../query.js";
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

export interface Hook<E> {
    readonly id: string;
    readonly enabled: (battle: BattleState, self: Unit & Skill, event: E) => boolean;
    readonly invoke: (battle: BattleState, self: Unit & Skill, event: E) => BattleState;
}

export function dispatch<K extends Key>(
    battle: BattleState,
    host: Ref<Unit & Skill>,
    key: K,
    event: Events[K],
): BattleState {
    const unit = units.get(battle, host);
    const entries = unit?.skill[key] as readonly Hook<Events[K]>[] | undefined;
    const candidates = entries?.map(({ id }) => id) ?? [];

    for (const id of candidates) {
        const current = units.get(battle, host);
        const registered = current?.skill[key] as readonly Hook<Events[K]>[] | undefined;
        const candidate = registered?.find((entry) => entry.id === id);

        if (current !== undefined && candidate?.enabled(battle, current, event)) {
            battle = candidate.invoke(battle, current, event);
        }
    }

    return battle;
}
