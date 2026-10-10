import {
    assertNonnegativeNumber,
    assertNonnegativeSafeInteger,
    assertPositiveNumber,
    assertPositiveSafeInteger,
} from "../../../../common/assert.js";
import { TICKS_PER_SECOND } from "../../../tick.js";
import type { Unit, UnitDefinition } from "../../unit.js";
import type { ActionDefinition } from "../action/capability.js";

export type SkillActivationMode = "MANUAL" | "AUTO" | "PASSIVE";

export type SkillSpRecovery = "TIME" | "ATTACK" | "HIT" | "NONE";

export interface SkillDefinition {
    readonly id: string;
    readonly activation: SkillActivationMode;
    readonly spRecovery: SkillSpRecovery;
    readonly spCost: number;
    readonly initialSp: number;
    readonly maxCharges?: number;
    readonly spRecoveryIntervalTicks?: number;
    readonly durationTicks: number | null;
    readonly ammo?: number;
    readonly ammoPerAttack?: number;
    readonly activeAction?: ActionDefinition;
}

export interface SkillActivation {
    readonly id: number;
    readonly startedAtTick: number;
    readonly endsAtTick: number | null;
    readonly remainingAmmo?: number;
}

export interface SkillState {
    readonly sp: number;
    readonly spRecoveryProgressTicks: number;
    readonly lastAdvancedTick: number;
    readonly nextActivationId: number;
    readonly active: SkillActivation | null;
}

export interface Skill {
    readonly skill: SkillState;
}

export interface SkilledUnitDefinition extends UnitDefinition {
    readonly skill: SkillDefinition;
}

export function hasSkill<U extends Unit>(
    unit: U,
): unit is U & Skill & Unit<U["definition"] & SkilledUnitDefinition> {
    return "skill" in unit && "skill" in unit.definition;
}

export function hasSkillDefinition(
    definition: UnitDefinition,
): definition is SkilledUnitDefinition {
    return "skill" in definition;
}

export function skillSpCapacity(definition: SkillDefinition): number {
    return definition.spCost * (definition.maxCharges ?? 1);
}

export function createSkillDefinition(definition: SkillDefinition): SkillDefinition {
    if (definition.id.length === 0) {
        throw new TypeError("skill identity must be nonempty");
    }

    assertNonnegativeSafeInteger(definition.spCost, "skill SP cost");
    assertNonnegativeSafeInteger(definition.initialSp, "skill initial SP");
    const maxCharges = definition.maxCharges ?? 1;
    const spRecoveryIntervalTicks = definition.spRecoveryIntervalTicks ?? TICKS_PER_SECOND;
    assertNonnegativeSafeInteger(maxCharges, "skill maximum charges");

    if (maxCharges === 0 && definition.spCost !== 0) {
        throw new RangeError("skill requiring SP must have a positive charge capacity");
    }

    assertPositiveNumber(spRecoveryIntervalTicks, "skill SP recovery interval");
    assertNonnegativeSafeInteger(skillSpCapacity(definition), "skill SP capacity");

    if (definition.initialSp > skillSpCapacity(definition)) {
        throw new RangeError("skill initial SP exceeds capacity");
    }
    if (definition.durationTicks !== null) {
        assertNonnegativeSafeInteger(definition.durationTicks, "skill duration ticks");
    }
    if (definition.ammo !== undefined) {
        assertPositiveSafeInteger(definition.ammo, "skill ammunition");
        assertPositiveSafeInteger(definition.ammoPerAttack ?? 1, "skill ammunition per attack");

        if (definition.durationTicks !== null) {
            throw new TypeError("ammunition skill must end by ammunition consumption");
        }
    } else if (definition.ammoPerAttack !== undefined) {
        throw new TypeError("ammunition consumption requires an ammunition skill");
    }
    if (definition.activation === "PASSIVE" && definition.spCost !== 0) {
        throw new TypeError("passive skill must not require SP");
    }

    const ammoPerAttack =
        definition.ammo === undefined ? undefined : (definition.ammoPerAttack ?? 1);

    if (
        definition.maxCharges === maxCharges &&
        definition.spRecoveryIntervalTicks === spRecoveryIntervalTicks &&
        definition.ammoPerAttack === ammoPerAttack
    ) {
        return definition;
    }

    return {
        ...definition,
        maxCharges,
        spRecoveryIntervalTicks,
        ...(ammoPerAttack === undefined ? {} : { ammoPerAttack }),
    };
}

export function initializeSkillState(
    definition: SkillDefinition,
    context: { readonly tick: number } = { tick: 0 },
): SkillState {
    assertNonnegativeSafeInteger(context.tick, "skill initialization tick");

    return createSkillState({
        sp: definition.initialSp,
        spRecoveryProgressTicks: 0,
        lastAdvancedTick: context.tick,
        nextActivationId: 0,
        active: null,
    });
}

export function createSkillState(state: SkillState): SkillState {
    assertNonnegativeSafeInteger(state.sp, "skill SP");
    assertNonnegativeNumber(state.spRecoveryProgressTicks, "skill SP recovery progress");
    assertNonnegativeSafeInteger(state.lastAdvancedTick, "skill last advanced tick");
    assertNonnegativeSafeInteger(state.nextActivationId, "skill next activation identity");

    if (state.active !== null) {
        assertNonnegativeSafeInteger(state.active.id, "skill activation identity");
        assertNonnegativeSafeInteger(state.active.startedAtTick, "skill activation tick");

        if (state.active.id >= state.nextActivationId) {
            throw new TypeError("skill allocation progress must exceed its active identity");
        }
        if (state.active.remainingAmmo !== undefined) {
            assertNonnegativeSafeInteger(state.active.remainingAmmo, "skill remaining ammunition");
        }
        if (state.active.endsAtTick !== null) {
            assertNonnegativeSafeInteger(state.active.endsAtTick, "skill ending tick");

            if (state.active.endsAtTick < state.active.startedAtTick) {
                throw new TypeError("skill ending tick precedes activation");
            }
        }
    }

    return state;
}
