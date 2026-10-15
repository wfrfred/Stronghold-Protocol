import {
    assertNonnegativeSafeInteger,
    assertPositiveNumber,
    assertSafeInteger,
} from "../../../../common/assert.js";
import type { Ref } from "../../../../common/ref.js";
import type { Result, State as BattleState } from "../../../battle/state.js";
import { TICKS_PER_SECOND } from "../../../tick.js";
import type { Unit } from "../../unit.js";
import * as units from "../../query.js";
import * as contribution from "../../contribution/contribution.js";
import * as modifier from "../../contribution/value.js";
import { hasVitality } from "../vitality/capability.js";
import type { Skill, Stored } from "./capability.js";
import type { Input } from "./input.js";
import * as query from "./query.js";
import { dispatch } from "./hook.js";

export type Source = "TIME" | "ACTION" | "HIT" | "EXTERNAL";

export type Recovery =
    | { readonly type: "TIME"; readonly intervalTicks: number }
    | { readonly type: "ACTION" | "HIT"; readonly amount: number }
    | { readonly type: "NONE" };

export interface Definition {
    readonly initial: number;
    readonly capacity: number;
    readonly requirement: number;
    readonly cost?: number;
    readonly recovery: Recovery;
}

export interface Timer {
    readonly periodTicks: number;
    readonly remainingTicks: number;
}

export interface State<S extends object = object, A extends object = object> {
    readonly value: number;
    readonly recovery: Timer | null;
    readonly lastTick: number;
    readonly capacity: readonly contribution.Contribution<Input<S, A>>[];
    readonly requirement: readonly contribution.Contribution<Input<S, A>>[];
    readonly cost: readonly contribution.Contribution<Input<S, A>>[];
    readonly recoverySpeed: readonly contribution.Contribution<Input<S, A>>[];
    readonly recoveryMultiplier: readonly contribution.Contribution<Input<S, A>>[];
}

export interface Recovered {
    readonly source: Source;
    readonly amount: number;
    readonly previous: number;
    readonly current: number;
}

export interface Paid {
    readonly amount: number;
    readonly previous: number;
    readonly current: number;
}

export interface Modified {
    readonly delta: number;
    readonly amount: number;
    readonly forced: boolean;
    readonly previous: number;
    readonly current: number;
}

export type Outcome =
    | { readonly type: "APPLIED"; readonly amount: number }
    | {
          readonly type: "REJECTED";
          readonly reason:
              "UNAVAILABLE" | "NO_SP" | "RULE" | "WRONG_SOURCE" | "FULL" | "INSUFFICIENT_SP";
      };

export type Parameter =
    "capacity" | "requirement" | "cost" | "recoverySpeed" | "recoveryMultiplier";

export function setContribution<S extends object, A extends object>(
    state: State<S, A>,
    key: Parameter,
    entry: contribution.Contribution<Input<S, A>>,
): State<S, A> {
    const updated = contribution.set(state[key], entry);

    return updated === state[key] ? state : { ...state, [key]: updated };
}

export function removeContribution<S extends object, A extends object>(
    state: State<S, A>,
    key: Parameter,
    id: string,
): State<S, A> {
    const updated = contribution.remove(state[key], id);

    return updated === state[key] ? state : { ...state, [key]: updated };
}

export function validateDefinition(definition: Definition): void {
    assertNonnegativeSafeInteger(definition.initial, "skill initial SP");
    assertNonnegativeSafeInteger(definition.capacity, "skill SP capacity");
    assertNonnegativeSafeInteger(definition.requirement, "skill SP requirement");

    if (definition.cost !== undefined) {
        assertNonnegativeSafeInteger(definition.cost, "skill SP cost");
    }
    if (definition.initial > definition.capacity) {
        throw new RangeError("skill initial SP exceeds capacity");
    }

    const recovery = definition.recovery;

    if (recovery.type === "TIME") {
        assertPositiveNumber(recovery.intervalTicks, "skill SP recovery interval");
    } else if (recovery.type !== "NONE") {
        assertNonnegativeSafeInteger(recovery.amount, "skill SP recovery amount");
    }
}

export function initialize<S extends object = object, A extends object = object>(
    definition: Definition,
    tick = 0,
): State<S, A> {
    validateDefinition(definition);
    assertNonnegativeSafeInteger(tick, "skill SP initialization tick");

    return {
        value: definition.initial,
        recovery:
            definition.recovery.type === "TIME"
                ? {
                      periodTicks: definition.recovery.intervalTicks,
                      remainingTicks: definition.recovery.intervalTicks,
                  }
                : null,
        lastTick: tick,
        capacity: [],
        requirement: [],
        cost: [],
        recoverySpeed: [],
        recoveryMultiplier: [],
    };
}

