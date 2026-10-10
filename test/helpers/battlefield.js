import { createBattlefieldRuntime } from '../../dist/core/tactical/battlefield/runtime.js';
import { createBattlefieldMap } from '../../dist/core/tactical/battlefield/map/map.js';
import { createTile } from '../../dist/core/tactical/battlefield/map/tile.js';

const tile = createTile({ heightType: 'LOWLAND', buildableType: 'ALL', passableMask: 'ALL',
  playerSideMask: 'ALL', terrain: 'NORMAL', mechanism: null });
const defaultMap = createBattlefieldMap(1, 32, Array(32).fill(tile));

/** Build a real, published battlefield from the entities supplied by a test fixture. */
export function fixtureBattlefield(view, mechanisms = view) {
  if (typeof view.advance === 'function') return view;
  const units = Array.isArray(view) ? view : view.unitIds.map(id => view.getUnit(id));
  const field = createBattlefieldRuntime({ map: Array.isArray(view) ? defaultMap : (view.map ?? defaultMap) }, unit => unit);
  const changes = units.map(unit => ({ type: 'REGISTER_UNIT', unit }));
  for (const id of mechanisms?.mechanismIds ?? []) {
    changes.push({ type: 'REGISTER_MECHANISM', mechanism: mechanisms.getMechanism(id) });
  }
  const relations = view.blockingRelations ?? units.flatMap(unit => {
    const blockerUnitId = view.blockerOf?.(unit.id);
    return blockerUnitId === undefined ? [] : [{ blockerUnitId, blockedUnitId: unit.id }];
  });
  if (relations.length > 0) changes.push({ type: 'SET_BLOCKING_RELATIONS', relations });
  if ((view.supportRelations?.length ?? 0) > 0) changes.push({ type: 'SET_SUPPORT_RELATIONS', relations: view.supportRelations });
  field.advance(changes);
  field.apply();
  return field;
}
