import * as registry from "../../hook/hook.js";
import type { State as BattleState, Result } from "../../../battle/state.js";
import type { Context } from "../../query.js";
import type { Unit } from "../../unit.js";
import { createSteeringState, type SteeringParameters, type SteeringState } from "./steering.js";
import * as contribution from "../../contribution/contribution.js";
import * as attribute from "../../contribution/attribute.js";

export interface Definition {
    readonly moveSpeedPerTick: number;
    readonly minimumMoveSpeedPerTick?: number;
    readonly steeringParameters: SteeringParameters;
}

export interface Rule {
    readonly id: string;
    readonly allows: (battle: BattleState, unit: Unit) => boolean;
}

export interface State {
    readonly moving: boolean;
    readonly moveSpeed: readonly contribution.Contribution<attribute.Input<Context>>[];
    readonly steering: SteeringState;
    readonly rules: readonly Rule[];
}

export interface Locomotion {
    readonly definition: {
        readonly locomotion: Definition;
    };
    readonly locomotion: State;
}

export function hasLocomotion<U extends Unit>(unit: U): unit is U & Locomotion {
    return "locomotion" in unit && "locomotion" in unit.definition;
}

export const initialize: (battle: BattleState, definition: Definition) => Result<State> = (
    battle,
) => {
    return {
        state: battle,
        value: { moving: false, moveSpeed: [], steering: createSteeringState(), rules: [] },
    };
};

export function setRule(state: State, rule: Rule): State {
    const rules = registry.set(state.rules, rule);

    return rules === state.rules ? state : { ...state, rules };
}

export function removeRule(state: State, id: string): State {
    const rules = registry.remove(state.rules, id);

    return rules === state.rules ? state : { ...state, rules };
}

export function canMove(battle: BattleState, unit: Unit & Locomotion): boolean {
    return unit.locomotion.rules.every((rule) => rule.allows(battle, unit));
}

function changeMoveSpeedContributions(
    state: State,
    transition: (entries: State["moveSpeed"]) => State["moveSpeed"],
): State {
    const moveSpeed = transition(state.moveSpeed);

    return moveSpeed === state.moveSpeed ? state : { ...state, moveSpeed };
}

export function setMoveSpeedContribution(
    state: State,
    entry: contribution.Contribution<attribute.Input<Context>>,
): State {
    return changeMoveSpeedContributions(state, (entries) => contribution.set(entries, entry));
}

export function removeMoveSpeedContribution(state: State, id: string): State {
    return changeMoveSpeedContributions(state, (entries) => contribution.remove(entries, id));
}

export function resolveMoveSpeed(definition: Definition, state: State, context: Context): number {
    return Math.max(
        definition.minimumMoveSpeedPerTick ?? 0,
        attribute.apply(
            definition.moveSpeedPerTick,
            contribution
                .resolve(state.moveSpeed)
                .flatMap((value) => attribute.evaluate(value, context)),
        ),
    );
}
