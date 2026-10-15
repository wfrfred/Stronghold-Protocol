import { closeLifetime } from "./lifetime.js";
import type { Id } from "../../unit/unit.js";
import * as units from "../../unit/query.js";
import type { BattlefieldRemovalReason } from "../../battlefield/contract.js";
import {
    stopSkillActivation,
    notifySkillFinished,
    type SkillExecutionResources,
} from "../../unit/capability/skill/execution.js";
import { cancelForUnit } from "../../unit/action/operations.js";
import {
    getMechanism,
    getUnit,
    removeUnit,
    updateUnit,
    type State as BattleState,
} from "../state.js";
import { emptyCall, type CallContext } from "./call.js";
import { refundUnit, recycleUnitCard } from "../deployment/deployment.js";

export function enterUnits(state: BattleState, unitIds: readonly Id[]): BattleState {
    for (const unitId of unitIds) {
        const unit = getUnit(state, unitId);

        if (unit?.lifecycle === "PRESENT" && unit.definition.onEnter !== undefined) {
            state = unit.definition.onEnter(state, unitId);
        }
    }

    return state;
}

export function advanceUnits(battle: BattleState): BattleState {
    const candidates = units.all(battle);

    for (const ref of candidates) {
        const self = units.get(battle, ref);

        if (self?.lifecycle === "PRESENT" && self.definition.onTick !== undefined) {
            battle = self.definition.onTick(battle, self);
        }
    }

    return battle;
}

export function retireCombatUnit(
    state: BattleState,
    unitId: Id,
    resources: SkillExecutionResources,
    tick: number,
    call: CallContext = emptyCall,
): BattleState {
    return removeUnitWithEffects(state, unitId, "DEATH", resources, tick, call);
}

export function removeUnitWithEffects(
    state: BattleState,
    unitId: Id,
    reason: BattlefieldRemovalReason,
    resources: SkillExecutionResources,
    tick: number,
    call: CallContext = emptyCall,
): BattleState {
    const lifetime = { type: "UNIT" as const, unitId };
    const unit = getUnit(state, unitId);

    if (unit === undefined || unit.lifecycle === "LEAVING") {
        return state;
    }

    state = updateUnit(state, { ...unit, lifecycle: "LEAVING" });
    state = refundUnit(state, unit, reason, tick);
    const stopped = stopSkillActivation(state, unitId, tick, resources);
    state = stopped.state;
    state = cancelForUnit(state, units.ref(unit), "SOURCE_ABSENT", reason);

    if (stopped.value !== null) {
        state = closeLifetime(
            state,
            { type: "SKILL", unitId, activationId: stopped.value.active.id },
            reason,
            call,
        );
    }

    state = closeLifetime(state, lifetime, reason, call);

    if (stopped.value !== null) {
        state = notifySkillFinished(state, stopped.value, tick, call);
    }

    state = removeUnit(state, unitId, reason);
    state = recycleUnitCard(state, unit, reason, tick);
    const departure = { unit, reason };

    if (unit.definition.onLeave !== undefined) {
        state = unit.definition.onLeave(state, departure);
    }

    const mechanismIds = [...state.battlefield.mechanisms.keys()];

    for (const mechanismId of mechanismIds) {
        const mechanism = getMechanism(state, mechanismId);

        if (mechanism?.active && mechanism.definition.onUnitLeave !== undefined) {
            state = mechanism.definition.onUnitLeave(state, mechanismId, departure);
        }
    }

    return state;
}
