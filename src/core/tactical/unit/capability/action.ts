import { Direction } from "../../geometry/direction.js";
import { RangeGrid } from "../../geometry/range.js";
import type { Unit, UnitDefinition, UnitId } from "../unit.js";

export type DamageType = "PHYSICAL" | "ARTS" | "TRUE";

export type TargetRange =
    | {
          readonly type: "GRID";
          readonly offsets: RangeGrid;
          readonly direction: Direction;
      }
    | {
          readonly type: "RADIUS";
          readonly radius: number;
      }
    | {
          readonly type: "BLOCKER";
      };

export interface TargetProfile {
    readonly range: TargetRange;
    readonly canTargetAir: boolean;
    readonly priority: "NEAREST";
}

export interface AttackDefinition {
    readonly power: number;
    readonly damageType: DamageType;
    readonly intervalTicks: number;
    readonly recoveryTicks: number;
    readonly targeting: TargetProfile;
}

export interface ActionDefinition {
    readonly attack: AttackDefinition;
}

export interface ActionState {
    readonly readyAtTick: number;
    readonly recoveryUntilTick: number;
    readonly targetUnitId: UnitId | null;
}

export interface Action {
    readonly action: ActionState;
}

export interface ActingUnitDefinition extends UnitDefinition {
    readonly action: ActionDefinition;
}

export function hasAction(unit: Unit): unit is Unit & Action {
    return "action" in unit;
}

export function hasActionDefinition(
    definition: UnitDefinition,
): definition is ActingUnitDefinition {
    return "action" in definition;
}

function nonnegative(value: number, name: string): number {
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`${name} must be finite and nonnegative`);
    }

    return value;
}

function ticks(value: number, minimum: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new RangeError(`${name} must be a safe integer of at least ${minimum}`);
    }

    return value;
}

function createTargetRange(range: TargetRange): TargetRange {
    switch (range.type) {
        case "GRID":
            if (!Direction.is(range.direction)) {
                throw new RangeError("unsupported attack range direction");
            }

            return Object.freeze({
                type: range.type,
                offsets: RangeGrid.create(range.offsets),
                direction: range.direction,
            });

        case "RADIUS":
            return Object.freeze({
                type: range.type,
                radius: nonnegative(range.radius, "attack radius"),
            });

        case "BLOCKER":
            return Object.freeze({ type: range.type });

        default:
            throw new RangeError("unsupported attack range type");
    }
}

export function createActionDefinition(definition: ActionDefinition): ActionDefinition {
    const attack = definition.attack;
    const damageType: unknown = attack.damageType;
    const priority: unknown = attack.targeting.priority;

    if (damageType !== "PHYSICAL" && damageType !== "ARTS" && damageType !== "TRUE") {
        throw new RangeError("unsupported attack damage type");
    }
    if (priority !== "NEAREST") {
        throw new RangeError("unsupported attack target priority");
    }
    if (typeof attack.targeting.canTargetAir !== "boolean") {
        throw new TypeError("canTargetAir must be boolean");
    }

    return Object.freeze({
        attack: Object.freeze({
            power: nonnegative(attack.power, "attack power"),
            damageType,
            intervalTicks: ticks(attack.intervalTicks, 1, "attack intervalTicks"),
            recoveryTicks: ticks(attack.recoveryTicks, 0, "attack recoveryTicks"),
            targeting: Object.freeze({
                range: createTargetRange(attack.targeting.range),
                canTargetAir: attack.targeting.canTargetAir,
                priority,
            }),
        }),
    });
}

export function createActionState(tick = 0): ActionState {
    ticks(tick, 0, "action tick");

    return { readyAtTick: tick, recoveryUntilTick: tick, targetUnitId: null };
}

export function copyActionState(state: Readonly<ActionState>): ActionState {
    return { ...state };
}
