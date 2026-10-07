import type { BattlefieldChange, BattlefieldRemovalReason } from "../../battlefield/contract.js";
import type { BattleEvent } from "../contract.js";
import type { BattleExecutionState } from "./state.js";
import type { Unit, UnitId } from "../../unit/unit.js";
import type { CombatTargetingView } from "../../unit/targeting/query.js";

const defaultExecution: BattleExecutionState = Object.freeze({
    rngState: 0,
    nextUnitId: 0,
    nextNavigationRequestId: 0,
    nextMechanismId: 0,
    nextSpatialEffectId: 0,
});

export type CombatUnitLifecycleResult =
    | { readonly type: "CREATED"; readonly unit: Unit }
    | {
          readonly type: "REMOVED";
          readonly unit: Unit;
          readonly reason: BattlefieldRemovalReason;
      };

export interface CombatWork {
    readonly battlefield: CombatTargetingView;
    readonly units: ReadonlyMap<UnitId, Unit>;
    readonly removals: ReadonlyMap<UnitId, BattlefieldRemovalReason>;
    readonly lifecycleResults: readonly CombatUnitLifecycleResult[];
    readonly events: readonly BattleEvent[];
    readonly execution: BattleExecutionState;
}

export interface CombatWorkResult {
    readonly units: readonly Unit[];
    readonly removedUnitIds: readonly UnitId[];
    readonly removals: readonly {
        readonly unitId: UnitId;
        readonly reason: BattlefieldRemovalReason;
    }[];
    readonly lifecycleResults: readonly CombatUnitLifecycleResult[];
    readonly events: readonly BattleEvent[];
    readonly execution: BattleExecutionState;
}

export function createCombatWork(
    battlefield: CombatTargetingView,
    execution: BattleExecutionState = defaultExecution,
): CombatWork {
    return {
        battlefield,
        units: new Map(),
        removals: new Map(),
        lifecycleResults: [],
        events: [],
        execution,
    };
}

export function getCombatUnit(work: CombatWork, id: UnitId): Unit | undefined {
    if (work.removals.has(id)) {
        return undefined;
    }

    return work.units.get(id) ?? work.battlefield.getUnit(id);
}

export function combatWorkView(work: CombatWork): CombatTargetingView {
    let unitIds: readonly UnitId[] | undefined;

    return {
        get unitIds() {
            if (unitIds === undefined) {
                const ids = new Set(work.battlefield.unitIds);

                for (const id of work.units.keys()) {
                    ids.add(id);
                }
                for (const id of work.removals.keys()) {
                    ids.delete(id);
                }

                unitIds = Object.freeze([...ids].sort((left, right) => left - right));
            }

            return unitIds;
        },
        getUnit: (id) => getCombatUnit(work, id),
        blockerOf: (id) => work.battlefield.blockerOf(id),
        blockedBy: (id) => work.battlefield.blockedBy(id),
    };
}

export function updateCombatUnit(work: CombatWork, unit: Unit): CombatWork {
    const current = getCombatUnit(work, unit.id);

    if (current === unit) {
        return work;
    }

    const units = new Map(work.units);
    let removals = work.removals;

    if (work.battlefield.getUnit(unit.id) === unit) {
        units.delete(unit.id);
    } else {
        units.set(unit.id, unit);
    }
    if (removals.has(unit.id)) {
        const nextRemovals = new Map(removals);
        nextRemovals.delete(unit.id);
        removals = nextRemovals;
    }

    return {
        ...work,
        units,
        removals,
        lifecycleResults:
            current === undefined
                ? [...work.lifecycleResults, { type: "CREATED", unit }]
                : work.lifecycleResults,
    };
}

export function registerCombatUnit(work: CombatWork, unit: Unit): CombatWork {
    if (getCombatUnit(work, unit.id) !== undefined) {
        throw new TypeError("combat unit identity is already registered");
    }

    return updateCombatUnit(work, unit);
}

export function transitionCombatUnit(
    work: CombatWork,
    id: UnitId,
    transition: (current: Unit) => Unit,
): CombatWork {
    const current = getCombatUnit(work, id);

    if (current === undefined) {
        return work;
    }

    const next = transition(current);

    if (next.id !== id) {
        throw new TypeError("combat unit transition cannot change identity");
    }

    return updateCombatUnit(work, next);
}

export function removeCombatUnit(
    work: CombatWork,
    id: UnitId,
    reason: BattlefieldRemovalReason = "DEATH",
): CombatWork {
    const unit = getCombatUnit(work, id);

    if (unit === undefined) {
        return work;
    }

    let units = work.units;
    let removals = work.removals;

    if (units.has(id)) {
        const nextUnits = new Map(units);
        nextUnits.delete(id);
        units = nextUnits;
    }
    if (work.battlefield.getUnit(id) !== undefined) {
        const nextRemovals = new Map(removals);
        nextRemovals.set(id, reason);
        removals = nextRemovals;
    }

    return {
        ...work,
        units,
        removals,
        lifecycleResults: [...work.lifecycleResults, { type: "REMOVED", unit, reason }],
    };
}

export function appendCombatEvents(work: CombatWork, events: readonly BattleEvent[]): CombatWork {
    if (events.length === 0) {
        return work;
    }

    return { ...work, events: [...work.events, ...events] };
}

export function withCombatExecution(work: CombatWork, execution: BattleExecutionState): CombatWork {
    return execution === work.execution ? work : { ...work, execution };
}

export function combatWorkChanges(work: CombatWork): readonly BattlefieldChange[] {
    const ids = [...work.units.keys(), ...work.removals.keys()].sort((left, right) => left - right);

    return ids.map((unitId): BattlefieldChange => {
        const unit = work.units.get(unitId);

        if (unit !== undefined) {
            return {
                type:
                    work.battlefield.getUnit(unitId) === undefined
                        ? "REGISTER_UNIT"
                        : "UPDATE_UNIT",
                unit,
            };
        }

        return {
            type: "REMOVE_UNIT",
            unitId,
            reason: work.removals.get(unitId)!,
        };
    });
}

export function combatWorkResult(work: CombatWork): CombatWorkResult {
    const units = [...work.units.values()].sort((left, right) => left.id - right.id);
    const removals = [...work.removals]
        .sort(([left], [right]) => left - right)
        .map(([unitId, reason]) => ({ unitId, reason }));

    return {
        units,
        removedUnitIds: removals.map(({ unitId }) => unitId),
        removals,
        lifecycleResults: work.lifecycleResults,
        events: work.events,
        execution: work.execution,
    };
}
