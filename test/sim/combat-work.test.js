import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    appendCombatEvents,
    combatWorkChanges,
    combatWorkResult,
    combatWorkView,
    createCombatWork,
    getCombatUnit,
    removeCombatUnit,
    updateCombatUnit,
    withCombatExecution,
} from '../../dist/core/tactical/battle/execution/work.js';

const unit = (id, position = [0, 0]) => ({
    id,
    definition: { id: `unit-${id}` },
    position,
});

function baseline(units) {
    const byId = new Map(units.map(value => [value.id, value]));

    return {
        unitIds: [...byId.keys()],
        getUnit: id => byId.get(id),
        blockerOf: id => id === 2 ? 1 : undefined,
        blockedBy: id => id === 1 ? [2] : [],
    };
}

test('combat work: sparse updates expose current units while relation queries retain the baseline', () => {
    const first = unit(1);
    const second = unit(2);
    const battlefield = baseline([second, first]);
    let reads = 0;
    const originalGetUnit = battlefield.getUnit;
    battlefield.getUnit = id => {
        reads++;

        return originalGetUnit(id);
    };

    const initial = createCombatWork(battlefield);

    assert.equal(reads, 0);
    assert.equal(initial.battlefield, battlefield);
    assert.equal(initial.units.size, 0);
    assert.equal(initial.removals.size, 0);
    assert.deepEqual(initial.execution, {
        rngState: 0,
        nextUnitId: 0,
        nextNavigationRequestId: 0,
        nextMechanismId: 0,
        nextSpatialEffectId: 0,
    });
    assert.equal(Object.isFrozen(initial.execution), true);

    const initialView = combatWorkView(initial);
    const moved = { ...second, position: [3, 4] };
    const updated = updateCombatUnit(initial, moved);
    const removed = removeCombatUnit(updated, 1);
    const view = combatWorkView(removed);

    assert.equal(updated.units.size, 1);
    assert.equal(updated.removals, initial.removals);
    assert.equal(initialView.getUnit(2), second);
    assert.equal(getCombatUnit(updated, 2), moved);
    assert.equal(getCombatUnit(removed, 1), undefined);
    assert.equal(battlefield.getUnit(1), first);
    assert.equal(battlefield.getUnit(2), second);
    assert.deepEqual(view.unitIds, [2]);
    assert.equal(view.blockerOf(2), 1);
    assert.deepEqual(view.blockedBy(1), [2]);
});

test('combat work: terminal changes are ordered and preserve registration and removal reasons', () => {
    const first = unit(1);
    const second = unit(2);
    const third = unit(3);
    const initial = createCombatWork(baseline([third, first, second]));
    const moved = { ...third, position: [5, 5] };
    const spawned = unit(8);
    let work = updateCombatUnit(initial, spawned);
    work = removeCombatUnit(work, 2, 'SCRIPT');
    work = updateCombatUnit(work, moved);
    work = removeCombatUnit(work, 1, 'DEATH');

    assert.equal(getCombatUnit(work, 8), spawned);
    assert.deepEqual(combatWorkView(work).unitIds, [3, 8]);
    assert.deepEqual(combatWorkChanges(work), [
        { type: 'REMOVE_UNIT', unitId: 1, reason: 'DEATH' },
        { type: 'REMOVE_UNIT', unitId: 2, reason: 'SCRIPT' },
        { type: 'UPDATE_UNIT', unit: moved },
        { type: 'REGISTER_UNIT', unit: spawned },
    ]);
    assert.deepEqual(combatWorkResult(work), {
        units: [moved, spawned],
        removedUnitIds: [1, 2],
        removals: [
            { unitId: 1, reason: 'DEATH' },
            { unitId: 2, reason: 'SCRIPT' },
        ],
        lifecycleResults: [{type: "CREATED", unit:spawned}, {type:"REMOVED",unit:second,reason:"SCRIPT"}, {type:"REMOVED",unit:first,reason:"DEATH"}],
        events: [],
        execution: initial.execution,
    });
});

test('combat work: no-op and reverted changes do not manufacture removals or vitality decisions', () => {
    const first = unit(1);
    const initial = createCombatWork(baseline([first]));

    assert.equal(updateCombatUnit(initial, first), initial);
    assert.equal(removeCombatUnit(initial, 99), initial);
    assert.equal(appendCombatEvents(initial, []), initial);
    assert.equal(withCombatExecution(initial, initial.execution), initial);

    const moved = updateCombatUnit(initial, { ...first, position: [1, 1] });
    const restored = updateCombatUnit(moved, first);

    assert.equal(restored.units.size, 0);
    assert.deepEqual(combatWorkChanges(restored), []);

    const removed = removeCombatUnit(moved, 1);

    assert.equal(removeCombatUnit(removed, 1), removed);
    assert.equal(getCombatUnit(updateCombatUnit(removed, first), 1), first);
    assert.deepEqual(combatWorkChanges(updateCombatUnit(removed, first)), []);

    const spawned = updateCombatUnit(initial, unit(8));
    const discarded = removeCombatUnit(spawned, 8);

    assert.deepEqual(combatWorkChanges(discarded), []);
    assert.deepEqual(combatWorkView(discarded).unitIds, [1]);

    const zeroHp = { ...first, vitality: { hp: 0 } };
    const zeroHpWork = updateCombatUnit(initial, zeroHp);

    assert.equal(getCombatUnit(zeroHpWork, 1), zeroHp);
    assert.deepEqual(combatWorkResult(zeroHpWork).removedUnitIds, []);
});

test('combat work: events and execution changes stay local to their pure branch', () => {
    const initial = createCombatWork(baseline([unit(1)]));
    const firstEvent = { type: 'ACTION', sourceUnitId: 1, targetUnitId: 2, tick: 3 };
    const secondEvent = { type: 'ACTION', sourceUnitId: 1, targetUnitId: 3, tick: 3 };
    const events = [firstEvent];
    const eventWork = appendCombatEvents(initial, events);
    events.push(secondEvent);
    const execution = { ...initial.execution, rngState: 123, nextUnitId: 4 };
    const executionWork = withCombatExecution(eventWork, execution);
    const finalWork = appendCombatEvents(executionWork, [secondEvent]);

    assert.deepEqual(initial.events, []);
    assert.deepEqual(eventWork.events, [firstEvent]);
    assert.deepEqual(finalWork.events, [firstEvent, secondEvent]);
    assert.equal(eventWork.execution, initial.execution);
    assert.equal(executionWork.execution, execution);
    assert.equal(executionWork.units, initial.units);
    assert.equal(executionWork.removals, initial.removals);
    assert.equal(finalWork.execution, execution);
});
