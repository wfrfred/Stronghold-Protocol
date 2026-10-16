import { updateUnit } from "../../../core/tactical/battle/state.js";
import type { Definition } from "../../../core/tactical/unit/effect/definition.js";
import * as vitality from "../../../core/tactical/unit/capability/vitality/capability.js";
import * as elemental from "../../../core/tactical/unit/capability/elemental/capability.js";
import * as targetable from "../../../core/tactical/unit/capability/targetable/capability.js";

export const invincible: Definition<object> = {
    id: "protection/invincible",
    initialize: () => ({}),
    onEnable(state, { unit, self }) {
        const id = `@effect/${self.id}/invincible`;

        return updateUnit(state, {
            ...unit,
            targetable: targetable.setRule(
                targetable.hasTargetable(unit) ? unit.targetable : targetable.initialize(),
                {
                    id,
                    allows: ({ selector }) =>
                        selector.type !== "DAMAGE" || selector.ignoreTargetFree,
                },
            ),
            ...(elemental.hasElemental(unit)
                ? {
                      elemental: elemental.setRule(unit.elemental, {
                          id,
                          allowsDamage: () => false,
                      }),
                  }
                : {}),
            ...(vitality.hasVitality(unit)
                ? {
                      vitality: vitality.setDamageReceptionRule(unit.vitality, {
                          id,
                          cancel: ({ policy }) =>
                              policy.considerInvincibility
                                  ? { stage: "RECEPTION", reason: "INVINCIBLE" }
                                  : null,
                      }),
                  }
                : {}),
        });
    },
    onDisable(state, { unit, self }) {
        const id = `@effect/${self.id}/invincible`;

        return updateUnit(state, {
            ...unit,
            ...(targetable.hasTargetable(unit)
                ? { targetable: targetable.removeRule(unit.targetable, id) }
                : {}),
            ...(elemental.hasElemental(unit)
                ? { elemental: elemental.removeRule(unit.elemental, id) }
                : {}),
            ...(vitality.hasVitality(unit)
                ? { vitality: vitality.removeDamageReceptionRule(unit.vitality, id) }
                : {}),
        });
    },
};

export const undeadable: Definition<object> = {
    id: "protection/undeadable",
    initialize: () => ({}),
    onEnable(state, { unit, self }) {
        return vitality.hasVitality(unit)
            ? updateUnit(state, {
                  ...unit,
                  vitality: vitality.setFatalProtectionRule(unit.vitality, {
                      id: `@effect/${self.id}/undeadable`,
                      protects: () => true,
                  }),
              })
            : state;
    },
    onDisable(state, { unit, self }) {
        return vitality.hasVitality(unit)
            ? updateUnit(state, {
                  ...unit,
                  vitality: vitality.removeFatalProtectionRule(
                      unit.vitality,
                      `@effect/${self.id}/undeadable`,
                  ),
              })
            : state;
    },
};

export const healFree: Definition<object> = {
    id: "protection/heal-free",
    initialize: () => ({}),
    onEnable(state, { unit, self }) {
        return vitality.hasVitality(unit)
            ? updateUnit(state, {
                  ...unit,
                  vitality: vitality.setHealingReceptionRule(unit.vitality, {
                      id: `@effect/${self.id}/heal-free`,
                      cancel: ({ ignoreHealFree }) =>
                          ignoreHealFree ? null : { reason: "HEAL_FREE" },
                  }),
              })
            : state;
    },
    onDisable(state, { unit, self }) {
        return vitality.hasVitality(unit)
            ? updateUnit(state, {
                  ...unit,
                  vitality: vitality.removeHealingReceptionRule(
                      unit.vitality,
                      `@effect/${self.id}/heal-free`,
                  ),
              })
            : state;
    },
};
