import { assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import type { Ref } from "../../../../common/ref.js";
import { appendEvents, type State as BattleState, type Result } from "../../../battle/state.js";
import { closeLifetime } from "../../../battle/execution/lifetime.js";
import * as units from "../../query.js";
import type { Unit } from "../../unit.js";
import * as contribution from "../../contribution/contribution.js";
import * as modifier from "../../contribution/value.js";
import { isSpatiallyPresent } from "../presence/capability.js";
import { hasVitality } from "../vitality/capability.js";
import { hasAction, setReleasedHook } from "../action/capability.js";
import type { ReleasedHook } from "../action/release.js";
import { setHook as setDamageHook, type ReceivedHook } from "../vitality/damage/hook.js";
import { hasSkill, type Skill, type Stored } from "./capability.js";
import {
    ref as activationRef,
    type Activation,
    type Stored as StoredActivation,
    type Trigger,
    type End,
} from "./activation.js";
import type { Operation } from "./rule.js";
import type { State as SustainState } from "./sustain.js";
import { dispatch } from "./hook.js";
import * as query from "./query.js";
import * as sp from "./sp.js";

const hitRecovery: ReceivedHook = {
    id: "@skill/hit-recovery",
    stage: "received",
    enabled: (_battle, _target, event) =>
        event.pending.cancellation === null && event.request.ignoreForSp !== true,
    invoke: (battle, target) =>
        hasSkill(target) ? sp.recover(battle, units.ref(target), "HIT").state : battle,
};

const actionRecovery: ReleasedHook = {
    id: "@skill/action-recovery",
    enabled: () => true,
    invoke: (battle, source) =>
        hasSkill(source) ? sp.recover(battle, units.ref(source), "ACTION").state : battle,
};

export type Outcome<T extends StoredActivation = StoredActivation> =
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

export function activate<S extends object, A extends object>(
    battle: BattleState,
    host: Ref<Unit & Skill<S, A>>,
    trigger?: Trigger,
): Result<Outcome<Activation<S, A>>>;
export function activate(
    battle: BattleState,
    host: Ref<Unit & Stored>,
    trigger?: Trigger,
): Result<Outcome>;
export function activate(
    battle: BattleState,
    host: Ref<Unit & Stored>,
    trigger: Trigger = "MANUAL",
): Result<Outcome> {
    return (
        query.read(battle, host, (self): Result<Outcome> => {
            const definition = self.definition.skill.activation;
            const reject = (reason: string): Result<Outcome> => ({
                state: battle,
                value: { type: "REJECTED", reason },
            });

            if (
                self.lifecycle !== "PRESENT" ||
                !isSpatiallyPresent(self) ||
                (hasVitality(self) && self.vitality.hp <= 0)
            ) {
                return reject("UNAVAILABLE");
            }
            if (definition === null) {
                return reject("NO_ACTIVATION");
            }
            if (self.skill.active !== null) {
                return reject("ACTIVE");
            }
            if (definition.trigger !== trigger) {
                return reject("WRONG_TRIGGER");
            }
            if (trigger === "PASSIVE" && self.skill.nextActivationId !== 0) {
                return reject("ALREADY_ACTIVATED");
            }
            if (
                !self.skill.rules.every((rule) => rule.allowsActivation?.(battle, self) ?? true) ||
                !(definition.accepts?.(battle, self) ?? true)
            ) {
                return reject("CONDITION");
            }

            const identity = units.ref(self);
            const requirement = sp.resolveRequirement(battle, identity) ?? 0;
            const cost = definition.cost?.(battle, self) ?? sp.resolveCost(battle, identity) ?? 0;
            assertNonnegativeSafeInteger(cost, "skill activation SP cost");
            const previousSp = self.skill.sp;

            if ((previousSp?.value ?? 0) < requirement || (previousSp?.value ?? 0) < cost) {
                return reject("INSUFFICIENT_SP");
            }

            const sustain = initialSustain(battle, self);
            const active = {
                host: identity,
                id: self.skill.nextActivationId,
                startedAtTick: battle.tick,
                status: "ACTIVE" as const,
                sustain,
                data: definition.initialize(battle, self),
            };
            const nextActivationId = active.id + 1;
            assertNonnegativeSafeInteger(nextActivationId, "skill activation allocation progress");

            battle = query.replace(battle, {
                ...self,
                skill: {
                    ...self.skill,
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
                    unitId: self.id,
                    skillId: self.definition.skill.id,
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

            const current = units.get(battle, identity);

            if (
                current?.lifecycle === "PRESENT" &&
                isSpatiallyPresent(current) &&
                (!hasVitality(current) || current.vitality.hp > 0) &&
                current.skill.active?.id === active.id &&
                current.skill.active.status === "ACTIVE" &&
                definition.onStart !== undefined
            ) {
                battle = definition.onStart(battle, current.skill.active);
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

export function finish(battle: BattleState, reference: Ref<StoredActivation>): BattleState {
    return end(battle, reference, { type: "FINISHED" });
}

export function cancel(
    battle: BattleState,
    reference: Ref<StoredActivation>,
    reason = "CANCELLED",
): BattleState {
    return end(battle, reference, { type: "CANCELLED", reason });
}

function end(battle: BattleState, reference: Ref<StoredActivation>, ending: End): BattleState {
    return (
        query.read(battle, reference.host, (self) => {
            const active = self.skill.active;
            const definition = self.definition.skill.activation;

            if (active?.id !== reference.id || active.status !== "ACTIVE" || definition === null) {
                return battle;
            }

            const closing = { ...active, status: "ENDING" as const };
            battle = query.replace(battle, { ...self, skill: { ...self.skill, active: closing } });
            battle = closeLifetime(
                battle,
                { type: "SKILL", ref: activationRef(closing) },
                ending.type === "CANCELLED" ? ending.reason : "SKILL_FINISHED",
            );
            const current = units.get(battle, active.host)?.skill.active;
            const finished = current?.id === active.id ? current : closing;

            if (definition.onEnd !== undefined) {
                battle = definition.onEnd(battle, finished, ending);
            }

            const host = units.get(battle, active.host);

            if (host?.skill.active?.id === active.id) {
                battle = query.replace(battle, { ...host, skill: { ...host.skill, active: null } });
            }

            battle = appendEvents(battle, [
                {
                    type: "SKILL_FINISHED",
                    unitId: self.id,
                    skillId: self.definition.skill.id,
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
    reference: Ref<StoredActivation>,
    operation: Operation,
): Result<{ readonly type: "APPLIED" } | { readonly type: "REJECTED"; readonly reason: string }> {
    return (
        query.read(battle, reference.host, (self) => {
            const active = self.skill.active;
            const definition = self.definition.skill.activation;
            const reject = (reason: string) => ({
                state: battle,
                value: { type: "REJECTED" as const, reason },
            });

            if (
                self.lifecycle !== "PRESENT" ||
                active?.id !== reference.id ||
                active.status !== "ACTIVE" ||
                definition === null
            ) {
                return reject("UNAVAILABLE");
            }
            if (
                !self.skill.rules.every(
                    (rule) => rule.allowsOperation?.(battle, self, operation) ?? true,
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

export function advance(battle: BattleState, host: Ref<Unit & Stored>): BattleState {
    battle = sp.advance(battle, host);
    battle =
        query.read(battle, host, (self) =>
            self.lifecycle === "PRESENT" && self.definition.skill.onTick !== undefined
                ? self.definition.skill.onTick(battle, self)
                : battle,
        ) ?? battle;
    battle =
        query.read(battle, host, (self) => {
            const active = self.skill.active;

            if (self.lifecycle !== "PRESENT" || active?.status !== "ACTIVE") {
                return battle;
            }
            if (active.sustain.type === "TIME" && active.sustain.endsAtTick <= battle.tick) {
                return finish(battle, activationRef(active));
            }

            return self.definition.skill.activation?.onTick?.(battle, active) ?? battle;
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

export function enter(battle: BattleState, host: Ref<Unit & Stored>): BattleState {
    battle =
        query.read(battle, host, (self) => {
            if (self.lifecycle !== "PRESENT") {
                return battle;
            }
            if (hasVitality(self) && self.definition.skill.sp?.recovery.type === "HIT") {
                const updated = {
                    ...self,
                    vitality: setDamageHook(self.vitality, hitRecovery),
                };
                battle = query.replace(battle, updated);
            }

            const current = units.get(battle, units.ref(self));

            if (
                current !== undefined &&
                hasAction(current) &&
                self.definition.skill.sp?.recovery.type === "ACTION"
            ) {
                const updated = {
                    ...current,
                    action: setReleasedHook(current.action, actionRecovery),
                };
                battle = query.replace(battle, updated);
            }

            const entered = units.get(battle, units.ref(self));

            return entered !== undefined && self.definition.skill.onEnter !== undefined
                ? self.definition.skill.onEnter(battle, entered)
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
    reference: Ref<StoredActivation>,
    ticks: number,
): BattleState {
    if (!Number.isSafeInteger(ticks)) {
        throw new TypeError("skill time adjustment must be a safe integer");
    }

    return (
        query.read(battle, reference.host, (self) => {
            const active = self.skill.active;

            if (
                self.lifecycle !== "PRESENT" ||
                (hasVitality(self) && self.vitality.hp <= 0) ||
                active?.id !== reference.id ||
                active.status !== "ACTIVE" ||
                active.sustain.type !== "TIME"
            ) {
                return battle;
            }

            const endsAtTick = Math.max(battle.tick, active.sustain.endsAtTick + ticks);
            assertNonnegativeSafeInteger(endsAtTick, "skill ending tick");

            return query.replace(battle, {
                ...self,
                skill: {
                    ...self.skill,
                    active: { ...active, sustain: { type: "TIME", endsAtTick } },
                },
            });
        }) ?? battle
    );
}

function initialSustain<S extends object, A extends object>(
    battle: BattleState,
    self: Unit & Skill<S, A>,
): SustainState {
    const definition = self.definition.skill.activation!.sustain;
    const contributions = self.skill.sustain;
    const entries = [];

    if (contributions?.type === "TIME") {
        entries.push(...contributions.duration);
    } else if (contributions?.type === "AMMO") {
        entries.push(...contributions.ammo);
    }

    if (definition.type === "INFINITE") {
        return { type: "INFINITE" };
    }

    const base = definition.type === "TIME" ? definition.durationTicks : definition.amount;
    const budget = Math.max(
        0,
        Math.ceil(
            modifier.apply(
                base,
                contribution.resolve(entries, (input) =>
                    typeof input === "function" ? input(battle, self) : input,
                ),
            ),
        ),
    );
    assertNonnegativeSafeInteger(budget, "skill sustain budget");

    if (definition.type === "AMMO") {
        return { type: "AMMO", initial: budget, remaining: budget, replenished: 0 };
    }

    const endsAtTick = battle.tick + budget;
    assertNonnegativeSafeInteger(endsAtTick, "skill ending tick");

    return { type: "TIME", endsAtTick };
}
