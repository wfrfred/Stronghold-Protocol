import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('Unit initialization derives capability pairs directly from the supplied definition', async () => {
  const { default: ts } = await import('typescript');
  const directory = mkdtempSync(join(tmpdir(), 'stronghold-unit-definition-types-'));
  const source = name => JSON.stringify(fileURLToPath(new URL(`../../src/core/tactical/${name}.js`, import.meta.url)));
  const path = join(directory, 'definition.mts');
  writeFileSync(path, `
import type { Unit, Definition as UnitDefinition } from ${source('unit/unit')};
import type { Definitions, Product } from ${source('unit/capability/catalog')};
import { initialize } from ${source('unit/initialize')};
import { copy } from ${source('unit/snapshot')};
import { hasOffense, type Offense } from ${source('unit/capability/offense/capability')};
import { hasSkill, type Definition as SkillDefinition, type Skill } from ${source('unit/capability/skill/capability')};
import type { Vitality } from ${source('unit/capability/vitality/capability')};
import type { Route, Definition as RouteDefinition } from ${source('unit/capability/route/capability')};
import type { Elemental } from ${source('unit/capability/elemental/capability')};
import type { Definition as EffectDefinition } from ${source('unit/effect/definition')};
import { install } from ${source('unit/effect/operations')};
import { ref, get } from ${source('unit/query')};
import { initialize as initializeRoutedUnit } from ${source('battle/creation/routed-unit')};
import type { EnemySpawnDefinition } from ${source('battle/schedule/definition')};
import type { Input as RouteInput } from ${source('battle/creation/route')};
import type { State as BattleState } from ${source('battle/state')};
type Configuration = UnitDefinition & Pick<Definitions, 'vitality'> &
  Partial<Pick<Definitions, 'offense' | 'skill' | 'elemental'>>;
declare const configuration: Configuration;
declare const skill: SkillDefinition;
declare const elemental: Definitions['elemental'];
declare const battle: BattleState;
declare const route: RouteDefinition;
declare const routeInput: RouteInput;
const selected = { ...configuration, offense: { attack: 10 }, skill, elemental } satisfies Configuration;
const plain = initialize(battle, { id: 0, definition: configuration, position: [0, 0] }).value;
const complete = initialize(battle, { id: 1, definition: selected, position: [0, 0] }).value;
const bare = initialize(battle, { id: 2, definition: { id: 'bare' }, position: [0, 0] }).value;
const routed = initialize(battle, { id: 3, definition: { ...selected, route }, position: [0, 0] }).value;
const paired: Unit & Vitality & Offense & Skill & Elemental = complete;
const captured: Unit & Vitality & Offense & Skill & Elemental & Route = copy(routed);
const generic = <D extends UnitDefinition & Partial<Definitions>>(definition: D): Unit & Product<D> =>
  initialize(battle, { id: 4, definition, position: [0, 0] }).value;
const genericComplete: Unit & Vitality & Offense & Skill & Elemental = generic(selected);
const spawned = initializeRoutedUnit(battle, {
  id: 5, definition: { id: 'route-only' }, route: routeInput,
  timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 }, alwaysCheckCurrentPoint: true,
}).value;
const routeOnly: Unit & Route = spawned;
const scheduled: EnemySpawnDefinition = {
  definition: { id: 'route-only' }, route: routeInput,
  alwaysCheckCurrentPoint: true, notCountInTotal: false,
};
const healthAttack: EffectDefinition<{ bonus: number }, Vitality & Offense> = {
  id: 'health-attack', initialize: () => ({ bonus: 0 }),
  onEnable(state, self) {
    const current = get(state, self.host)!;
    const hp: number = current.vitality.hp;
    const attack: number = current.definition.offense.attack;
    return state;
  },
};
install(battle, ref(complete), healthAttack);
if (hasOffense(plain)) install(battle, ref(plain), healthAttack);
if (hasSkill(plain)) {
  const id: string = plain.definition.skill.id;
  const sp: number = plain.skill.sp?.value ?? 0;
}
// @ts-expect-error optional configuration is not proof of an installed Capability.
plain.offense;
// @ts-expect-error optional configuration does not expose Skill State.
plain.skill;
// @ts-expect-error a plain Unit has no default Vitality.
bare.vitality;
// @ts-expect-error a plain Unit has no default Allegiance.
bare.allegiance;
// @ts-expect-error no implicit Capability is added to a route-only spawn.
spawned.locomotion;
// @ts-expect-error route initialization does not require or install Vitality.
spawned.vitality;
// @ts-expect-error spatial presence is explicit content configuration.
spawned.spatialPresence;
// @ts-expect-error the host must prove both required capabilities.
install(battle, ref(plain), healthAttack);
// @ts-expect-error arbitrary Capability values are rejected at the Unit initialization entry.
initialize(battle, { id: 6, definition: { id: 'invalid', vitality: { maxHp: 'wrong', defense: 0, resistance: 0 } }, position: [0, 0] });
`);
  try {
    const program = ts.createProgram([path], {
      noEmit: true, strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true, types: [],
    });
    assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('base Unit has common fields while concrete content and guards provide capability pairs', async () => {
  const { default: ts } = await import('typescript');
  const directory = mkdtempSync(join(tmpdir(), 'stronghold-content-unit-types-'));
  const source = name => JSON.stringify(fileURLToPath(new URL(`../../src/${name}.js`, import.meta.url)));
  const path = join(directory, 'content.mts');
  writeFileSync(path, `
import type { Unit } from ${source('core/tactical/unit/unit')};
import { initialize } from ${source('core/tactical/unit/initialize')};
import { copy } from ${source('core/tactical/unit/snapshot')};
import { updateUnit, type State as BattleState } from ${source('core/tactical/battle/state')};
import { hasVitality, type Vitality } from ${source('core/tactical/unit/capability/vitality/capability')};
import type { Offense } from ${source('core/tactical/unit/capability/offense/capability')};
import type { Definition as MudrockDefinition } from ${source('content/tactical/operators/mudrock')};
import type { Definition as MelanthaDefinition } from ${source('content/tactical/operators/melantha')};
import type { Definition as HoundDefinition } from ${source('content/tactical/enemies/hound')};
import type { Definition as CrossbowmanDefinition } from ${source('content/tactical/enemies/crossbowman')};
declare const mudrockDefinition: MudrockDefinition;
declare const melanthaDefinition: MelanthaDefinition;
declare const houndDefinition: HoundDefinition;
declare const crossbowmanDefinition: CrossbowmanDefinition;
declare const battle: BattleState;
declare const base: Unit;
const mudrock = initialize(battle, { id: 0, position: [0, 0], definition: mudrockDefinition }).value;
const melantha = initialize(battle, { id: 1, position: [0, 0], definition: melanthaDefinition }).value;
const hound = initialize(battle, { id: 2, position: [0, 0], definition: houndDefinition }).value;
const crossbowman = initialize(battle, { id: 3, position: [0, 0], definition: crossbowmanDefinition }).value;
const armed: readonly (Unit & Vitality & Offense)[] = [mudrock, melantha, hound, crossbowman];
const next = { ...mudrock, vitality: { ...mudrock.vitality, hp: mudrock.vitality.hp - 1 } };
updateUnit(battle, next);
updateUnit(battle, { ...mudrock, vitality: next.vitality });
const captured = copy(mudrock);
const paired: Unit & Vitality & Offense = captured;
const attack: number = captured.definition.offense.attack;
const hp: number = captured.vitality.hp;
if (hasVitality(base)) {
  const maxHp: number = base.definition.vitality.maxHp;
  const currentHp: number = base.vitality.hp;
}
// @ts-expect-error base Unit does not declare optional capability state.
base.vitality;
// @ts-expect-error guards are required after heterogeneous lookup.
base.definition.vitality;
// @ts-expect-error these operators do not declare locomotion.
mudrock.locomotion;
// @ts-expect-error these enemies do not declare skill.
hound.skill;
// @ts-expect-error a selected Capability requires its configuration and state together.
const incomplete: Unit & Vitality = { ...base, vitality: mudrock.vitality };
// @ts-expect-error a selected Capability cannot omit its runtime state.
const absent: Unit & Vitality = { ...base, definition: { ...base.definition, vitality: { maxHp: 100, defense: 0, resistance: 0 } } };
`);
  try {
    const program = ts.createProgram([path], {
      noEmit: true, strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true, types: [],
    });
    assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
