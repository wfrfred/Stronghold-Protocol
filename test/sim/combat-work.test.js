import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    appendCombatEvents,
    combatWorkChanges,
    combatWorkEvents,
    combatWorkResult,
    combatWorkView,
    createCombatWork,
    getCombatUnit,
    removeCombatUnit,
    updateCombatUnit,
    updateCombatUnits,
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

test('combat work: point reads do not enumerate battlefield membership', () => {
    const first = unit(1);
    const second = unit(2);
    const battlefield = {
        ...baseline([second, first]),
        get unitIds() {
            assert.fail('point reads must not enumerate units');
        },
    };
    const moved = { ...second, position: [3, 4] };
    const work = removeCombatUnit(updateCombatUnit(createCombatWork(battlefield), moved), 1);
    const view = combatWorkView(work);

    assert.equal(view.getUnit(2), moved);
    assert.equal(view.getUnit(1), undefined);
    assert.equal(view.getUnit(99), undefined);
    assert.equal(view.blockerOf(2), 1);
    assert.deepEqual(view.blockedBy(1), [2]);
});

test('combat work: lazy membership is reused and agrees with its captured work', () => {
    const first = unit(1);
    const second = unit(2);
    const third = unit(3);
    const battlefield = baseline([third, first, second]);
    const baselineIds = battlefield.unitIds;
    let enumerations = 0;
    Object.defineProperty(battlefield, 'unitIds', {
        get: () => {
            enumerations++;

            return baselineIds;
        },
    });

    const spawned = unit(8);
    const moved = { ...third, position: [5, 5] };
    let work = createCombatWork(battlefield);
    work = updateCombatUnit(work, spawned);
    work = updateCombatUnit(work, moved);
    work = removeCombatUnit(work, 2);
    const view = combatWorkView(work);
    const nextSpawned = unit(9);
    const next = updateCombatUnit(removeCombatUnit(work, 8), nextSpawned);

    assert.equal(enumerations, 0);
    assert.equal(view.getUnit(8), spawned);
    const ids = view.unitIds;

    assert.equal(enumerations, 1);
    assert.equal(view.unitIds, ids);
    assert.equal(enumerations, 1);
    assert.deepEqual(ids, [1, 3, 8]);
    assert.deepEqual(ids.map(id => view.getUnit(id)), [first, moved, spawned]);
    assert.equal(view.getUnit(2), undefined);
    assert.equal(view.getUnit(9), undefined);

    const nextView = combatWorkView(next);

    assert.deepEqual(nextView.unitIds, [1, 3, 9]);
    assert.equal(nextView.getUnit(8), undefined);
    assert.equal(nextView.getUnit(9), nextSpawned);
    assert.equal(enumerations, 2);
    assert.equal(view.unitIds, ids);
});

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
    assert.equal(initial.unitUpdates.size, 0);
    assert.equal(initial.removals.size, 0);
    assert.deepEqual(initial.execution, {
        rngState: 0,
        nextUnitId: 0,
        nextNavigationRequestId: 0,
        nextMechanismId: 0,
        nextNavigationModifierId: 0,
    nextProjectileId: 0,
    });
    assert.equal(Object.isFrozen(initial.execution), true);

    const initialView = combatWorkView(initial);
    const moved = { ...second, position: [3, 4] };
    const updated = updateCombatUnit(initial, moved);
    const removed = removeCombatUnit(updated, 1);
    const view = combatWorkView(removed);

    assert.equal(updated.unitUpdates.size, 1);
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

    assert.equal(restored.unitUpdates.size, 0);
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

    assert.deepEqual(combatWorkEvents(initial), []);
    assert.deepEqual(combatWorkEvents(eventWork), [firstEvent]);
    assert.deepEqual(combatWorkEvents(finalWork), [firstEvent, secondEvent]);
    assert.equal(eventWork.execution, initial.execution);
    assert.equal(executionWork.execution, execution);
    assert.equal(executionWork.unitUpdates, initial.unitUpdates);
    assert.equal(executionWork.removals, initial.removals);
    assert.equal(finalWork.execution, execution);
});


test('combat work: batch updates match sequential transitions and isolate existing branches', () => {
    const first = unit(1);
    const second = unit(2);
    const third = unit(3);
    const initial = createCombatWork(baseline([first, second, third]));
    const before = removeCombatUnit(updateCombatUnit(initial, { ...first, position: [3, 4] }), 2);
    const beforeView = combatWorkView(before);
    const spawned = unit(8);
    const changedSpawned = { ...spawned, position: [6, 7] };
    const updates = [first, second, spawned, changedSpawned, third];
    const sequential = updates.reduce(updateCombatUnit, before);
    const batched = updateCombatUnits(before, updates);

    assert.deepEqual(combatWorkResult(batched), combatWorkResult(sequential));
    assert.deepEqual(combatWorkChanges(batched), combatWorkChanges(sequential));
    assert.deepEqual(batched.lifecycleResults.slice(before.lifecycleResults.length), [
        { type: 'CREATED', unit: second },
        { type: 'CREATED', unit: spawned },
    ]);
    assert.equal(getCombatUnit(batched, 1), first);
    assert.equal(getCombatUnit(batched, 2), second);
    assert.equal(getCombatUnit(batched, 8), changedSpawned);
    assert.equal(beforeView.getUnit(1).position[0], 3);
    assert.equal(beforeView.getUnit(2), undefined);
    assert.equal(beforeView.getUnit(8), undefined);
    assert.equal(initial.unitUpdates.size, 0);
    assert.equal(initial.removals.size, 0);

    const sibling = updateCombatUnits(before, [{ ...third, position: [9, 9] }]);
    assert.equal(getCombatUnit(sibling, 8), undefined);
    assert.equal(getCombatUnit(sibling, 3).position[0], 9);
    assert.equal(getCombatUnit(batched, 3), third);
});

test('combat work: empty and unchanged batches retain the original work without enumerating the world', () => {
    const first = unit(1);
    const battlefield = {
        ...baseline([first]),
        get unitIds() { assert.fail('batch updates must not enumerate the world'); },
    };
    const initial = createCombatWork(battlefield);

    assert.equal(updateCombatUnits(initial, []), initial);
    assert.equal(updateCombatUnits(initial, [first, first]), initial);
});

test('combat work: event branches share immutable history and materialize without recursive traversal', () => {
    const initial = createCombatWork(baseline([]));
    const first = { type: 'ACTION', sourceUnitId: 1, targetUnitId: 2, tick: 0 };
    const leftEvent = { ...first, tick: 1 };
    const rightEvent = { ...first, tick: 2 };
    const prefix = appendCombatEvents(initial, [first]);
    const left = appendCombatEvents(prefix, [leftEvent]);
    const right = appendCombatEvents(prefix, [rightEvent]);
    const prefixEvents = combatWorkEvents(prefix);

    assert.deepEqual(combatWorkEvents(left), [first, leftEvent]);
    assert.deepEqual(combatWorkEvents(right), [first, rightEvent]);
    assert.equal(combatWorkEvents(prefix), prefixEvents);
    assert.throws(() => prefixEvents.push(rightEvent), TypeError);
    assert.deepEqual(combatWorkResult(prefix).events, [first]);
    assert.deepEqual(combatWorkEvents(initial), []);

    let long = initial;
    for (let tick = 0; tick < 20000; tick++) {
        long = appendCombatEvents(long, [{ ...first, tick }]);
    }
    const all = combatWorkResult(long).events;
    assert.equal(all.length, 20000);
    assert.equal(all[0].tick, 0);
    assert.equal(all.at(-1).tick, 19999);
    assert.equal(combatWorkEvents(long), all);
});
