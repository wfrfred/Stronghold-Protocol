import { getUnit, updateUnit } from "../../dist/core/tactical/battle/state.js";
import { createDefinition } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import { ref as activationRef } from "../../dist/core/tactical/unit/capability/skill/activation.js";
import { initialize } from "./unit.js";
import { ref } from "../../dist/core/tactical/unit/query.js";
import { effectFixtureWork } from "./effects.js";

export function definition(input = {}) {
    return createDefinition({
        id: "skill-fixture",
        initialize: () => ({}),
        sp: {
            initial: 2, capacity: 2, requirement: 2, cost: 2,
            recovery: { type: "TIME", intervalTicks: 30 },
        },
        activation: {
            trigger: "MANUAL", sustain: { type: "TIME", durationTicks: 30 },
            initialize: () => ({}),
        },
        ...input,
    });
}

export function fixture(input = {}, ...others) {
    const skill = definition(input);
    const unit = initialize({ id: 1, position: [0, 0], definition: { id: "skilled-unit", skill } });
    return { definition: skill, unit, ref: ref(unit), state: effectFixtureWork(unit, ...others) };
}

export function at(battle, tick) { return { ...battle, tick }; }

export function change(battle, transform, id = 1) {
    const unit = getUnit(battle, id);
    return updateUnit(battle, { ...unit, skill: transform(unit.skill) });
}

export function currentRef(battle, id = 1) {
    return activationRef(getUnit(battle, id).skill.active);
}
