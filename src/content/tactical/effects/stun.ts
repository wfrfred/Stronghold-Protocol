import { updateUnit } from "../../../core/tactical/battle/state.js";
import type { Definition } from "../../../core/tactical/unit/effect/definition.js";
import * as action from "../../../core/tactical/unit/capability/action/capability.js";
import * as blocker from "../../../core/tactical/unit/capability/blocking/blocker.js";
import * as locomotion from "../../../core/tactical/unit/capability/locomotion/capability.js";
import * as movement from "../../../core/tactical/unit/capability/locomotion/operations.js";
import * as skill from "../../../core/tactical/unit/capability/skill/capability.js";
import { cancelForUnit } from "../../../core/tactical/unit/action/operations.js";
import { ref } from "../../../core/tactical/unit/query.js";

export const stun: Definition<object> = {
    id: "control/stun",
    initialize: () => ({}),
    onEnable(state, { unit, self }) {
        const id = `@effect/${self.id}/stun`;
        const rule = { id, allows: () => false };

        state = updateUnit(state, {
            ...unit,
            ...(action.hasAction(unit) ? { action: action.setRule(unit.action, rule) } : {}),
            ...(blocker.hasBlocker(unit) ? { blocker: blocker.setRule(unit.blocker, rule) } : {}),
            ...(locomotion.hasLocomotion(unit)
                ? { locomotion: movement.setRule(unit.locomotion, rule) }
                : {}),
            ...(skill.hasSkill(unit)
                ? { skill: skill.setRule(unit.skill, { id, allowsActivation: () => false }) }
                : {}),
        });

        return cancelForUnit(state, ref(unit), "INTERRUPTED");
    },
    onDisable(state, { unit, self }) {
        const id = `@effect/${self.id}/stun`;

        state = updateUnit(state, {
            ...unit,
            ...(action.hasAction(unit) ? { action: action.removeRule(unit.action, id) } : {}),
            ...(blocker.hasBlocker(unit) ? { blocker: blocker.removeRule(unit.blocker, id) } : {}),
            ...(locomotion.hasLocomotion(unit)
                ? { locomotion: movement.removeRule(unit.locomotion, id) }
                : {}),
            ...(skill.hasSkill(unit) ? { skill: skill.removeRule(unit.skill, id) } : {}),
        });

        return state;
    },
};
