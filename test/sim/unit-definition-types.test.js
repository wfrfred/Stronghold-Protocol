import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('archetype factories retain capability presence and widen only their normalized fields', async () => {
  const { default: ts } = await import('typescript');
  const directory = mkdtempSync(join(tmpdir(), 'stronghold-unit-definition-types-'));
  const sourceModule = name => JSON.stringify(fileURLToPath(new URL(`../../src/core/tactical/${name}.js`, import.meta.url)));
  const positivePath = join(directory, 'positive.mts');
  const negativePath = join(directory, 'negative.mts');
  const declarations = `
import { createOperatorDefinition, initializeOperator, type OperatorDefinition } from ${sourceModule('unit/archetype/operator')};
import { createEnemyDefinition, createCombatEnemyDefinition, type EnemyDefinition, type CombatEnemyDefinition } from ${sourceModule('unit/archetype/enemy')};
import { initializeUnit, type InitializedUnit } from ${sourceModule('unit/initialize')};
import { copyUnitSnapshot } from ${sourceModule('unit/snapshot')};
import { widenUnit, type Unit, type StableUnit } from ${sourceModule('unit/unit')};
import { copyPreparedCapabilityStates, type CopiedCapabilityStates } from ${sourceModule('unit/capability/catalog')};
import type { OffenseDefinition, OffenseState } from ${sourceModule('unit/capability/offense/capability')};
import type { SkillDefinition, SkillState } from ${sourceModule('unit/capability/skill/capability')};
import type { ElementalDefinition, ElementalState } from ${sourceModule('unit/capability/elemental/capability')};
import type { VitalityState } from ${sourceModule('unit/capability/vitality/capability')};
import type { RoutedLocomotionState, RouteControlState } from ${sourceModule('unit/capability/locomotion/capability')};
type OptionalKey = 'offense' | 'skill' | 'elemental';
type OperatorBase = Omit<OperatorDefinition, OptionalKey>;
type CombatEnemyBase = Omit<CombatEnemyDefinition, OptionalKey>;
type EnemyBase = Omit<EnemyDefinition, 'skill' | 'elemental'>;
declare const operatorBase: OperatorBase;
declare const combatEnemyBase: CombatEnemyBase;
declare const enemyBase: EnemyBase;
declare const skillInput: SkillDefinition & { readonly id: 'literal-skill'; readonly initialSp: 0 };
declare const elementalInput: ElementalDefinition & { readonly maxEp: 1000 };
declare const optionalInput: OperatorDefinition;
declare const optionalEnemyInput: EnemyDefinition;
const operator = createOperatorDefinition({ ...operatorBase,
  id: 'literal-operator' as const, vitality: { maxHp: 100 as const },
  offense: { attack: 10 as const }, skill: skillInput, elemental: elementalInput,
  extra: 'discarded' as const,
});
const combatEnemy = createCombatEnemyDefinition({ ...combatEnemyBase,
  offense: { attack: 10 as const }, skill: skillInput, elemental: elementalInput,
  extra: 'discarded' as const,
});
const enemy = createEnemyDefinition({ ...enemyBase, skill: skillInput,
  elemental: elementalInput, extra: 'discarded' as const,
});
const bareOperator = createOperatorDefinition(operatorBase);
const bareCombatEnemy = createCombatEnemyDefinition(combatEnemyBase);
const bareEnemy = createEnemyDefinition(enemyBase);
const optionalOperator = createOperatorDefinition(optionalInput);
const optionalEnemy = createEnemyDefinition(optionalEnemyInput);
const initializedOperator = initializeOperator({ id: 1, definition: operator, position: [0, 0] });
const initializedCombatEnemy = initializeUnit({ id: 2, definition: combatEnemy, position: [0, 0] });
const initializedEnemy = initializeUnit({ id: 3, definition: enemy, position: [0, 0] });
const optionalUnit = initializeOperator({ id: 4, definition: optionalOperator, position: [0, 0] });
type OffensiveDefinition = OperatorBase & { readonly offense: OffenseDefinition };
type SkilledDefinition = OperatorBase & { readonly skill: SkillDefinition };
declare const unionInput: OffensiveDefinition | SkilledDefinition;
const unionDefinition = createOperatorDefinition(unionInput);
const unionUnit = initializeOperator({ id: 5, definition: unionDefinition, position: [0, 0] });
declare const unionEnemyInput: (CombatEnemyBase & { readonly offense: OffenseDefinition }) | (CombatEnemyBase & { readonly elemental: ElementalDefinition });
const unionEnemyDefinition = createCombatEnemyDefinition(unionEnemyInput);
const unionEnemyUnit = initializeUnit({ id: 6, definition: unionEnemyDefinition, position: [0, 0] });
declare const optionalPrepared: { readonly locomotion?: RoutedLocomotionState & { readonly moving: false }; readonly vitality: VitalityState & { readonly hp: 100 }; readonly extra: 'discarded' };
const copiedOptional = copyPreparedCapabilityStates(optionalPrepared);
declare const unionPrepared: { readonly locomotion: RoutedLocomotionState & { readonly moving: false } } | { readonly offense: OffenseState };
const copiedUnion = copyPreparedCapabilityStates(unionPrepared);
declare const routed: RoutedLocomotionState & { readonly moving: false };
const preparedUnit = initializeUnit({ id: 7, definition: combatEnemy, position: [0, 0], states: { locomotion: routed } });
type Narrow = Unit<{ readonly id: 'retained' }> & { readonly id: 8; readonly tag: 'retained'; readonly locomotion?: RoutedLocomotionState & { readonly moving: false }; readonly vitality: VitalityState & { readonly hp: 100 } };
declare const narrow: Narrow;
const widened = widenUnit(narrow);
const snapshot = copyUnitSnapshot(narrow);
`;
  const positive = `
const offenseDefinitions: OffenseDefinition[] = [operator.offense, combatEnemy.offense];
const skillDefinitions: SkillDefinition[] = [operator.skill, combatEnemy.skill, enemy.skill];
const elementalDefinitions: ElementalDefinition[] = [operator.elemental, combatEnemy.elemental, enemy.elemental];
const offenseStates: OffenseState[] = [initializedOperator.offense, initializedCombatEnemy.offense];
const skillStates: SkillState[] = [initializedOperator.skill, initializedCombatEnemy.skill, initializedEnemy.skill];
const elementalStates: ElementalState[] = [initializedOperator.elemental, initializedCombatEnemy.elemental, initializedEnemy.elemental];
const minimumSpeeds: number[] = [enemy.locomotion.minimumMoveSpeedPerTick, combatEnemy.locomotion.minimumMoveSpeedPerTick];
const unionProjection: OffensiveDefinition | SkilledDefinition = unionDefinition;
const unionRuntime: InitializedUnit<OffensiveDefinition> | InitializedUnit<SkilledDefinition> = unionUnit;
const unionEnemyProjection: (CombatEnemyBase & { readonly offense: OffenseDefinition }) | (CombatEnemyBase & { readonly elemental: ElementalDefinition }) = unionEnemyDefinition;
const unionEnemyRuntime: InitializedUnit<CombatEnemyBase & { readonly offense: OffenseDefinition }> | InitializedUnit<CombatEnemyBase & { readonly elemental: ElementalDefinition }> = unionEnemyUnit;
const copiedComposition: { readonly locomotion: RoutedLocomotionState } | { readonly offense: OffenseState } = copiedUnion;
const preparedRoute: RouteControlState = preparedUnit.locomotion.mainRoute;
const requiredHp: number = copiedOptional.vitality.hp;
const stable: StableUnit<Narrow> = widened;
const retainedDefinitionId: 'retained' = widened.definition.id;
const retainedId: 8 = widened.id;
const retainedTag: 'retained' = widened.tag;
if (optionalOperator.offense !== undefined) { const attack: number = optionalOperator.offense.attack; }
if (optionalEnemy.skill !== undefined) { const id: string = optionalEnemy.skill.id; }
if (optionalUnit.skill !== undefined) { const sp: number = optionalUnit.skill.sp; }
if (copiedOptional.locomotion !== undefined) { const route: RouteControlState = copiedOptional.locomotion.mainRoute; }
if (widened.locomotion !== undefined) { const route: RouteControlState = widened.locomotion.mainRoute; }
if (snapshot.locomotion !== undefined) { const route: RouteControlState = snapshot.locomotion.mainRoute; }
type PreparedA = { readonly locomotion?: RoutedLocomotionState };
const optionalCopiedType: CopiedCapabilityStates<PreparedA> = copiedOptional;
`;
  const negatives = [
    "const droppedOperator = operator.extra;",
    "const droppedCombatEnemy = combatEnemy.extra;",
    "const droppedEnemy = enemy.extra;",
    "const staleId: 'literal-operator' = operator.id;",
    "const staleHp: 100 = operator.vitality.maxHp;",
    "const staleAttack: 10 = operator.offense.attack;",
    "const staleSkillId: 'literal-skill' = operator.skill.id;",
    "const staleEp: 1000 = operator.elemental.maxEp;",
    "const absentOperatorOffense = bareOperator.offense;",
    "const absentOperatorSkill = bareOperator.skill;",
    "const absentCombatOffense = bareCombatEnemy.offense;",
    "const absentEnemySkill = bareEnemy.skill;",
    "const absentEnemyElemental = bareEnemy.elemental;",
    "const optionalOffense: OffenseDefinition = optionalOperator.offense;",
    "const optionalSkill: SkillDefinition = optionalEnemy.skill;",
    "const optionalSkillState: SkillState = optionalUnit.skill;",
    "const forcedUnionOffense: OffensiveDefinition = unionDefinition;",
    "const droppedPreparedExtra = copiedOptional.extra;",
    "const staleCopiedHp: 100 = copiedOptional.vitality.hp;",
    "const staleCopiedMove: false = copiedOptional.locomotion!.moving;",
    "const stalePreparedMoving: false = preparedUnit.locomotion.moving;",
    "const staleWidenedHp: 100 = widened.vitality.hp;",
    "const staleWidenedMoving: false = widened.locomotion!.moving;",
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
