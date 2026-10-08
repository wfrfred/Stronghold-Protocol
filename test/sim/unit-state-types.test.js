import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('unit transitions preserve structure while widening managed runtime state', async () => {
  const { default: ts } = await import('typescript');
  const directory = mkdtempSync(join(tmpdir(), 'stronghold-unit-state-types-'));
  const sourceModule = name => JSON.stringify(fileURLToPath(new URL(`../../src/core/tactical/${name}.js`, import.meta.url)));
  const positivePath = join(directory, 'positive.mts');
  const negativePath = join(directory, 'negative.mts');
  const declarations = `
import type { Unit, StableUnit } from ${sourceModule('unit/unit')};
import { copyUnitSnapshot, type UnitSnapshot } from ${sourceModule('unit/snapshot')};
import { initializeUnit } from ${sourceModule('unit/initialize')};
import { reconcileUnitNavigation } from ${sourceModule('unit/capability/locomotion/navigation')};
import { stepRoutedUnit, type RoutedLocomotionStepContext } from ${sourceModule('unit/capability/locomotion/step')};
import type { LocomotiveUnitDefinition, RoutedLocomotionState, RouteControlState } from ${sourceModule('unit/capability/locomotion/capability')};
import type { NavigationState, NavigationExecution, NavigationActivity } from ${sourceModule('battlefield/navigation/state')};
import type { NavigationMaps } from ${sourceModule('battlefield/navigation/map')};
import type { BattlefieldMap } from ${sourceModule('battlefield/map/map')};
import { BattlefieldRuntime, createBattlefieldRuntime } from ${sourceModule('battlefield/runtime')};
import { settleBattlefieldState, settleBattlefieldStateFully, type BattlefieldState } from ${sourceModule('battlefield/storage/state')};
import { applyBattlefieldChanges } from ${sourceModule('battlefield/storage/changes')};
import type { BattlefieldDependencyChanges } from ${sourceModule('battlefield/storage/dependencies')};
import { updateMaxHpContributions, type VitalityState, type VitalUnitDefinition } from ${sourceModule('unit/capability/vitality/capability')};
import { updateAttackContributions, type OffenseState, type OffensiveUnitDefinition } from ${sourceModule('unit/capability/offense/capability')};
import { updateDefenseContributions, updateResistanceContributions, type DefenseState, type DefendedUnitDefinition } from ${sourceModule('unit/capability/defense/capability')};
import type { StatusState, StatusUnitDefinition } from ${sourceModule('unit/capability/status/capability')};
import { compileStatusBinding } from ${sourceModule('unit/capability/status/binding')};
import { preserveHpRatio } from ${sourceModule('unit/capability/vitality/max-hp')};
import { damageUnit } from ${sourceModule('unit/capability/vitality/damage/settlement')};
import { healUnit } from ${sourceModule('unit/capability/vitality/healing/settlement')};
import type * as contribution from ${sourceModule('modifier/contribution')};
import type { ContributionTarget } from ${sourceModule('unit/capability/contribution')};
import type { EffectInstance, EffectInstanceValue, EffectLifecycleFacts } from ${sourceModule('unit/capability/effects/instance')};
import type { EffectsState } from ${sourceModule('unit/capability/effects/capability')};
import { registerEffectInstance, removeEffectInstance, replaceEffectInstances } from ${sourceModule('unit/capability/effects/internal/state')};
import { withEffectLifecycle } from ${sourceModule('unit/capability/effects/internal/instance')};
import { compileStoredBinding } from ${sourceModule('unit/capability/effects/binding')};
import { transitionEffectBindings } from ${sourceModule('unit/capability/effects/transition')};
import type { EffectBindings } from ${sourceModule('unit/capability/effects/resources')};
type Definition = LocomotiveUnitDefinition & VitalUnitDefinition & OffensiveUnitDefinition & DefendedUnitDefinition & StatusUnitDefinition & { readonly id: 'stable-definition' };
type Following = Extract<NavigationActivity, { readonly type: 'FOLLOWING' }>;
type Narrow = Unit<Definition> & {
  readonly id: 1;
  readonly tag: 'kept';
  readonly position: readonly [0, 0];
  readonly vitality: VitalityState & { readonly hp: 100 };
  readonly offense: OffenseState & { readonly attack: contribution.State & { readonly entries: readonly [] } };
  readonly defense: DefenseState;
  readonly status: StatusState & { readonly contributions: readonly [] };
  readonly effects: EffectsState & { readonly instances: readonly []; readonly nextInstanceId: 0 };
  readonly locomotion: RoutedLocomotionState & {
    readonly moving: false;
    readonly alternativeRoute: null;
    readonly mainRoute: RouteControlState & {
      readonly navigation: NavigationState & {
        readonly execution: NavigationExecution & { readonly activity: Following };
      };
    };
  };
};
declare const narrow: Narrow;
declare const map: BattlefieldMap;
declare const maps: NavigationMaps;
declare const previous: BattlefieldState<Narrow>;
declare const dependencies: BattlefieldDependencyChanges;
declare const transition: contribution.Transition;
declare const maxHpTransition: contribution.Transition<'stored'>;
declare const movementContext: RoutedLocomotionStepContext;
declare const instance: EffectInstanceValue;
declare const bindings: EffectBindings;
declare const fresh: EffectInstance<{ readonly strength: 5 }> & { readonly id: 10; readonly started: false; readonly participating: false; readonly finished: false; readonly parent: null };
const reconciled = reconcileUnitNavigation(narrow, maps);
const moved = stepRoutedUnit(narrow, movementContext).unit;
const copied = copyUnitSnapshot(narrow);
const custom = BattlefieldRuntime.create<Narrow>({ map }, value => ({ ...value }));
custom.apply([{ type: 'REGISTER_UNIT', unit: narrow }]);
custom.apply([{ type: 'SET_POSITION_AND_RELEASE_BLOCKING', unitId: 1, position: [1, 1] }]);
const stored = custom.getUnit(1)!;
const viewed = custom.view.getUnit(1)!;
const forked = custom.fork().getUnit(1)!;
const removed = custom.apply([{ type: 'REMOVE_UNIT', unitId: 1, reason: 'SCRIPT' }]).removedUnits[0]!.unit;
const publicRuntime = createBattlefieldRuntime<Narrow>({ map }, value => ({ ...value }));
const publicStored = publicRuntime.getUnit(1)!;
const applied = applyBattlefieldChanges<Narrow>(previous, [{ type: 'SET_POSITION_AND_RELEASE_BLOCKING', unitId: 1, position: [1, 1] }]).content.units.get(1)!;
const settled = settleBattlefieldState<Narrow>(map, maps, previous, previous, dependencies).state.units.get(1)!;
const fullySettled = settleBattlefieldStateFully<Narrow>(map, maps, previous, previous).state.units.get(1)!;
const attacked = updateAttackContributions(narrow, transition);
const defended = updateDefenseContributions(narrow, transition);
const resisted = updateResistanceContributions(narrow, transition);
const maxHp = updateMaxHpContributions(narrow, maxHpTransition);
const coordinated = preserveHpRatio(narrow, maxHp);
const damaged = damageUnit(narrow, 1, 'TRUE').unit;
const healed = healUnit(narrow, 1).unit;
const status = compileStatusBinding(['INVINCIBLE']).install(narrow, instance);
const projection = compileStoredBinding({ id: 'attack', target: updateAttackContributions, sample: () => [], group: undefined });
const projected = projection.install(narrow, instance);
const bound = transitionEffectBindings(narrow, instance, bindings, (binding, current) => binding.update<Narrow>(current, instance));
const registered = registerEffectInstance(narrow, instance);
const replaced = replaceEffectInstances(narrow, []);
const emptied = removeEffectInstance(narrow, 0);
const changed = withEffectLifecycle(fresh, { started: true });
`;
  const positive = `
const definitionId: 'stable-definition' = stored.definition.id;
const identity: 1 = stored.id;
const tags: 'kept'[] = [reconciled.tag, moved.tag, stored.tag, viewed.tag, forked.tag, removed.tag, publicStored.tag, applied.tag, settled.tag, fullySettled.tag, attacked.tag, defended.tag, resisted.tag, maxHp.tag, coordinated.tag, damaged.tag, healed.tag, status.tag, projected.tag, bound.tag, registered.tag, replaced.tag, emptied.tag];
const routes: RoutedLocomotionState[] = [reconciled.locomotion, copied.locomotion, stored.locomotion, viewed.locomotion, forked.locomotion, applied.locomotion, settled.locomotion, fullySettled.locomotion];
const vitality: VitalityState = copied.vitality;
const initialized = initializeUnit({ id: 2, definition: { id: 'hp', vitality: { maxHp: 100 } }, position: [0, 0] });
const initializedHp: number = copyUnitSnapshot(initialized).vitality.hp;
type EnemyProbe = Unit<Definition> & { readonly vitality: VitalityState };
type DeviceProbe = Unit<{ readonly id: 'device' }>;
declare const mixedUnit: EnemyProbe | DeviceProbe;
const distributedSnapshot: UnitSnapshot<EnemyProbe> | UnitSnapshot<DeviceProbe> = copyUnitSnapshot(mixedUnit);
const distributedNavigation: StableUnit<EnemyProbe> | StableUnit<DeviceProbe> = reconcileUnitNavigation(mixedUnit, maps);
const bareSnapshot = copyUnitSnapshot({ id: 3, definition: { id: 'bare' }, position: [0, 0] });
declare const bareSnapshotKey: keyof typeof bareSnapshot;
const bareSnapshotKeys: 'id' | 'definition' | 'position' = bareSnapshotKey;
const knownEffects: EffectsState[] = [registered.effects, replaced.effects, emptied.effects];
declare const bare: Unit & { readonly tag: 'bare' };
const installed: EffectsState = registerEffectInstance(bare, instance).effects;
const lifecycleState: 5 = changed.state.strength;
const lifecycleId: 10 = changed.id;
type StateA = { readonly kind: 'A'; readonly first: number };
type StateB = { readonly kind: 'B'; readonly second: string };
declare const member: EffectInstance<StateA> | EffectInstance<StateB>;
const memberwise: (Omit<EffectInstance<StateA>, keyof EffectLifecycleFacts> & EffectLifecycleFacts) | (Omit<EffectInstance<StateB>, keyof EffectLifecycleFacts> & EffectLifecycleFacts) = withEffectLifecycle(member, { started: true });
const target: ContributionTarget = updateAttackContributions;
const throughTarget: 'kept' = target(narrow, transition).tag;
const inferred = createBattlefieldRuntime({ map }, (value: StableUnit<Narrow>) => ({ ...value }));
const inferredTag: 'kept' = inferred.getUnit(1)!.tag;
type OptionalRouted = Unit<Definition> & { readonly locomotion?: RoutedLocomotionState; readonly tag: 'optional' };
declare const optional: OptionalRouted;
const optionalResult = reconcileUnitNavigation(optional, maps);
if (optionalResult.locomotion !== undefined) {
  const route: RouteControlState = optionalResult.locomotion.mainRoute;
}
`;
  const negatives = [
    "const staleFollowing: Following = reconciled.locomotion.mainRoute.navigation.execution.activity;",
    "const staleAlternative: null = reconciled.locomotion.alternativeRoute;",
    "const staleMoving: false = reconciled.locomotion.moving;",
    "const staleMovedPosition: 0 = moved.position[0];",
    "const staleMovedFollowing: Following = moved.locomotion.mainRoute.navigation.execution.activity;",
    "const stalePosition: 0 = stored.position[0];",
    "const staleViewedPosition: 0 = viewed.position[0];",
    "const staleForkPosition: 0 = forked.position[0];",
    "const staleRemovedPosition: 0 = removed.position[0];",
    "const stalePublicPosition: 0 = publicStored.position[0];",
    "const staleAppliedPosition: 0 = applied.position[0];",
    "const staleSettledFollowing: Following = settled.locomotion.mainRoute.navigation.execution.activity;",
    "const staleFullySettledFollowing: Following = fullySettled.locomotion.mainRoute.navigation.execution.activity;",
    "const erasedExtra = copied.tag;",
    "const badCopier = BattlefieldRuntime.create<Narrow>({ map }, (value: Narrow) => ({ ...value }));",
    "const lossyCopier = BattlefieldRuntime.create<Narrow>({ map }, copyUnitSnapshot);",
    "const staleAttack: readonly [] = attacked.offense.attack.entries;",
    "const staleStatus: readonly [] = status.status.contributions;",
    "const staleBoundHp: 100 = bound.vitality.hp;",
    "const staleProjectionEntries: readonly [] = projected.offense.attack.entries;",
    "const staleMaxHp: 100 = maxHp.vitality.hp;",
    "const staleCoordinatedHp: 100 = coordinated.vitality.hp;",
    "const staleDamageHp: 100 = damaged.vitality.hp;",
    "const staleHealHp: 100 = healed.vitality.hp;",
    "const staleEffects: readonly [] = registered.effects.instances;",
    "const staleReplacedEffects: readonly [] = replaced.effects.instances;",
    "const staleRemovedEffects: readonly [] = emptied.effects.instances;",
    "const staleStarted: false = changed.started;",
    "const staleParent: null = changed.parent;",
  ];
  try {
    writeFileSync(positivePath, declarations + positive);
    writeFileSync(negativePath, declarations + negatives.join('\n'));
    const program = ts.createProgram([positivePath, negativePath], {
      noEmit: true,
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      types: [],
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
