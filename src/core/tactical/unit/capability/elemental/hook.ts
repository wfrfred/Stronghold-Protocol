import type { Ref } from "../../../../common/ref.js";
import type { State as BattleState, Result } from "../../../battle/state.js";
import { assertNonnegativeNumber } from "../../../../common/assert.js";
import * as units from "../../query.js";
import type { Unit } from "../../unit.js";
import type { Elemental, Values } from "./capability.js";
import type { Burst, End } from "./burst.js";
import type { DamageRequest, HealRequest } from "./operations.js";
import { damageRejection } from "./query.js";

export interface Receiving {
    readonly request: DamageRequest;
    readonly amount: number;
}

export interface DamageHook {
    readonly id: string;
    readonly enabled: (battle: BattleState, self: Unit & Elemental, event: Receiving) => boolean;
    readonly invoke: (
        battle: BattleState,
        self: Unit & Elemental,
        event: Receiving,
    ) => Result<number>;
}

export interface Damaged {
    readonly request: DamageRequest;
    readonly previous: number;
    readonly current: number;
    readonly amount: number;
    readonly burst: Ref<Burst> | null;
}

export interface Healed {
    readonly request: HealRequest;
    readonly previous: Values;
    readonly current: Values;
    readonly amounts: Values;
}

export interface Events {
    readonly received: { readonly request: DamageRequest };
    readonly damaged: Damaged;
    readonly healed: Healed;
    readonly burstStarted: Burst;
    readonly burstEnded: { readonly burst: Burst; readonly end: End };
}

export type Key = keyof Events;

export interface Hook<E> {
    readonly id: string;
    readonly enabled: (battle: BattleState, self: Unit & Elemental, event: E) => boolean;
    readonly invoke: (battle: BattleState, self: Unit & Elemental, event: E) => BattleState;
}

export function receive(
    battle: BattleState,
    host: Ref<Unit & Elemental>,
    event: Receiving,
): Result<number> {
    const candidates = units.get(battle, host)?.elemental.receiving.map(({ id }) => id) ?? [];
    let amount = event.amount;

    for (const id of candidates) {
        if (damageRejection(battle, host, event.request) !== undefined) {
            break;
        }

        const current = units.get(battle, host)!;
        const entry = current.elemental.receiving.find((candidate) => candidate.id === id);
        const pending = { request: event.request, amount };

        if (entry?.enabled(battle, current, pending)) {
            const result = entry.invoke(battle, current, pending);
            assertNonnegativeNumber(result.value, "pending element damage");
            battle = result.state;
            amount = result.value;
        }
    }

    return { state: battle, value: amount };
}

export function dispatch<K extends Key>(
    battle: BattleState,
    host: Ref<Unit & Elemental>,
    key: K,
    event: Events[K],
): BattleState {
    const initial = units.get(battle, host)?.elemental[key] as
        readonly Hook<Events[K]>[] | undefined;
    const candidates = initial?.map(({ id }) => id) ?? [];

    for (const id of candidates) {
        const current = units.get(battle, host);
        const entries = current?.elemental[key] as readonly Hook<Events[K]>[] | undefined;
        const entry = entries?.find((candidate) => candidate.id === id);

        if (current !== undefined && entry?.enabled(battle, current, event)) {
            battle = entry.invoke(battle, current, event);
        }
    }

    return battle;
}
