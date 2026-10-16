import { updateUnit } from "../../../core/tactical/battle/state.js";
import type { Definition } from "../../../core/tactical/unit/effect/definition.js";
import * as targetable from "../../../core/tactical/unit/capability/targetable/capability.js";

function restriction(
    id: string,
    allows: targetable.Rule["allows"],
): Definition<object, targetable.Targetable> {
    return {
        id,
        initialize: () => ({}),
        onEnable(state, { unit, self }) {
            return updateUnit(state, {
                ...unit,
                targetable: targetable.setRule(unit.targetable, {
                    id: `@effect/${self.id}/targeting`,
                    allows,
                }),
            });
        },
        onDisable(state, { unit, self }) {
            return updateUnit(state, {
                ...unit,
                targetable: targetable.removeRule(unit.targetable, `@effect/${self.id}/targeting`),
            });
        },
    };
}

export const invisible = restriction(
    "visibility/invisible",
    ({ selector }) =>
        selector.type !== "DAMAGE" || selector.ignoreTargetFree || selector.ignoreInvisible,
);

export const camouflage = restriction(
    "visibility/camouflage",
    ({ selector }) => selector.type !== "DAMAGE",
);

export const untargetable = restriction(
    "visibility/untargetable",
    ({ selector }) => selector.type !== "DAMAGE" || selector.ignoreTargetFree,
);

export const allyUntargetable = restriction(
    "visibility/ally-untargetable",
    ({ selector }) => selector.type !== "HEAL" || selector.ignoreAllyTargetFree,
);
