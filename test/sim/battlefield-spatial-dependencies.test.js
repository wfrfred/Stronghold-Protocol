import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createTile } from '../../dist/core/tactical/battlefield/map/tile.js';
import { projectStaticNavigationMap } from '../../dist/core/tactical/battlefield/navigation/projection.js';
import { updateBlockingRelations } from '../../dist/core/tactical/battlefield/blocking/relations.js';
import { applyBattlefieldChanges } from '../../dist/core/tactical/battlefield/storage/changes.js';
import {
  createBattlefieldState, settleBattlefieldState, settleBattlefieldStateFully,
} from '../../dist/core/tactical/battlefield/storage/state.js';
import { initializeUnit } from '../../dist/core/tactical/unit/initialize.js';
import { createTileBindingDefinition } from '../../dist/core/tactical/unit/capability/deployment.js';

function projectionHarness() {
  const map = createBattlefieldMap(1, 5, Array.from({ length: 5 }, () => createTile({
    heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
    playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null,
  })));
  const baseline = Object.freeze({
    WALK: projectStaticNavigationMap(map, 'WALK', 0),
    FLY: projectStaticNavigationMap(map, 'FLY', 0),
  });
  const branches = [settleBattlefieldState, settleBattlefieldStateFully].map(settle => ({
    settle, state: createBattlefieldState(map, baseline),
  }));
  return {
    map,
    get state() { return branches[0].state; },
    commit(changes) {
      const facts = branches.map(branch => {
        const previous = branch.state;
        const snapshot = structuredClone(previous);
        const batch = typeof changes === 'function' ? changes(previous) : changes;
        const applied = applyBattlefieldChanges(previous, batch);
        const settled = branch.settle(map, baseline, previous, applied.content, applied.dependencies);
        assert.deepEqual(previous, snapshot, 'settlement must preserve the prior state');
        branch.state = settled.state;
        return { ...applied.facts, ...settled.facts };
      });
      assert.deepEqual(branches[0].state, branches[1].state);
      for (const key of ['unitsByTile', 'occupancyBySlot']) {
        const entries = state => [...state.spatial[key]].map(([key, ids]) => [key, [...ids]]);
        assert.deepEqual(entries(branches[0].state), entries(branches[1].state));
      }
      assert.deepEqual(facts[0], facts[1]);
      return facts[0];
    },
  };
}

const claim = (column, slot, type = 'PRESENT') => ({ position: [0, column], slot, type });
const unit = (id, position, definition = {}, states = {}) => initializeUnit({
  id, position, definition: { id: `spatial_dependencies_${id}`, ...definition }, states,
});
const register = units => units.map(unit => ({ type: 'REGISTER_UNIT', unit }));
const update = (id, mutate) => state => [{ type: 'UPDATE_UNIT', unit: mutate(state.units.get(id)) }];

const supportCases = [
  {
    name: 'provider leaves spatial presence', id: 1, lost: true,
    mutate: unit => ({ ...unit, spatialPresence: { present: false } }),
  },
  {
    name: 'supported unit leaves spatial presence', id: 2, lost: false,
    mutate: unit => ({ ...unit, spatialPresence: { present: false } }),
  },
  {
    name: 'deployment becomes a reservation', id: 2, lost: true, claimsOnly: true,
    mutate: unit => ({ ...unit, occupancy: { claims: [claim(1, 'DEPLOYMENT', 'RESERVATION')] } }),
  },
  {
    name: 'provider claim moves independently of its world position', id: 1, lost: true, claimsOnly: true,
    mutate: unit => ({ ...unit, occupancy: { claims: [claim(2, 'SUPPORT')] } }),
  },
];

for (const scenario of supportCases) {
  test(`selective and full support projections agree when ${scenario.name}`, () => {
    const h = projectionHarness();
    const provider = unit(1, [1, 0], {
      tileBinding: createTileBindingDefinition({ heightType: 'LOWLAND', buildableType: 'ALL' }),
    }, { spatialPresence: { present: true }, occupancy: { claims: [claim(1, 'SUPPORT')] } });
    const supported = unit(2, [1, 0], {}, {
      spatialPresence: { present: true }, occupancy: { claims: [claim(1, 'DEPLOYMENT')] },
    });
    const relations = [{ supportedUnitId: 2, supportUnitId: 1 }];
    h.commit([...register([provider, supported]), { type: 'SET_SUPPORT_RELATIONS', relations }]);
    const previous = h.state;
    const facts = h.commit(update(scenario.id, scenario.mutate));
    assert.deepEqual(h.state.supportRelations, []);
    assert.deepEqual(facts.lostSupports, scenario.lost ? relations : []);
    assert.deepEqual(h.state.units.get(scenario.id).position, previous.units.get(scenario.id).position);
    if (scenario.claimsOnly) {
      assert.equal(h.state.spatial.unitsByTile, previous.spatial.unitsByTile);
      assert.notEqual(h.state.spatial.occupancyBySlot, previous.spatial.occupancyBySlot);
    }
    assert.equal(h.state.navigationMaps, previous.navigationMaps);
  });
}

