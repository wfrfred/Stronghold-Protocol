import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('definition factories return standard shapes while static definitions retain capability composition', async () => {
  const { default: ts } = await import('typescript');
  const directory = mkdtempSync(join(tmpdir(), 'stronghold-unit-definition-types-'));
  const sourceModule = name => JSON.stringify(fileURLToPath(new URL(`../../src/core/tactical/${name}.js`, import.meta.url)));
  const positivePath = join(directory, 'positive.mts');
  const negativePath = join(directory, 'negative.mts');
  const declarations = `
import { createDefinition, initialize, type Definition as OperatorDefinition } from ${sourceModule('unit/archetype/operator')};
import { createDefinition as createEnemyDefinition, createCombatDefinition, type Definition as EnemyDefinition, type CombatDefinition } from ${sourceModule('unit/archetype/enemy')};
import { initialize as initializeUnit } from ${sourceModule('unit/initialize')};
import { copy } from ${sourceModule('unit/snapshot')};
import { hasOffense, type Offense, type Definition as OffenseDefinition, type State as OffenseState } from ${sourceModule('unit/capability/offense/capability')};
import { hasSkill, type Definition as SkillDefinition, type State as SkillState } from ${sourceModule('unit/capability/skill/capability')};
import type { Definition as ElementalDefinition, State as ElementalState } from ${sourceModule('unit/capability/elemental/capability')};
import type { Vitality, State as VitalityState } from ${sourceModule('unit/capability/vitality/capability')};
import type { RoutedLocomotionState, RouteControlState } from ${sourceModule('unit/capability/locomotion/capability')};
import type { Definition } from ${sourceModule('unit/effect/definition')};
import { install } from ${sourceModule('unit/effect/operations')};
import { ref as unitRef } from ${sourceModule('unit/query')};
import type { State as BattleState } from ${sourceModule('battle/state')};
type OptionalKey = 'offense' | 'skill' | 'elemental';
type OperatorBase = Omit<OperatorDefinition, OptionalKey>;
type CombatEnemyBase = Omit<CombatDefinition, OptionalKey>;
type EnemyBase = Omit<EnemyDefinition, 'skill' | 'elemental'>;
declare const operatorBase: OperatorBase;
declare const combatEnemyBase: CombatEnemyBase;
declare const enemyBase: EnemyBase;
declare const skillInput: SkillDefinition;
declare const elementalInput: ElementalDefinition;
declare const battle: BattleState;
const staticOperator = {
  ...operatorBase, offense: { attack: 10 }, skill: skillInput, elemental: elementalInput,
} satisfies OperatorDefinition;
const staticCombatEnemy = {
  ...combatEnemyBase, offense: { attack: 10 }, skill: skillInput, elemental: elementalInput,
} satisfies CombatDefinition;
const staticEnemy = {
  ...enemyBase, skill: skillInput, elemental: elementalInput,
} satisfies EnemyDefinition;
const operator = createDefinition(staticOperator);
const combatEnemy = createCombatDefinition(staticCombatEnemy);
const enemy = createEnemyDefinition(staticEnemy);
const initializedOperator = initialize({ id: 1, definition: operator, position: [0, 0] });
const initializedCombatEnemy = initializeUnit({ id: 2, definition: combatEnemy, position: [0, 0] });
const initializedEnemy = initializeUnit({ id: 3, definition: enemy, position: [0, 0] });
const staticOperatorUnit = initialize({ id: 4, definition: staticOperator, position: [0, 0] });
const staticCombatEnemyUnit = initializeUnit({ id: 5, definition: staticCombatEnemy, position: [0, 0] });
const staticEnemyUnit = initializeUnit({ id: 6, definition: staticEnemy, position: [0, 0] });
const bareOperatorUnit = initialize({ id: 7, definition: operatorBase, position: [0, 0] });
declare const routed: RoutedLocomotionState;
const preparedUnit = initializeUnit({ id: 8, definition: combatEnemy, position: [0, 0], states: { locomotion: routed } });
const snapshot = copy(preparedUnit);
const healthAttack: Definition<{ bonus: number }, Vitality & Offense> = {
  id: 'health-attack',
  initialize: () => ({ bonus: 0 }),
  onEnable(state, context) {
    const hp: number = context.unit.vitality.hp;
    const maxHp: number = context.unit.definition.vitality.maxHp;
    const attack: number = context.unit.definition.offense.attack;
    const offense: OffenseState = context.unit.offense;
    return state;
  },
};
`;
  const positive = `
const standardOperator: OperatorDefinition = operator;
const standardCombatEnemy: CombatDefinition = combatEnemy;
const standardEnemy: EnemyDefinition = enemy;
const offenseDefinitions: OffenseDefinition[] = [staticOperator.offense, staticCombatEnemy.offense];
const offenseStates: OffenseState[] = [staticOperatorUnit.offense, staticCombatEnemyUnit.offense];
const skillStates: SkillState[] = [staticOperatorUnit.skill, staticCombatEnemyUnit.skill, staticEnemyUnit.skill];
const elementalStates: ElementalState[] = [staticOperatorUnit.elemental, staticCombatEnemyUnit.elemental, staticEnemyUnit.elemental];
const vitalityStates: VitalityState[] = [initializedOperator.vitality, initializedCombatEnemy.vitality, initializedEnemy.vitality];
const preparedRoute: RouteControlState = preparedUnit.locomotion.mainRoute;
if (operator.offense !== undefined) { const attack: number = operator.offense.attack; }
if (enemy.skill !== undefined) { const id: string = enemy.skill.id; }
if (hasOffense(initializedOperator)) {
  const attack: number = initializedOperator.definition.offense.attack;
  const offense: OffenseState = initializedOperator.offense;
  install(battle, unitRef(initializedOperator), healthAttack);
}
if (hasSkill(initializedEnemy)) {
  const id: string = initializedEnemy.definition.skill.id;
  const sp: number = initializedEnemy.skill.sp;
}
if (snapshot.locomotion !== undefined) { const route: RouteControlState = snapshot.locomotion.mainRoute; }
install(battle, unitRef(staticOperatorUnit), healthAttack);
`;
  const negatives = [
    "const requiredOperatorOffense: OffenseDefinition = operator.offense;",
    "const requiredCombatOffense: OffenseDefinition = combatEnemy.offense;",
    "const requiredOperatorSkill: SkillDefinition = operator.skill;",
    "const requiredEnemySkill: SkillDefinition = enemy.skill;",
    "const requiredEnemyElemental: ElementalDefinition = enemy.elemental;",
    "const requiredOperatorOffenseState: OffenseState = initializedOperator.offense;",
    "const requiredEnemySkillState: SkillState = initializedEnemy.skill;",
    "install(battle, unitRef(initializedOperator), healthAttack);",
    "install(battle, unitRef(bareOperatorUnit), healthAttack);",
  ];
  try {
    writeFileSync(positivePath, declarations + positive);
    writeFileSync(negativePath, declarations + negatives.join('\n'));
    const program = ts.createProgram([positivePath, negativePath], {
      noEmit: true, strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true, types: [],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    const firstNegativeLine = declarations.split('\n').length - 1;
    assert.deepEqual(diagnostics.map(diagnostic => ({
      path: diagnostic.file?.fileName,
      line: diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start).line,
    })), negatives.map((_, index) => ({ path: negativePath, line: firstNegativeLine + index })),
    diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
const mudrock = initialize({ id: 0, position: [0, 0], definition: mudrockDefinition });
const melantha = initialize({ id: 1, position: [0, 0], definition: melanthaDefinition });
const hound = initialize({ id: 2, position: [0, 0], definition: houndDefinition });
const crossbowman = initialize({ id: 3, position: [0, 0], definition: crossbowmanDefinition });
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
const absent: Unit & Vitality = { ...base, definition: { ...base.definition, vitality: { maxHp: 100 } } };
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
