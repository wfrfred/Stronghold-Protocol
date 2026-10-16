import { assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import type { Ref } from "../../../../common/ref.js";
import { appendEvents, type State as BattleState, type Result } from "../../../battle/state.js";
import { closeLifetime } from "../../../battle/execution/lifetime.js";
import * as units from "../../query.js";
import type { Unit } from "../../unit.js";
import * as contribution from "../../contribution/contribution.js";
import { isSpatiallyPresent } from "../presence/capability.js";
import { hasVitality } from "../vitality/capability.js";
import { hasAction, setReleasedHook } from "../action/capability.js";
import type { ReleasedHook } from "../action/release.js";
import {
    setHook as setDamageHook,
    type ReceivingStartedHook,
} from "../../../battle/damage/hook.js";
import { hasSkill, type Skill } from "./capability.js";
import { ref as activationRef, type Activation, type Trigger, type End } from "./activation.js";
import type { Operation } from "./rule.js";
import type { State as SustainState } from "./sustain.js";
import { dispatch } from "./hook.js";
import * as query from "./query.js";
import * as instance from "./instance.js";
import { read } from "./internal/read.js";
import type { Instance } from "./instance.js";
import * as sp from "./sp.js";
import { resolveCapacity as resolveAmmoCapacity } from "./ammo.js";
import * as modifier from "./modifier.js";

const hitRecovery: ReceivingStartedHook = {
    id: "@skill/hit-recovery",
    stage: "receivingStarted",
    priority: 0,
    invoke: (battle, { request }) => {
        const target = units.get(battle, request.target);

        return {
            state:
                target !== undefined && hasSkill(target)
                    ? sp.recover(battle, units.ref(target), "HIT").state
                    : battle,
            value: undefined,
        };
    },
};

const actionRecovery: ReleasedHook = {
    id: "@skill/action-recovery",
    invoke: (battle, { source }) => {
        const unit = units.get(battle, source);

        return {
            state:
                unit !== undefined && hasSkill(unit)
                    ? sp.recover(battle, units.ref(unit), "ACTION").state
                    : battle,
            value: undefined,
        };
    },
};

export type Outcome<T extends Activation = Activation> =
    | { readonly type: "ACTIVATED"; readonly ref: Ref<T> }
    | { readonly type: "REJECTED"; readonly reason: string };

export type Signal = {
    readonly unitId: number;
    readonly skillId: string;
    readonly activationId: number;
    readonly tick: number;
} & (
    | { readonly type: "SKILL_ACTIVATED"; readonly endsAtTick: number | null }
    | { readonly type: "SKILL_FINISHED"; readonly end: End }
);

export function activate(
    battle: BattleState,
    host: Ref<Unit & Skill>,
    trigger: Trigger = "MANUAL",
): Result<Outcome> {
    return (
        read(battle, host, (self, unit): Result<Outcome> => {
            const definition = self.definition.activation;
            const reject = (reason: string): Result<Outcome> => ({
                state: battle,
                value: { type: "REJECTED", reason },
            });

            if (
                unit.lifecycle !== "PRESENT" ||
                !isSpatiallyPresent(unit) ||
                (hasVitality(unit) && unit.vitality.hp <= 0)
            ) {
                return reject("UNAVAILABLE");
            }
            if (definition === null) {
                return reject("NO_ACTIVATION");
            }
            if (self.state.active !== null) {
                return reject("ACTIVE");
            }
            if (definition.trigger !== trigger) {
                return reject("WRONG_TRIGGER");
            }
            if (trigger === "PASSIVE" && self.state.nextActivationId !== 0) {
                return reject("ALREADY_ACTIVATED");
            }
            if (
                !self.state.rules.every((rule) => rule.allowsActivation?.(battle, unit) ?? true) ||
                !(definition.accepts?.(battle, self) ?? true)
            ) {
                return reject("CONDITION");
            }

            const identity = self.host;
            const requirement = sp.resolveRequirement(battle, identity) ?? 0;
            const cost = definition.cost?.(battle, self) ?? sp.resolveCost(battle, identity) ?? 0;
            assertNonnegativeSafeInteger(cost, "skill activation SP cost");
            const previousSp = self.state.sp;

            if ((previousSp?.value ?? 0) < requirement || (previousSp?.value ?? 0) < cost) {
                return reject("INSUFFICIENT_SP");
            }

            const sustain = initialSustain(battle, self, unit);
            const active = {
                host: identity,
                id: self.state.nextActivationId,
                startedAtTick: battle.tick,
                status: "ACTIVE" as const,
                sustain,
                data: definition.initialize(battle, self),
            };
            const nextActivationId = active.id + 1;
            assertNonnegativeSafeInteger(nextActivationId, "skill activation allocation progress");

            battle = instance.replace(battle, {
                ...self,
                state: {
                    ...self.state,
                    sp:
                        previousSp === null
                            ? null
                            : { ...previousSp, value: previousSp.value - cost },
                    nextActivationId,
                    active,
                },
            });
            const reference = activationRef(active);
            battle = appendEvents(battle, [
                {
                    type: "SKILL_ACTIVATED",
                    unitId: self.host.id,
                    skillId: self.definition.id,
                    activationId: active.id,
                    tick: battle.tick,
                    endsAtTick: sustain.type === "TIME" ? sustain.endsAtTick : null,
                },
            ]);
            battle = dispatch(battle, identity, "activated", active);

            if (previousSp !== null) {
                battle = dispatch(battle, identity, "spPaid", {
                    amount: cost,
                    previous: previousSp.value,
                    current: previousSp.value - cost,
                });
            }

            const current = instance.get(battle, self.host, self.definition);
            const host = units.get(battle, identity);

            if (
                host?.lifecycle === "PRESENT" &&
                isSpatiallyPresent(host) &&
                (!hasVitality(host) || host.vitality.hp > 0) &&
                current?.state.active?.id === active.id &&
                current.state.active.status === "ACTIVE" &&
                definition.onStart !== undefined
            ) {
                battle = definition.onStart(battle, current.state.active);
            }

            const after = query.get(battle, reference);

            if (
                after?.status === "ACTIVE" &&
                after.sustain.type === "TIME" &&
                after.sustain.endsAtTick <= battle.tick
            ) {
                battle = finish(battle, reference);
            }

            return { state: battle, value: { type: "ACTIVATED", ref: reference } };
        }) ?? { state: battle, value: { type: "REJECTED", reason: "UNAVAILABLE" } }
    );
}

export function finish(battle: BattleState, reference: Ref<Activation>): BattleState {
    return end(battle, reference, { type: "FINISHED" });
}

export function cancel(
    battle: BattleState,
    reference: Ref<Activation>,
    reason = "CANCELLED",
): BattleState {
    return end(battle, reference, { type: "CANCELLED", reason });
}

function end(battle: BattleState, reference: Ref<Activation>, ending: End): BattleState {
    return (
        read(battle, reference.host, (self) => {
            const active = self.state.active;
            const definition = self.definition.activation;

            if (active?.id !== reference.id || active.status !== "ACTIVE" || definition === null) {
                return battle;
            }

            const closing = { ...active, status: "ENDING" as const };
            battle = instance.replace(battle, {
                ...self,
                state: { ...self.state, active: closing },
            });
            battle = closeLifetime(
                battle,
                { type: "SKILL", ref: activationRef(closing) },
                ending.type === "CANCELLED" ? ending.reason : "SKILL_FINISHED",
            );
            const current = instance.get(battle, self.host, self.definition)?.state.active;
            const finished = current?.id === active.id ? current : closing;

            if (definition.onEnd !== undefined) {
                battle = definition.onEnd(battle, finished, ending);
            }

            const host = instance.get(battle, self.host, self.definition);

            if (host?.state.active?.id === active.id) {
                battle = instance.replace(battle, {
                    ...host,
                    state: { ...host.state, active: null },
                });
            }

            battle = appendEvents(battle, [
                {
                    type: "SKILL_FINISHED",
                    unitId: self.host.id,
                    skillId: self.definition.id,
                    activationId: active.id,
                    tick: battle.tick,
                    end: ending,
                },
            ]);

            return dispatch(battle, active.host, "ended", { activation: finished, end: ending });
        }) ?? battle
    );
}

export function operate(
    battle: BattleState,
    reference: Ref<Activation>,
    operation: Operation,
): Result<{ readonly type: "APPLIED" } | { readonly type: "REJECTED"; readonly reason: string }> {
    return (
        read(battle, reference.host, (self, unit) => {
            const active = self.state.active;
            const definition = self.definition.activation;
            const reject = (reason: string) => ({
                state: battle,
                value: { type: "REJECTED" as const, reason },
            });

            if (
                unit.lifecycle !== "PRESENT" ||
                active?.id !== reference.id ||
                active.status !== "ACTIVE" ||
                definition === null
            ) {
                return reject("UNAVAILABLE");
            }
            if (
                !self.state.rules.every(
                    (rule) => rule.allowsOperation?.(battle, unit, operation) ?? true,
                )
            ) {
                return reject("CONDITION");
            }
            if (definition.onOperation !== undefined) {
                battle = definition.onOperation(battle, active, operation);
            } else if (operation === "STOP") {
                battle = finish(battle, reference);
            } else {
                return reject("UNSUPPORTED");
            }

            return { state: battle, value: { type: "APPLIED" as const } };
        }) ?? { state: battle, value: { type: "REJECTED", reason: "UNAVAILABLE" } }
    );
}

export function advance(battle: BattleState, host: Ref<Unit & Skill>): BattleState {
    battle = sp.advance(battle, host);
    battle =
        read(battle, host, (self, unit) =>
            unit.lifecycle === "PRESENT" && self.definition.onTick !== undefined
                ? self.definition.onTick(battle, self)
                : battle,
        ) ?? battle;
    battle =
        read(battle, host, (self, unit) => {
            const active = self.state.active;

            if (unit.lifecycle !== "PRESENT" || active?.status !== "ACTIVE") {
                return battle;
            }
            if (active.sustain.type === "TIME" && active.sustain.endsAtTick <= battle.tick) {
                return finish(battle, activationRef(active));
            }

            return self.definition.activation?.onTick?.(battle, active) ?? battle;
        }) ?? battle;
    const self = units.get(battle, host);
    const trigger = self?.definition.skill.activation?.trigger;

    if (
        self?.lifecycle === "PRESENT" &&
        self.skill.active === null &&
        (trigger === "AUTO" || trigger === "PASSIVE")
    ) {
        battle = activate(battle, host, trigger).state;
    }

    return battle;
}

export function enter(battle: BattleState, host: Ref<Unit & Skill>): BattleState {
    battle =
        read(battle, host, (self, unit) => {
            if (unit.lifecycle !== "PRESENT") {
                return battle;
            }
            if (hasVitality(unit) && self.definition.sp?.recovery.type === "HIT") {
                const updated = { ...unit, vitality: setDamageHook(unit.vitality, hitRecovery) };
                battle = query.replace(battle, updated);
            }

            const current = units.get(battle, self.host);

            if (
                current !== undefined &&
                hasAction(current) &&
                self.definition.sp?.recovery.type === "ACTION"
            ) {
                const updated = {
                    ...current,
                    action: setReleasedHook(current.action, actionRecovery),
                };
                battle = query.replace(battle, updated);
            }

            const entered = instance.get(battle, self.host, self.definition);

            return entered !== undefined && self.definition.onEnter !== undefined
                ? self.definition.onEnter(battle, entered)
                : battle;
        }) ?? battle;
    const current = units.get(battle, host);

    return current?.lifecycle === "PRESENT" &&
        current.definition.skill.activation?.trigger === "PASSIVE"
        ? activate(battle, host, "PASSIVE").state
        : battle;
}

export function extendTime(
    battle: BattleState,
    reference: Ref<Activation>,
    ticks: number,
): BattleState {
    if (!Number.isSafeInteger(ticks)) {
        throw new TypeError("skill time adjustment must be a safe integer");
    }

    return (
        read(battle, reference.host, (self, unit) => {
            const active = self.state.active;

            if (
                unit.lifecycle !== "PRESENT" ||
                (hasVitality(unit) && unit.vitality.hp <= 0) ||
                active?.id !== reference.id ||
                active.status !== "ACTIVE" ||
                active.sustain.type !== "TIME"
            ) {
                return battle;
            }

            const endsAtTick = Math.max(battle.tick, active.sustain.endsAtTick + ticks);
            assertNonnegativeSafeInteger(endsAtTick, "skill ending tick");

            return instance.replace(battle, {
                ...self,
                state: {
                    ...self.state,
                    active: { ...active, sustain: { type: "TIME", endsAtTick } },
                },
            });
        }) ?? battle
    );
}

function initialSustain<S extends object, A extends object>(
    battle: BattleState,
    self: Instance<S, A>,
    unit: Unit & Skill,
): SustainState {
    const definition = self.definition.activation!.sustain;
    const contributions = self.state.sustain;

    if (definition.type === "INFINITE") {
        return { type: "INFINITE" };
    }

    if (definition.type === "AMMO") {
        const entries = contributions?.type === "AMMO" ? contributions.ammo : [];
        const budget = resolveAmmoCapacity(
            definition.amount,
            contribution
                .resolve(entries)
                .map((input) => (typeof input === "function" ? input(battle, unit) : input)),
        );

        return { type: "AMMO", initial: budget, remaining: budget, replenished: 0 };
    }

    const entries = contributions?.type === "TIME" ? contributions.duration : [];
    const budget = Math.ceil(
        Math.max(
            0,
            modifier.apply(battle, unit, definition.durationTicks, contribution.resolve(entries)),
        ),
    );
    assertNonnegativeSafeInteger(budget, "skill sustain budget");
    const endsAtTick = battle.tick + budget;
    assertNonnegativeSafeInteger(endsAtTick, "skill ending tick");

    return { type: "TIME", endsAtTick };
}
