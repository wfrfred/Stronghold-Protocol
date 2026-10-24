import { closeLifetime } from "./lifetime.js";
import type { Id } from "../../unit/unit.js";
import * as units from "../../unit/query.js";
import type { BattlefieldRemovalReason } from "../../battlefield/contract.js";
import * as skills from "../../unit/capability/skill/operations.js";
import { ref as activationRef } from "../../unit/capability/skill/activation.js";
import { hasSkill } from "../../unit/capability/skill/capability.js";
import { cancel as cancelBurst } from "../../unit/capability/elemental/operations.js";
import { ref as burstRef } from "../../unit/capability/elemental/burst.js";
import { hasElemental } from "../../unit/capability/elemental/capability.js";
import { cancelForUnit } from "../../unit/action/operations.js";
import {
    getMechanism,
    getUnit,
    removeUnit,
    updateUnit,
    type State as BattleState,
} from "../state.js";
import { refundUnit, recycleUnitCard } from "../deployment/deployment.js";

export function enter(state: BattleState, unitId: Id): BattleState {
    let unit = getUnit(state, unitId);

    if (unit?.lifecycle === "PRESENT" && hasSkill(unit)) {
        state = skills.enter(state, units.ref(unit));
        unit = getUnit(state, unitId);
    }

    if (unit?.lifecycle === "PRESENT" && unit.definition.onEnter !== undefined) {
        state = unit.definition.onEnter(state, unitId);
    }

    return state;
}

export function advance(battle: BattleState): BattleState {
    const candidates = units.all(battle).map(units.ref).toArray();

    for (const ref of candidates) {
        const self = units.get(battle, ref);

        if (self?.lifecycle === "PRESENT" && self.definition.onTick !== undefined) {
            battle = self.definition.onTick(battle, self);
        }
    }

    return battle;
}

export function leave(
    state: BattleState,
    unitId: Id,
    reason: BattlefieldRemovalReason,
): BattleState {
    const unit = getUnit(state, unitId);

    if (unit === undefined || unit.lifecycle === "LEAVING") {
        return state;
    }

    const lifetime = { type: "UNIT" as const, ref: units.ref(unit) };
    state = updateUnit(state, { ...unit, lifecycle: "LEAVING" });
    const leaving = getUnit(state, unitId);

    if (leaving !== undefined) {
        state = refundUnit(state, leaving, reason, state.tick);
    }

    const current = getUnit(state, unitId);

    if (current !== undefined && hasSkill(current) && current.skill.active !== null) {
        state = skills.cancel(state, activationRef(current.skill.active), reason);
    }

    state = cancelForUnit(state, units.ref(unit), "SOURCE_ABSENT", reason);
    const elementalHost = getUnit(state, unitId);

    if (
        elementalHost !== undefined &&
        hasElemental(elementalHost) &&
        elementalHost.elemental.burst !== null
    ) {
        state = cancelBurst(state, burstRef(elementalHost.elemental.burst), reason);
    }

    state = closeLifetime(state, lifetime, reason);

    const departing = getUnit(state, unitId);
    state = removeUnit(state, unitId, reason);

    if (departing !== undefined) {
        state = recycleUnitCard(state, departing, reason, state.tick);
    }

    const departure = { unit, reason };

    if (unit.definition.onLeave !== undefined) {
        state = unit.definition.onLeave(state, departure);
    }

    const mechanismIds = [...state.mechanisms.keys()];

    for (const mechanismId of mechanismIds) {
        const mechanism = getMechanism(state, mechanismId);

        if (mechanism?.active && mechanism.definition.onUnitLeave !== undefined) {
            state = mechanism.definition.onUnitLeave(state, mechanismId, departure);
        }
    }

    return state;
}
