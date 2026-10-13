import type { Context } from "../../query.js";
import {
    assertNonnegativeSafeInteger,
    assertNonnegativeNumber,
    assertPositiveNumber,
} from "../../../../common/assert.js";
import * as contribution from "../../contribution/contribution.js";
import * as operation from "./operation.js";
import { createTargetingDefinition, type TargetingDefinition } from "../../targeting/definition.js";
import type { Unit, Definition as UnitDefinition } from "../../unit.js";
import * as hook from "../../hook/hook.js";
import type { ActionReleaseHook } from "./release.js";

export type TargetBindingId = string;

export interface ActionTargetGroupDefinition {
    readonly id: TargetBindingId;
    readonly targeting: TargetingDefinition;
    readonly operations: readonly [operation.Definition, ...operation.Definition[]];
}

export type OperationReceiver =
    { readonly type: "SOURCE" } | { readonly type: "BINDING"; readonly bindingId: TargetBindingId };

export interface FollowUpOperationDefinition {
    readonly receiver: OperationReceiver;
    readonly operation: operation.Definition;
}

export interface ActionDefinition {
    readonly triggerBindingId: TargetBindingId;
    readonly targetGroups: readonly [ActionTargetGroupDefinition, ...ActionTargetGroupDefinition[]];
    readonly followUps: readonly FollowUpOperationDefinition[];
    readonly baseAttackTimeTicks: number;
    readonly recoveryTicks: number;
}

export interface Definition {
    readonly attackSpeed?: number;
    readonly normalAction: ActionDefinition;
}

export interface State {
    readonly readyAtTick: number;
    readonly recoveryUntilTick: number;
    readonly cooldownIntervalTicks: number | null;
    readonly attackSpeed: readonly contribution.Contribution<contribution.Input<Context>>[];
    readonly baseAttackTime: readonly contribution.Contribution<contribution.Input<Context>>[];
    readonly beforeRelease: readonly ActionReleaseHook[];
}

export interface Action {
    readonly definition: { readonly action: Definition };
    readonly action: State;
}

export function hasAction<U extends Unit>(unit: U): unit is U & Action {
    return "action" in unit && "action" in unit.definition;
}

export function hasActionDefinition(
    definition: UnitDefinition,
): definition is UnitDefinition & Action["definition"] {
    return "action" in definition;
}

export function createActionDefinition(definition: ActionDefinition): ActionDefinition {
    const ids = new Set<TargetBindingId>();
    const targetGroups = Array.from(definition.targetGroups, (group) => {
        if (group.id.length === 0 || ids.has(group.id)) {
            throw new RangeError("action target binding IDs must be unique and nonempty");
        }

        ids.add(group.id);

        return Object.freeze({
            id: group.id,
            targeting: createTargetingDefinition(group.targeting),
            operations: Object.freeze(Array.from(group.operations, operation.create)) as readonly [
                operation.Definition,
                ...operation.Definition[],
            ],
        });
    });
    const followUps = Array.from(definition.followUps, ({ receiver, operation: followUp }) => {
        if (receiver.type === "BINDING" && !ids.has(receiver.bindingId)) {
            throw new RangeError("follow-up references an unknown target binding");
        }

        return Object.freeze({
            receiver: Object.freeze({ ...receiver }),
            operation: operation.create(followUp),
        });
    });

    if (!ids.has(definition.triggerBindingId)) {
        throw new RangeError("action trigger references an unknown target binding");
    }

    assertPositiveNumber(definition.baseAttackTimeTicks, "action baseAttackTimeTicks");
    assertNonnegativeSafeInteger(definition.recoveryTicks, "action recoveryTicks");

    return Object.freeze({
        triggerBindingId: definition.triggerBindingId,
        targetGroups: Object.freeze(targetGroups) as ActionDefinition["targetGroups"],
        followUps: Object.freeze(followUps),
        baseAttackTimeTicks: definition.baseAttackTimeTicks,
        recoveryTicks: definition.recoveryTicks,
    });
}

export function createDefinition(definition: Definition): Definition {
    const attackSpeed = definition.attackSpeed ?? 100;
    assertNonnegativeNumber(attackSpeed, "attack speed");

    return Object.freeze({
        attackSpeed,
        normalAction: createActionDefinition(definition.normalAction),
    });
}

export function initialize(tick = 0): State {
    assertNonnegativeSafeInteger(tick, "action tick");

    return {
        readyAtTick: tick,
        recoveryUntilTick: tick,
        cooldownIntervalTicks: null,
        attackSpeed: [],
        baseAttackTime: [],
        beforeRelease: [],
    };
}

export function setBeforeReleaseHook(state: State, entry: ActionReleaseHook): State {
    const beforeRelease = hook.set(state.beforeRelease, entry);

    return beforeRelease === state.beforeRelease ? state : { ...state, beforeRelease };
}

export function removeBeforeReleaseHook(state: State, id: string): State {
    const beforeRelease = hook.remove(state.beforeRelease, id);

    return beforeRelease === state.beforeRelease ? state : { ...state, beforeRelease };
}

function updateContributions(
    state: State,
    key: "attackSpeed" | "baseAttackTime",
    transition: (entries: State["attackSpeed"]) => State["attackSpeed"],
): State {
    const updated = transition(state[key]);

    return updated === state[key] ? state : { ...state, [key]: updated };
}

export function setAttackSpeedContribution(
    state: State,
    entry: contribution.Contribution<contribution.Input<Context>>,
): State {
    return updateContributions(state, "attackSpeed", (entries) => contribution.set(entries, entry));
}

export function removeAttackSpeedContribution(state: State, id: string): State {
    return updateContributions(state, "attackSpeed", (entries) => contribution.remove(entries, id));
}

export function setBaseAttackTimeContribution(
    state: State,
    entry: contribution.Contribution<contribution.Input<Context>>,
): State {
    return updateContributions(state, "baseAttackTime", (entries) =>
        contribution.set(entries, entry),
    );
}

export function removeBaseAttackTimeContribution(state: State, id: string): State {
    return updateContributions(state, "baseAttackTime", (entries) =>
        contribution.remove(entries, id),
    );
}
