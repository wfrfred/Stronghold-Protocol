import type { BattlefieldChange, BattlefieldRemovalReason } from "../../battlefield/contract.js";
import type { BattleEvent } from "../contract.js";
import type { BattleExecutionState } from "./state.js";
import type { Unit, UnitId } from "../../unit/unit.js";
import type { CombatTargetingView } from "../../unit/targeting/query.js";
import type { MechanismId, MechanismRuntime, MechanismView } from "../../battlefield/mechanism.js";
import { deriveEffectLifetimeProjection } from "../../unit/capability/effects/lifetime-index.js";

const emptyMechanismView: MechanismView = Object.freeze({
    mechanismIds: [],
    getMechanism: () => undefined,
});

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

export interface CombatEventLog {
    readonly previous: CombatEventLog | null;
    readonly chunk: readonly BattleEvent[];
    readonly length: number;
}

const emptyEvents: readonly BattleEvent[] = Object.freeze([]);
const materializedEvents = new WeakMap<CombatEventLog, readonly BattleEvent[]>();

export interface CombatWork {
    readonly battlefield: CombatTargetingView;
    readonly mechanismView: MechanismView;
    readonly mechanisms: ReadonlyMap<MechanismId, MechanismRuntime>;
    readonly units: ReadonlyMap<UnitId, Unit>;
    readonly removals: ReadonlyMap<UnitId, BattlefieldRemovalReason>;
    readonly lifecycleResults: readonly CombatUnitLifecycleResult[];
    readonly eventLog: CombatEventLog | null;
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
    mechanismView: MechanismView = emptyMechanismView,
): CombatWork {
    return {
        battlefield,
        mechanismView,
        mechanisms: new Map(),
        units: new Map(),
        removals: new Map(),
        lifecycleResults: [],
        eventLog: null,
        execution,
    };
}

export function getCombatMechanism(
    work: CombatWork,
    id: MechanismId,
): MechanismRuntime | undefined {
    return work.mechanisms.get(id) ?? work.mechanismView.getMechanism(id);
}

export function updateCombatMechanism(work: CombatWork, mechanism: MechanismRuntime): CombatWork {
    const current = getCombatMechanism(work, mechanism.id);

    if (current === mechanism) {
        return work;
    }
    if (current !== undefined && current.definition !== mechanism.definition) {
        throw new TypeError("combat mechanism transition cannot change definition");
    }

    const mechanisms = new Map(work.mechanisms);

    if (work.mechanismView.getMechanism(mechanism.id) === mechanism) {
        mechanisms.delete(mechanism.id);
    } else {
        mechanisms.set(mechanism.id, mechanism);
    }

    return { ...work, mechanisms };
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
    return updateCombatUnits(work, [unit]);
}

export function updateCombatUnits(work: CombatWork, updates: readonly Unit[]): CombatWork {
    let units: Map<UnitId, Unit> | undefined;
    let removals: Map<UnitId, BattlefieldRemovalReason> | undefined;
    const transitions: {
        readonly previousUnit: Unit | undefined;
        readonly nextUnit: Unit;
    }[] = [];
    const created: CombatUnitLifecycleResult[] = [];

    for (const unit of updates) {
        const currentRemovals = removals ?? work.removals;
        const baseline = work.battlefield.getUnit(unit.id);
        const current = currentRemovals.has(unit.id)
            ? undefined
            : ((units ?? work.units).get(unit.id) ?? baseline);

        if (current === unit) {
            continue;
        }

        units ??= new Map(work.units);

        if (baseline === unit) {
            units.delete(unit.id);
        } else {
            units.set(unit.id, unit);
        }
        if (currentRemovals.has(unit.id)) {
            removals ??= new Map(work.removals);
            removals.delete(unit.id);
        }
        if (current === undefined) {
            created.push({ type: "CREATED", unit });
        }

        transitions.push({ previousUnit: current, nextUnit: unit });
    }

    if (units === undefined) {
        return work;
    }

    const next: CombatWork = {
        ...work,
        units,
        removals: removals ?? work.removals,
        lifecycleResults:
            created.length === 0 ? work.lifecycleResults : [...work.lifecycleResults, ...created],
    };
    deriveEffectLifetimeProjection(work, next, transitions);

    return next;
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

    const next: CombatWork = {
        ...work,
        units,
        removals,
        lifecycleResults: [...work.lifecycleResults, { type: "REMOVED", unit, reason }],
    };
    deriveEffectLifetimeProjection(work, next, [{ previousUnit: unit, nextUnit: undefined }]);

    return next;
}

export function appendCombatEvents(work: CombatWork, events: readonly BattleEvent[]): CombatWork {
    if (events.length === 0) {
        return work;
    }

    const chunk = Object.freeze([...events]);
    const eventLog = Object.freeze({
        previous: work.eventLog,
        chunk,
        length: (work.eventLog?.length ?? 0) + chunk.length,
    });

    return { ...work, eventLog };
}

export function combatWorkEvents(work: CombatWork): readonly BattleEvent[] {
    if (work.eventLog === null) {
        return emptyEvents;
    }

    const cached = materializedEvents.get(work.eventLog);

    if (cached !== undefined) {
        return cached;
    }

    const events = new Array<BattleEvent>(work.eventLog.length);
    let cursor: CombatEventLog | null = work.eventLog;
    let offset = events.length;

    while (cursor !== null) {
        offset -= cursor.chunk.length;

        for (let index = 0; index < cursor.chunk.length; index++) {
            events[offset + index] = cursor.chunk[index]!;
        }

        cursor = cursor.previous;
    }

    const result = Object.freeze(events);
    materializedEvents.set(work.eventLog, result);

    return result;
}

export function withCombatExecution(work: CombatWork, execution: BattleExecutionState): CombatWork {
    return execution === work.execution ? work : { ...work, execution };
}

export function combatWorkChanges(work: CombatWork): readonly BattlefieldChange[] {
    const ids = [...work.units.keys(), ...work.removals.keys()].sort((left, right) => left - right);

    const changes = ids.map((unitId): BattlefieldChange => {
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

    for (const mechanism of [...work.mechanisms.values()].sort(
        (left, right) => left.id - right.id,
    )) {
        changes.push({
            type:
                work.mechanismView.getMechanism(mechanism.id) === undefined
                    ? "REGISTER_MECHANISM"
                    : "UPDATE_MECHANISM",
            mechanism,
        });
    }

    return changes;
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
        events: combatWorkEvents(work),
        execution: work.execution,
    };
}
