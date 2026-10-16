import type { Ref } from "../../../../common/ref.js";
import type { State as BattleState, Result } from "../../../battle/state.js";
import { assertNonnegativeNumber } from "../../../../common/assert.js";
import * as units from "../../query.js";
import * as hooks from "../../hook/hook.js";
import type { Unit } from "../../unit.js";
import type { Elemental, Values } from "./capability.js";
import type { Burst, End } from "./burst.js";
import type { DamageRequest, HealRequest } from "./operations.js";
import { damageRejection } from "./query.js";

export interface Receiving {
    readonly host: Ref<Unit & Elemental>;
    readonly request: DamageRequest;
}

export type DamageHook = hooks.Hook<Receiving, number>;

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

export interface Context<E> {
    readonly host: Ref<Unit & Elemental>;
    readonly event: E;
}

export type Hook<E> = hooks.Hook<Context<E>, void>;

export function receive(
    battle: BattleState,
    host: Ref<Unit & Elemental>,
    request: DamageRequest,
    amount: number,
): Result<number> {
    return hooks.dispatch<Receiving, number>(battle, { host, request }, amount, {
        candidates: (current) =>
            units.get(current, host)?.elemental.receiving.map(({ id }) => id) ?? [],
        find: (current, id) => {
            const entry = units
                .get(current, host)
                ?.elemental.receiving.find((candidate) => candidate.id === id);

            return entry === undefined
                ? undefined
                : {
                      ...entry,
                      invoke: (state, context, pending) => {
                          const result = entry.invoke(state, context, pending);
                          assertNonnegativeNumber(result.value, "pending element damage");

                          return result;
                      },
                  };
        },
        stop: (current) => damageRejection(current, host, request) !== undefined,
    });
}

export function dispatch<K extends Key>(
    battle: BattleState,
    host: Ref<Unit & Elemental>,
    key: K,
    event: Events[K],
): BattleState {
    return hooks.dispatch(battle, { host, event }, undefined, {
        candidates: (current) => units.get(current, host)?.elemental[key].map(({ id }) => id) ?? [],
        find: (current, id) => {
            const entries = units.get(current, host)?.elemental[key] as
                readonly Hook<Events[K]>[] | undefined;

            return entries?.find((entry) => entry.id === id);
        },
    }).state;
}
