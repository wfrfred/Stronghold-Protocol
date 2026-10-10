import { fixtureBattlefield } from "./battlefield.js";
import { createBattleState, getUnit } from "../../dist/core/tactical/battle/execution/context.js";
import { installEffect } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";

export function effectFixtureWork(...units) {
  const byId = new Map(units.map((unit) => [unit.id, unit]));

  return createBattleState(fixtureBattlefield({
    unitIds: [...byId.keys()],
    getUnit: (id) => byId.get(id),
    blockerOf: () => undefined,
    blockedBy: () => [],
  }));
}

export function installFixtureEffect(unit, instance, resources, tick = 0) {
  const state = effectFixtureWork(unit);
  const installation = installEffect(state, unit.id, instance, resources, tick);

  if (installation.type !== "INSTALLED") {
    throw new TypeError(`fixture effect installation rejected: ${installation.reason}`);
  }

  return getUnit(state, unit.id);
}
