import { view } from "../../dist/core/tactical/battlefield/view.js";
import { all as supports, lost } from '../../dist/core/tactical/battlefield/support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createTile } from '../../dist/core/tactical/battlefield/map/tile.js';
import { create as createMap } from '../../dist/core/tactical/battlefield/map/navigation.js';
import { create as createNavigation } from '../../dist/core/tactical/battlefield/navigation/state.js';
import {
  createBattlefieldState, maintain,
} from '../../dist/core/tactical/battlefield/storage/state.js';
import { maintainFully } from '../helpers/battlefield-projection.js';
import { initialize } from "../helpers/unit.js";
import { createDefinition as createTileBindingDefinition } from '../../dist/core/tactical/unit/capability/tile-binding/capability.js';

function projectionFacts(state) {
  return { ...state, navigation: { baseline: Object.fromEntries(Object.entries(state.navigation.baseline).map(([mode, map]) => [mode, { rows: map.rows, columns: map.columns, cells: map.cells }])), overlays: state.navigation.overlays }, projectiles: state.projectiles.values().toArray(), units: new Map([...state.units].map(([id, unit]) => [
    id, { ...unit, effects: unit.effects.toJSON() },
  ])) };
}

function projectionHarness() {
  const map = createBattlefieldMap(1, 5, Array.from({ length: 5 }, () => createTile({
    heightType: 'LOWLAND', meleeBlockable: true, buildableType: 'ALL', passableMask: 'ALL',
    playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null,
  })));
  const navigation = createNavigation({
    WALK: createMap(map, 'WALK'),
    FLY: createMap(map, 'FLY'),
  });
  const branches = [maintain, maintainFully].map(settle => ({
    settle, state: { map, ...createBattlefieldState(navigation) },
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
        return { lostSupports: lost(previous, settled).map(relation => ({ supportedUnitId: relation.occupant.id, supportUnitId: relation.support.id })) };
      });
      assert.deepEqual(branches[0].state, branches[1].state);
      for (let column = 0; column < map.columns; column++) {
        assert.deepEqual(view(branches[0].state).unitsAt([0, column]), view(branches[1].state).unitsAt([0, column]));
      }
      assert.deepEqual(facts[0], facts[1]);
      return facts[0];
    },
  };
}

const registration = (column, slot) => ({ tile: [0, column], slot });
const unit = (id, position, definition = {}, states = {}) => initialize({
  id, position, definition: { id: `spatial_dependencies_${id}`, ...definition }, states,
});
const register = units => state => ({ ...state, units: new Map([...state.units, ...units.map(unit => [unit.id, unit])]) });
const update = (id, mutate) => state => ({ ...state, units: new Map([...state.units, [id, mutate(state.units.get(id))]]) });

const supportCases = [
  {
    name: 'provider leaves spatial presence', id: 1, lost: false,
    mutate: unit => ({ ...unit, spatialPresence: { present: false } }),
  },
  {
    name: 'supported unit leaves spatial presence', id: 2, lost: false,
    mutate: unit => ({ ...unit, spatialPresence: { present: false } }),
  },
  {
    name: 'occupant clears registration', id: 2, lost: true, registrationOnly: true,
    mutate: unit => ({ ...unit, occupancy: { registration: null } }),
  },
  {
    name: 'provider registration moves independently of its world position', id: 1, lost: true, registrationOnly: true,
    mutate: unit => ({ ...unit, occupancy: { registration: registration(2, 'SUPPORT') } }),
  },
];

for (const scenario of supportCases) {
  test(`selective and full support projections agree when ${scenario.name}`, () => {
    const h = projectionHarness();
    const provider = unit(1, [1, 0], {
      tileBinding: createTileBindingDefinition({ heightType: 'LOWLAND', buildableType: 'ALL' }),
    }, { spatialPresence: { present: true }, occupancy: { registration: registration(1, 'SUPPORT') } });
    const supported = unit(2, [1, 0], {}, {
      spatialPresence: { present: true }, occupancy: { registration: registration(1, 'OCCUPANT') },
    });
    const relations = [{ supportedUnitId: 2, supportUnitId: 1 }];
    h.commit(register([provider, supported]));
    const previous = h.state;
    const facts = h.commit(update(scenario.id, scenario.mutate));
    assert.equal(supports(h.state).length, scenario.lost ? 0 : 1);
    assert.deepEqual(facts.lostSupports, scenario.lost ? relations : []);
    assert.deepEqual(h.state.units.get(scenario.id).position, previous.units.get(scenario.id).position);
    if (scenario.registrationOnly) {
      assert.deepEqual(view(h.state).unitsAt([0, 1]).map(unit => unit.id), view(previous).unitsAt([0, 1]).map(unit => unit.id));
      assert.notEqual(h.state.occupancy, previous.occupancy);
    } else {
      assert.equal(h.state.occupancy, previous.occupancy);
    }
    assert.deepEqual(view(previous).unitsAt([0, 1]).map(unit => unit.id), [1, 2]);
    assert.deepEqual(view(h.state).unitsAt([0, 1]).map(unit => unit.id), scenario.registrationOnly ? [1, 2] : [1, 2].filter(id => id !== scenario.id));
    assert.equal(h.state.navigation, previous.navigation);
  });
}

test('equivalent registration values preserve occupancy indexes and relation facts', () => {
  const h = projectionHarness();
  const provider = unit(1, [1, 0], {
    tileBinding: createTileBindingDefinition({ heightType: 'LOWLAND', buildableType: 'ALL' }),
  }, { occupancy: { registration: registration(1, 'SUPPORT') } });
  const supported = unit(2, [1, 0], {}, { occupancy: { registration: registration(1, 'OCCUPANT') } });
  h.commit(register([provider, supported]));
  const previous = h.state;
  const facts = h.commit(update(1, unit => ({
    ...unit, occupancy: { registration: registration(1, 'SUPPORT') },
  })));
  assert.deepEqual(facts.lostSupports, []);
  assert.deepEqual(view(h.state).unitsAt([0, 1]).map(unit => unit.id), view(previous).unitsAt([0, 1]).map(unit => unit.id));
  assert.equal(h.state.occupancy, previous.occupancy);
  assert.equal(h.state.occupancy.get(1).support, previous.occupancy.get(1).support);
});

test('Field unit updates preserve spatial queries without acquiring or owning blocking relations', () => {
  const h = projectionHarness();
  const blocker = unit(1, [1, 0], {
    vitality: { maxHp: 100, defense: 0, resistance: 0 }, allegiance: { side: 'ALLY' },
    blocker: { capacity: 1, geometry: { radius: 1 } },
  }, { spatialPresence: { present: true } });
  const target = unit(2, [2, 0], {
    vitality: { maxHp: 100, defense: 0, resistance: 0 }, allegiance: { side: 'ENEMY' },
    blockable: { volume: 1 }, layer: { type: 'GROUND' },
  });
  h.commit(register([blocker, target]));
  assert.equal('blockingRelations' in h.state, false);
  assert.deepEqual(h.state.units.get(1).blocker.blocked, []);
  assert.equal(h.state.units.get(2).blockable.blocker, null);
  h.commit(update(2, unit => ({ ...unit, position: [1.25, 0] })));
  assert.equal(h.state.units.get(2).blockable.blocker, null);
  assert.deepEqual(h.state.units.get(1).blocker.blocked, []);
  assert.deepEqual(view(h.state).unitsAt([0, 1]).map(unit => unit.id), [1, 2]);
});
