import { assertNonnegativeNumber } from "../../../../common/assert.js";
import type { State as BattleState, Result } from "../../../battle/state.js";
import type { MotionMode } from "../../../battlefield/navigation/state.js";
import { createWorldPosition, type WorldPosition } from "../../../geometry/coordinate.js";
import type { Context } from "../../query.js";
import type { Unit } from "../../unit.js";
import type { Contribution } from "../../contribution/contribution.js";
import type * as attribute from "../../contribution/attribute.js";
import type { SteeringParameters } from "./steering.js";
import * as registry from "../../hook/hook.js";

export interface Definition {
    readonly speed: number;
    readonly minSpeed: number;
    readonly steeringParameters: SteeringParameters;
    readonly halfBodyWidth: number;
}

export interface Rule {
    readonly id: string;
    readonly allows: (battle: BattleState, self: Unit & Locomotion) => boolean;
}

export interface State {
    readonly velocity: WorldPosition;
    readonly speed: readonly Contribution<attribute.Input<Context>>[];
    readonly rules: readonly Rule[];
}

export interface Locomotion {
    readonly definition: { readonly locomotion: Definition };
    readonly locomotion: State;
}

export interface MovementTarget {
    readonly nextPoint: WorldPosition;
    readonly goal: WorldPosition;
}

export interface MovementContext {
    readonly mode: MotionMode;
    readonly speedMultiplier: number;
}

export function hasLocomotion<U extends Unit>(unit: U): unit is U & Locomotion {
    return "locomotion" in unit && "locomotion" in unit.definition;
}

export function initialize(battle: BattleState, definition: Definition): Result<State> {
    assertNonnegativeNumber(definition.speed, "speed");
    assertNonnegativeNumber(definition.minSpeed, "minSpeed");
    assertNonnegativeNumber(definition.halfBodyWidth, "halfBodyWidth");
    assertNonnegativeNumber(definition.steeringParameters.steeringFactor, "steeringFactor");
    assertNonnegativeNumber(definition.steeringParameters.maxSteeringForce, "maxSteeringForce");

    return {
        state: battle,
        value: { velocity: createWorldPosition(0, 0), speed: [], rules: [] },
    };
}

export function setRule(state: State, rule: Rule): State {
    const rules = registry.set(state.rules, rule);

    return rules === state.rules ? state : { ...state, rules };
}

export function removeRule(state: State, id: string): State {
    const rules = registry.remove(state.rules, id);

    return rules === state.rules ? state : { ...state, rules };
}
