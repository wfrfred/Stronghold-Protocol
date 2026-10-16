import type { Definition } from "../../../core/tactical/unit/effect/definition.js";
import { updateUnit } from "../../../core/tactical/battle/state.js";
import * as skill from "../../../core/tactical/unit/capability/skill/capability.js";

export const silence: Definition<object> = {
    id: "control/silence",
    initialize: () => ({}),
    onEnable(state, { unit, self }) {
        return skill.hasSkill(unit)
            ? updateUnit(state, {
                  ...unit,
                  skill: skill.setRule(unit.skill, {
                      id: `@effect/${self.id}/silence`,
                      allowsActivation: () => false,
                  }),
              })
            : state;
    },
    onDisable(state, { unit, self }) {
        return skill.hasSkill(unit)
            ? updateUnit(state, {
                  ...unit,
                  skill: skill.removeRule(unit.skill, `@effect/${self.id}/silence`),
              })
            : state;
    },
};

export const blockSpRecovery: Definition<object> = {
    id: "control/block-sp-recovery",
    initialize: () => ({}),
    onEnable(state, { unit, self }) {
        return skill.hasSkill(unit)
            ? updateUnit(state, {
                  ...unit,
                  skill: skill.setRule(unit.skill, {
                      id: `@effect/${self.id}/sp-recovery`,
                      allowsRecovery: () => false,
                  }),
              })
            : state;
    },
    onDisable(state, { unit, self }) {
        return skill.hasSkill(unit)
            ? updateUnit(state, {
                  ...unit,
                  skill: skill.removeRule(unit.skill, `@effect/${self.id}/sp-recovery`),
              })
            : state;
    },
};
