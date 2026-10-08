import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('schedule execution carries its definition through phases and queries and rejects independent unions', async () => {
  const { default: ts } = await import('typescript');
  const directory = mkdtempSync(join(tmpdir(), 'stronghold-schedule-types-'));
  const sourceModule = name => JSON.stringify(fileURLToPath(new URL(`../../src/core/tactical/battle/${name}.js`, import.meta.url)));
  const path = join(directory, 'schedule.mts');
  try {
    writeFileSync(path, `
import type { SpawnScheduleDefinition, TimelineScheduleDefinition, WavesScheduleDefinition } from ${sourceModule('schedule/definition')};
import { createSpawnScheduleExecution, cloneScheduleState, type SpawnScheduleExecution, type SpawnScheduleState, type TimelineScheduleState, type WavesScheduleState } from ${sourceModule('schedule/state')};
import { advanceSpawnSchedule, recordScheduleSpawns, resolveScheduleUnits, isSpawnScheduleCompleted, getUnspawnedCount, getSpawnScheduleCounts } from ${sourceModule('schedule/runtime')};
import { advanceSpawning, resolveSpawning } from ${sourceModule('phases/spawning')};
import { advanceBlocking } from ${sourceModule('phases/blocking')};
import type { BattlePhaseInput, StatelessBattlePhase } from ${sourceModule('phase')};
import type { BattlePhaseState } from ${sourceModule('flow')};
declare const definition: SpawnScheduleDefinition;
declare const progress: SpawnScheduleState;
declare const timelineDefinition: TimelineScheduleDefinition;
declare const wavesDefinition: WavesScheduleDefinition;
declare const timelineProgress: TimelineScheduleState;
declare const wavesProgress: WavesScheduleState;
declare const input: BattlePhaseInput;
const timeline: SpawnScheduleExecution = { ...timelineProgress, definition: timelineDefinition };
const waves: SpawnScheduleExecution = { ...wavesProgress, definition: wavesDefinition };
// @ts-expect-error Timeline progress cannot use a waves definition.
const invalidTimeline: SpawnScheduleExecution = { ...timelineProgress, definition: wavesDefinition };
// @ts-expect-error Waves progress cannot use a timeline definition.
const invalidWaves: SpawnScheduleExecution = { ...wavesProgress, definition: timelineDefinition };
// @ts-expect-error Independent union values do not establish the pairing.
const independent: SpawnScheduleExecution = { ...progress, definition };
const execution = createSpawnScheduleExecution(definition);
const advanced = advanceSpawnSchedule(execution, { tick: 0 });
const recorded = recordScheduleSpawns(advanced.state, advanced.spawns, []);
const resolved = resolveScheduleUnits(recorded, []);
isSpawnScheduleCompleted(resolved);
getUnspawnedCount(resolved);
if (resolved.type === 'TIMELINE') {
    const matching: TimelineScheduleDefinition = resolved.definition;
    resolved.cursor;
} else {
    const matching: WavesScheduleDefinition = resolved.definition;
    resolved.waveIndex;
}
getSpawnScheduleCounts(execution);
const spawned = advanceSpawning(input, execution);
resolveSpawning(input, spawned.state);
const blocking: StatelessBattlePhase = advanceBlocking;
const blocked = blocking(input);
const states: Pick<BattlePhaseState, 'schedule'> = { schedule: execution };
// @ts-expect-error The flow cannot discard the definition-progress association.
const unpairedStates: Pick<BattlePhaseState, 'schedule'> = { schedule: progress };
// @ts-expect-error A bare snapshot cannot advance an execution.
advanceSpawnSchedule(progress, { tick: 0 });
// @ts-expect-error A bare snapshot cannot be paired by a separate definition argument.
advanceSpawnSchedule(definition, progress, { tick: 0 });
// @ts-expect-error Completion requires the associated definition.
isSpawnScheduleCompleted(progress);
// @ts-expect-error Counts require the associated definition.
getUnspawnedCount(progress);
// @ts-expect-error Schedule queries cannot accept bare progress for their counts.
getSpawnScheduleCounts(progress);
// @ts-expect-error Spawning phases cannot accept bare progress.
advanceSpawning(input, progress);
// @ts-expect-error Stateless phases do not expose placeholder state.
blocked.state;
const snapshot = cloneScheduleState(execution);
// @ts-expect-error Public progress snapshots do not carry runtime definitions.
snapshot.definition;
`);
    const program = ts.createProgram([path], {
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
    assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
