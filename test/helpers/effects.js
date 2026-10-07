import { createCombatWork, getCombatUnit } from "../../dist/core/tactical/battle/execution/work.js";
import { installEffect } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";

export function effectFixtureWork(...units) {
  const byId = new Map(units.map((unit) => [unit.id, unit]));

  return createCombatWork({
    unitIds: [...byId.keys()],
    getUnit: (id) => byId.get(id),
    blockerOf: () => undefined,
    blockedBy: () => [],
  });
}

export function installFixtureEffect(unit, instance, resources, tick = 0) {
  const installation = installEffect(effectFixtureWork(unit), unit.id, instance, resources, tick);

  if (installation.result.type !== "INSTALLED") {
    throw new TypeError(`fixture effect installation rejected: ${installation.result.reason}`);
  }

  return getCombatUnit(installation.work, unit.id);
}
