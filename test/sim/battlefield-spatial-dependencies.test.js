import { getLostSupports } from '../../dist/core/tactical/battlefield/support/relations.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createTile } from '../../dist/core/tactical/battlefield/map/tile.js';
import { create as createMap } from '../../dist/core/tactical/battlefield/map/navigation.js';
import { create as createNavigation } from '../../dist/core/tactical/battlefield/navigation/state.js';
import { updateBlockingRelations } from '../../dist/core/tactical/battlefield/blocking/relations.js';
import {
  createBattlefieldState, maintain, maintainFully,
} from '../../dist/core/tactical/battlefield/storage/state.js';
import { initialize } from "../helpers/unit.js";
import { createDefinition as createTileBindingDefinition } from '../../dist/core/tactical/unit/capability/tile-binding/capability.js';

function projectionFacts(state) {
  return { ...state, navigation: { baseline: Object.fromEntries(Object.entries(state.navigation.baseline).map(([mode, map]) => [mode, { rows: map.rows, columns: map.columns, cells: map.cells }])), overlays: state.navigation.overlays }, projectiles: state.projectiles.values().toArray(), units: new Map([...state.units].map(([id, unit]) => [
    id, { ...unit, effects: unit.effects.toJSON() },
  ])) };
}

function projectionHarness() {
  const map = createBattlefieldMap(1, 5, Array.from({ length: 5 }, () => createTile({
    heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
    playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null,
  })));
  const navigation = createNavigation({
    WALK: createMap(map, 'WALK'),
    FLY: createMap(map, 'FLY'),
  });
  const branches = [maintain, maintainFully].map(settle => ({
    settle, state: { map, ...createBattlefieldState(map, navigation) },
  }));
  return {
    map,
    get state() { return branches[0].state; },
    commit(transform) {
      const content = transform(branches[0].state);
      const facts = branches.map(branch => {
        const previous = branch.state;
        const snapshot = structuredClone(projectionFacts(previous));
        const settled = branch.settle(previous, content);
        assert.deepEqual(projectionFacts(previous), snapshot, 'settlement must preserve the prior state');
        branch.state = settled;
        return { lostSupports: getLostSupports(previous.supportRelations, settled.supportRelations, settled.units) };
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
const unit = (id, position, definition = {}, states = {}) => initialize({
  id, position, definition: { id: `spatial_dependencies_${id}`, ...definition }, states,
});
const register = units => state => ({ ...state, units: new Map([...state.units, ...units.map(unit => [unit.id, unit])]) });
const update = (id, mutate) => state => ({ ...state, units: new Map([...state.units, [id, mutate(state.units.get(id))]]) });

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
    h.commit(state => ({ ...state, units: new Map([...state.units, ...[provider, supported].map(unit => [unit.id, unit])]), supportRelations: relations }));
    const previous = h.state;
    const facts = h.commit(update(scenario.id, scenario.mutate));
    assert.deepEqual(h.state.supportRelations, []);
    assert.deepEqual(facts.lostSupports, scenario.lost ? relations : []);
    assert.deepEqual(h.state.units.get(scenario.id).position, previous.units.get(scenario.id).position);
    if (scenario.claimsOnly) {
      assert.equal(h.state.spatial.unitsByTile, previous.spatial.unitsByTile);
      assert.notEqual(h.state.spatial.occupancyBySlot, previous.spatial.occupancyBySlot);
    }
    assert.equal(h.state.navigation, previous.navigation);
  });
}

test('support ignores reservation changes while occupancy updates selectively', () => {
  const h = projectionHarness();
  const provider = unit(1, [1, 0], {
    tileBinding: createTileBindingDefinition({ heightType: 'LOWLAND', buildableType: 'ALL' }),
  }, { occupancy: { claims: [claim(1, 'SUPPORT'), claim(3, 'SUPPORT', 'RESERVATION')] } });
  const supported = unit(2, [1, 0], {}, { occupancy: { claims: [claim(1, 'DEPLOYMENT')] } });
  const relations = [{ supportedUnitId: 2, supportUnitId: 1 }];
  h.commit(state => ({ ...state, units: new Map([...state.units, ...[provider, supported].map(unit => [unit.id, unit])]), supportRelations: relations }));
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
    vitality: { maxHp: 100, defense: 0, resistance: 0 }, allegiance: { side: 'ALLY' },
    blocker: { capacity: 1, geometry: { radius: 1 } },
  }, { spatialPresence: { present: true } });
  const blocked = unit(2, [2, 0], {
    vitality: { maxHp: 100, defense: 0, resistance: 0 }, allegiance: { side: 'ENEMY' },
    blockable: { volume: 1 }, layer: { type: 'GROUND' },
  });
  h.commit(state => ({ ...state, units: new Map([...state.units, ...[blocker, blocked].map(unit => [unit.id, unit])]) }));
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
  h.commit(state => ({ ...state, blockingRelations: (state.blockingRelations).filter(relation => relation.blockerUnitId !== 2 && relation.blockedUnitId !== 2) }));
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
    allegiance: { side: 'ENEMY' }, blockable: { volume: 1 },
  });
  h.commit(state => ({ ...state, units: new Map([...state.units, ...[blocker(10, 0), blocked(3), blocker(5, 2), blocked(2)].map(unit => [unit.id, unit])]) }));
  const expected = [
    { blockerUnitId: 5, blockedUnitId: 2 },
    { blockerUnitId: 10, blockedUnitId: 3 },
  ];
  for (const units of [h.state.units, new Map([...h.state.units].reverse())]) {
    assert.deepEqual(updateBlockingRelations(h.map, units, [], h.state.spatial.unitsByTile), expected);
    const retained = [expected[1]];
    assert.deepEqual(updateBlockingRelations(h.map, units, retained, h.state.spatial.unitsByTile), [expected[1], expected[0]]);
  }
  h.commit(state => ({ ...state, blockingRelations: expected }));
  assert.deepEqual(h.state.blockingRelations, expected);
});
