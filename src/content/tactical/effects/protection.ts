import { updateUnit } from "../../../core/tactical/battle/state.js";
import type { Definition } from "../../../core/tactical/unit/effect/definition.js";
import * as vitality from "../../../core/tactical/unit/capability/vitality/capability.js";
import * as elemental from "../../../core/tactical/unit/capability/elemental/capability.js";
import * as targetable from "../../../core/tactical/unit/capability/targetable/capability.js";
import { untargetableRestriction } from "./visibility.js";

export const invincibilityKind = Symbol("invincibility");

export const healFreeKind = Symbol("heal-free");

export const invincibleRestriction: targetable.Restriction = {
    kind: invincibilityKind,
    allows: untargetableRestriction.allows,
};

export const healFreeRestriction: targetable.Restriction = {
    kind: healFreeKind,
    allows: (_battle, request) => !request.purposes.includes("HEAL"),
};

export const invincible: Definition<object, targetable.Targetable> = {
    id: "protection/invincible",
    initialize: () => ({}),
    onEnable(state, { unit, self }) {
        const id = `@effect/${self.id}/invincible`;

        return updateUnit(state, {
            ...unit,
            targetable: targetable.setRestriction(unit.targetable, {
                id,
                value: invincibleRestriction,
            }),
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
                          allows: () => false,
                      }),
                  }
                : {}),
        });
    },
    onDisable(state, { unit, self }) {
        const id = `@effect/${self.id}/invincible`;

        return updateUnit(state, {
            ...unit,
            targetable: targetable.removeRestriction(unit.targetable, id),
            ...(elemental.hasElemental(unit)
                ? { elemental: elemental.removeRule(unit.elemental, id) }
                : {}),
            ...(vitality.hasVitality(unit)
                ? { vitality: vitality.removeDamageReceptionRule(unit.vitality, id) }
                : {}),
        });
    },
};

export const healFree: Definition<object, targetable.Targetable> = {
    id: "protection/heal-free",
    initialize: () => ({}),
    onEnable(state, { unit, self }) {
        return updateUnit(state, {
            ...unit,
            targetable: targetable.setRestriction(unit.targetable, {
                id: `@effect/${self.id}/heal-free`,
                value: healFreeRestriction,
            }),
        });
    },
    onDisable(state, { unit, self }) {
        return updateUnit(state, {
            ...unit,
            targetable: targetable.removeRestriction(
                unit.targetable,
                `@effect/${self.id}/heal-free`,
            ),
        });
    },
};