test('support ignores reservation changes while occupancy updates selectively', () => {
  const h = projectionHarness();
  const provider = unit(1, [1, 0], {
    tileBinding: createTileBindingDefinition({ heightType: 'LOWLAND', buildableType: 'ALL' }),
  }, { occupancy: { claims: [claim(1, 'SUPPORT'), claim(3, 'SUPPORT', 'RESERVATION')] } });
  const supported = unit(2, [1, 0], {}, { occupancy: { claims: [claim(1, 'DEPLOYMENT')] } });
  const relations = [{ supportedUnitId: 2, supportUnitId: 1 }];
  h.commit([...register([provider, supported]), { type: 'SET_SUPPORT_RELATIONS', relations }]);
  const previous = h.state;
  const facts = h.commit(update(1, unit => ({
    ...unit, occupancy: { claims: [claim(1, 'SUPPORT'), claim(4, 'SUPPORT', 'RESERVATION')] },
  })));
  assert.equal(h.state.supportRelations, previous.supportRelations);
  assert.deepEqual(facts.lostSupports, []);
  assert.equal(h.state.spatial.unitsByTile, previous.spatial.unitsByTile);
  assert.deepEqual([...h.state.spatial.occupancyBySlot.get('4:SUPPORT')], [1]);
  assert.equal(h.state.spatial.occupancyBySlot.has('3:SUPPORT'), false);
});

function blockingHarness() {
  const h = projectionHarness();
  const blocker = unit(1, [1, 0], {
    vitality: { maxHp: 100 }, allegiance: { side: 'ALLY' },
    blocker: { capacity: 1, geometry: { radius: 1 } },
  }, { spatialPresence: { present: true } });
  const blocked = unit(2, [2, 0], {
    vitality: { maxHp: 100 }, allegiance: { side: 'ENEMY' },
    blockable: { weight: 1 }, spatial: { layer: 'GROUND' },
  });
  h.commit(register([blocker, blocked]));
  assert.deepEqual(h.state.blockingRelations, [{ blockerUnitId: 1, blockedUnitId: 2 }]);
  return h;
}

test('blocking retains existing relations beyond acquisition radius and acquires automatically after movement', () => {
  const h = blockingHarness();
  const previous = h.state;
  h.commit(update(1, unit => ({
    ...unit, vitality: { ...unit.vitality, hp: 50 },
    blocker: { ...unit.blocker, geometry: { radius: 0 } },
  })));
  assert.equal(h.state.blockingRelations, previous.blockingRelations);
  assert.equal(h.state.spatial, previous.spatial);
  h.commit(update(2, unit => ({ ...unit, position: [4, 0] })));
  assert.equal(h.state.blockingRelations, previous.blockingRelations);
  assert.deepEqual(updateBlockingRelations(h.map, h.state.units, [], h.state.spatial.unitsByTile), []);
  h.commit([{ type: 'RELEASE_BLOCKING_RELATIONS', unitId: 2 }]);
  h.commit(update(2, unit => ({ ...unit, position: [1, 0] })));
  assert.deepEqual(h.state.blockingRelations, previous.blockingRelations);
  assert.deepEqual(updateBlockingRelations(h.map, h.state.units, [], h.state.spatial.unitsByTile), previous.blockingRelations);
});

for (const [name, mutate] of [
  ['dies', unit => ({ ...unit, vitality: { ...unit.vitality, hp: 0 } })],
  ['leaves spatial presence', unit => ({ ...unit, spatialPresence: { present: false } })],
]) {
  test(`selective and full blocking projections release relations when the blocker ${name}`, () => {
    const h = blockingHarness();
    h.commit(update(1, mutate));
    assert.deepEqual(h.state.blockingRelations, []);
    assert.deepEqual(updateBlockingRelations(h.map, h.state.units, [], h.state.spatial.unitsByTile), []);
  });
}

test('blocking acquisition preserves unit ID tie breaks, capacity and retained relation order', () => {
  const h = projectionHarness();
  const blocker = (id, column) => unit(id, [column, 0], {
    allegiance: { side: 'ALLY' }, blocker: { capacity: 1, geometry: { radius: 1 } },
  });
  const blocked = id => unit(id, [1, 0], {
    allegiance: { side: 'ENEMY' }, blockable: { weight: 1 },
  });
  h.commit(register([blocker(10, 0), blocked(3), blocker(5, 2), blocked(2)]));
  const expected = [
    { blockerUnitId: 5, blockedUnitId: 2 },
    { blockerUnitId: 10, blockedUnitId: 3 },
  ];
  for (const units of [h.state.units, new Map([...h.state.units].reverse())]) {
    assert.deepEqual(updateBlockingRelations(h.map, units, [], h.state.spatial.unitsByTile), expected);
    const retained = [expected[1]];
    assert.deepEqual(updateBlockingRelations(h.map, units, retained, h.state.spatial.unitsByTile), [expected[1], expected[0]]);
  }
  h.commit([{ type: 'SET_BLOCKING_RELATIONS', relations: expected }]);
  assert.deepEqual(h.state.blockingRelations, expected);
});