export function resolveCapacity(battle: BattleState, ref: Ref<Unit & Stored>): number | undefined {
    return query.read(battle, ref, (self) => resolve(battle, self, "capacity"));
}
export function resolveRequirement(
    battle: BattleState,
    ref: Ref<Unit & Stored>,
): number | undefined {
    return query.read(battle, ref, (self) => resolve(battle, self, "requirement"));
}
export function resolveCost(battle: BattleState, ref: Ref<Unit & Stored>): number | undefined {
    return query.read(battle, ref, (self) => resolve(battle, self, "cost"));
}
export function resolveRecoverySpeed(
    battle: BattleState,
    ref: Ref<Unit & Stored>,
): number | undefined {
    return query.read(battle, ref, (self) => resolve(battle, self, "recoverySpeed"));
}
export function resolveRecoveryMultiplier(
    battle: BattleState,
    ref: Ref<Unit & Stored>,
): number | undefined {
    return query.read(battle, ref, (self) => resolve(battle, self, "recoveryMultiplier"));
}

export function recover(
    battle: BattleState,
    ref: Ref<Unit & Stored>,
    source: Source,
    amount?: number,
): Result<Outcome> {
    if (amount !== undefined) {
        assertNonnegativeSafeInteger(amount, "skill SP recovery amount");
    }

    return (
        query.read(battle, ref, (self): Result<Outcome> => {
            if (!available(self)) {
                return rejected(battle, "UNAVAILABLE");
            }

            const state = self.skill.sp;
            const definition = self.definition.skill.sp;

            if (state === null || definition === null) {
                return rejected(battle, "NO_SP");
            }
            if (source !== "EXTERNAL" && definition.recovery.type !== source) {
                return rejected(battle, "WRONG_SOURCE");
            }
            if (!allowsRecovery(battle, self, source)) {
                return rejected(battle, "RULE");
            }

            const requested =
                amount ??
                ((source === "ACTION" || source === "HIT") && definition.recovery.type === source
                    ? definition.recovery.amount
                    : 1);
            const capacity = resolve(battle, self, "capacity")!;
            const gained = Math.min(requested, Math.max(0, capacity - state.value));

            if (gained === 0 && requested !== 0) {
                return rejected(battle, "FULL");
            }
            if (gained === 0) {
                return applied(battle, 0);
            }

            const event: Recovered = {
                source,
                amount: gained,
                previous: state.value,
                current: state.value + gained,
            };
            battle = query.replace(battle, {
                ...self,
                skill: { ...self.skill, sp: { ...state, value: event.current } },
            });

            return applied(dispatch(battle, units.ref(self), "spRecovered", event), gained);
        }) ?? rejected(battle, "UNAVAILABLE")
    );
}

export function pay(
    battle: BattleState,
    ref: Ref<Unit & Stored>,
    amount?: number,
): Result<Outcome> {
    if (amount !== undefined) {
        assertNonnegativeSafeInteger(amount, "skill SP payment amount");
    }

    return (
        query.read(battle, ref, (self): Result<Outcome> => {
            if (!available(self)) {
                return rejected(battle, "UNAVAILABLE");
            }

            const state = self.skill.sp;

            if (state === null || self.definition.skill.sp === null) {
                return rejected(battle, "NO_SP");
            }

            const cost = amount ?? resolve(battle, self, "cost")!;

            if (state.value < cost) {
                return rejected(battle, "INSUFFICIENT_SP");
            }

            const event: Paid = {
                amount: cost,
                previous: state.value,
                current: state.value - cost,
            };
            battle = query.replace(battle, {
                ...self,
                skill: { ...self.skill, sp: { ...state, value: event.current } },
            });

            return applied(dispatch(battle, units.ref(self), "spPaid", event), cost);
        }) ?? rejected(battle, "UNAVAILABLE")
    );
}

export function modify(
    battle: BattleState,
    ref: Ref<Unit & Stored>,
    delta: number,
    forced = false,
): Result<Outcome> {
    assertSafeInteger(delta, "skill SP modification");

    return (
        query.read(battle, ref, (self): Result<Outcome> => {
            if (!available(self)) {
                return rejected(battle, "UNAVAILABLE");
            }

            const state = self.skill.sp;

            if (state === null || self.definition.skill.sp === null) {
                return rejected(battle, "NO_SP");
            }
            if (delta > 0 && !forced && !allowsRecovery(battle, self, "EXTERNAL")) {
                return rejected(battle, "RULE");
            }

            const current = Math.min(
                resolve(battle, self, "capacity")!,
                Math.max(0, state.value + delta),
            );
            const amount = current - state.value;

            if (amount === 0) {
                return applied(battle, 0);
            }

            const event: Modified = { delta, amount, forced, previous: state.value, current };
            battle = query.replace(battle, {
                ...self,
                skill: { ...self.skill, sp: { ...state, value: current } },
            });

            return applied(dispatch(battle, units.ref(self), "spModified", event), amount);
        }) ?? rejected(battle, "UNAVAILABLE")
    );
}

