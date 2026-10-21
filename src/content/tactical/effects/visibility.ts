import { updateUnit } from "../../../core/tactical/battle/state.js";
import type { Definition } from "../../../core/tactical/unit/effect/definition.js";
import * as units from "../../../core/tactical/unit/query.js";
import {
    areHostile,
    hasAllegiance,
} from "../../../core/tactical/unit/capability/allegiance/capability.js";
import * as targetable from "../../../core/tactical/unit/capability/targetable/capability.js";

function restriction(
    id: string,
    value: targetable.Restriction,
): Definition<object, targetable.Targetable> {
    return {
        id,
        initialize: () => ({}),
        onEnable(state, { unit, self }) {
            return updateUnit(state, {
                ...unit,
                targetable: targetable.setRestriction(unit.targetable, {
                    id: `@effect/${self.id}/targeting`,
                    value,
                }),
            });
        },
        onDisable(state, { unit, self }) {
            return updateUnit(state, {
                ...unit,
                targetable: targetable.removeRestriction(
                    unit.targetable,
                    `@effect/${self.id}/targeting`,
                ),
            });
        },
    };
}

export const invisibilityKind = Symbol("invisibility");

export const camouflageKind = Symbol("camouflage");

export const untargetableKind = Symbol("untargetable");

export const allyUntargetableKind = Symbol("ally-untargetable");

const allowsSameSide: targetable.Restriction["allows"] = (battle, request, owner) => {
    const source = units.get(battle, request.source);

    return (
        source === undefined ||
        !hasAllegiance(source) ||
        !hasAllegiance(owner) ||
        source.allegiance.side === owner.allegiance.side
    );
};

export const invisibleRestriction: targetable.Restriction = {
    kind: invisibilityKind,
    allows: allowsSameSide,
};

export const camouflageRestriction: targetable.Restriction = {
    kind: camouflageKind,
    allows(battle, request, owner) {
        const source = units.get(battle, request.source);

        return (
            source === undefined ||
            !hasAllegiance(source) ||
            !hasAllegiance(owner) ||
            !areHostile(source, owner)
        );
    },
};

export const untargetableRestriction: targetable.Restriction = {
    kind: untargetableKind,
    allows: allowsSameSide,
};

export const allyUntargetableRestriction: targetable.Restriction = {
    kind: allyUntargetableKind,
    allows(battle, request, owner) {
        const source = units.get(battle, request.source);

        return (
            source === undefined ||
            !hasAllegiance(source) ||
            !hasAllegiance(owner) ||
            source.allegiance.side !== owner.allegiance.side
        );
    },
};

export const invisible = restriction("visibility/invisible", invisibleRestriction);

export const camouflage = restriction("visibility/camouflage", camouflageRestriction);

export const untargetable = restriction("visibility/untargetable", untargetableRestriction);

export const allyUntargetable = restriction(
    "visibility/ally-untargetable",
    allyUntargetableRestriction,
);
