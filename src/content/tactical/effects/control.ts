import type { Definition } from "../../../core/tactical/unit/effect/definition.js";
import * as skill from "../../../core/tactical/unit/capability/skill/capability.js";
import { read, replace } from "../../../core/tactical/unit/capability/skill/query.js";
import { ref } from "../../../core/tactical/unit/query.js";

export const silence: Definition<object> = {
    id: "control/silence",
    initialize: () => ({}),
    onEnable(state, { unit, self }) {
        return skill.hasSkill(unit)
            ? (read(state, ref(unit), (host) =>
                  replace(state, {
                      ...host,
                      skill: skill.setRule(host.skill, {
                          id: `@effect/${self.id}/silence`,
                          allowsActivation: () => false,
                      }),
                  }),
              ) ?? state)
            : state;
    },
    onDisable(state, { unit, self }) {
        return skill.hasSkill(unit)
            ? (read(state, ref(unit), (host) =>
                  replace(state, {
                      ...host,
                      skill: skill.removeRule(host.skill, `@effect/${self.id}/silence`),
                  }),
              ) ?? state)
            : state;
    },
};

export const blockSpRecovery: Definition<object> = {
    id: "control/block-sp-recovery",
    initialize: () => ({}),
    onEnable(state, { unit, self }) {
        return skill.hasSkill(unit)
            ? (read(state, ref(unit), (host) =>
                  replace(state, {
                      ...host,
                      skill: skill.setRule(host.skill, {
                          id: `@effect/${self.id}/sp-recovery`,
                          allowsRecovery: () => false,
                      }),
                  }),
              ) ?? state)
            : state;
    },
    onDisable(state, { unit, self }) {
        return skill.hasSkill(unit)
            ? (read(state, ref(unit), (host) =>
                  replace(state, {
                      ...host,
                      skill: skill.removeRule(host.skill, `@effect/${self.id}/sp-recovery`),
                  }),
              ) ?? state)
            : state;
    },
};