export function advance(battle: BattleState, ref: Ref<Unit & Stored>): BattleState {
    const advanced = query.read(battle, ref, (self) => {
        if (!available(self) || self.skill.sp === null) {
            return { state: battle, pulses: 0 };
        }

        const state = self.skill.sp;
        const definition = self.definition.skill.sp;

        if (battle.tick < state.lastTick) {
            throw new RangeError("skill SP cannot advance to an earlier tick");
        }

        const rate =
            resolve(battle, self, "recoverySpeed")! * resolve(battle, self, "recoveryMultiplier")!;
        let recovery: Timer | null = null;
        let pulses = 0;

        if (definition?.recovery.type === "TIME" && rate > 0) {
            const periodTicks = TICKS_PER_SECOND / rate;
            assertPositiveNumber(periodTicks, "skill effective SP recovery interval");
            const previous = state.recovery;
            let remainingTicks =
                previous === null
                    ? periodTicks
                    : Math.max(0, periodTicks - (previous.periodTicks - previous.remainingTicks));

            const capacity = resolve(battle, self, "capacity")!;

            if (
                previous !== null &&
                state.value < capacity &&
                allowsRecovery(battle, self, "TIME")
            ) {
                remainingTicks -= battle.tick - state.lastTick;

                if (remainingTicks <= 1e-8) {
                    const available = Math.floor((-remainingTicks + 1e-8) / periodTicks) + 1;
                    const capacityRemaining = capacity - state.value;
                    pulses = Math.min(available, capacityRemaining);
                    assertNonnegativeSafeInteger(pulses, "skill SP recovery pulses");
                    remainingTicks =
                        pulses === capacityRemaining
                            ? periodTicks
                            : Math.max(0, remainingTicks + pulses * periodTicks);
                }
            }

            recovery = { periodTicks, remainingTicks };
        }

        const next = { ...state, recovery, lastTick: battle.tick };

        return {
            state: query.replace(battle, { ...self, skill: { ...self.skill, sp: next } }),
            pulses,
        };
    });

    if (advanced === undefined) {
        return battle;
    }

    return advanced.pulses === 0
        ? advanced.state
        : recover(advanced.state, ref, "TIME", advanced.pulses).state;
}

function resolve<S extends object, A extends object>(
    battle: BattleState,
    self: Unit & Skill<S, A>,
    key: Parameter,
): number | undefined {
    const definition = self.definition.skill.sp;
    const state = self.skill.sp;

    if (definition === null || state === null) {
        return undefined;
    }

    let base: number;

    switch (key) {
        case "recoverySpeed":
            base =
                definition.recovery.type === "TIME"
                    ? TICKS_PER_SECOND / definition.recovery.intervalTicks
                    : 0;
            break;

        case "recoveryMultiplier":
            base = 1;
            break;

        case "cost":
            base = definition.cost ?? resolve(battle, self, "requirement")!;
            break;

        case "capacity":
        case "requirement":
            base = definition[key];
    }

    const value = Math.max(
        0,
        modifier.apply(
            base,
            contribution.resolve(state[key], (input) =>
                typeof input === "function" ? input(battle, self) : input,
            ),
        ),
    );

    if (key === "recoverySpeed" || key === "recoveryMultiplier") {
        return value;
    }

    const integer = Math.ceil(value);
    assertNonnegativeSafeInteger(integer, `skill resolved SP ${key}`);

    return integer;
}

function allowsRecovery<S extends object, A extends object>(
    battle: BattleState,
    self: Unit & Skill<S, A>,
    source: Source,
): boolean {
    return self.skill.rules.every((rule) => rule.allowsRecovery?.(battle, self, source) ?? true);
}

function available(self: Unit): boolean {
    return self.lifecycle === "PRESENT" && (!hasVitality(self) || self.vitality.hp > 0);
}
function applied(state: BattleState, amount: number): Result<Outcome> {
    return { state, value: { type: "APPLIED", amount } };
}
function rejected(
    state: BattleState,
    reason: Extract<Outcome, { readonly type: "REJECTED" }>["reason"],
): Result<Outcome> {
    return { state, value: { type: "REJECTED", reason } };
}
