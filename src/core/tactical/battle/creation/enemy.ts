import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import { createRng } from "../../../common/rng.js";
import { createWorldPosition, Tile, World, type WorldPosition } from "../../geometry/coordinate.js";
import type { Definition, RoutedEnemy } from "../../unit/archetype/enemy.js";
import type { Id } from "../../unit/unit.js";
import { initialize } from "../../unit/initialize.js";
import type { Result, State as BattleState } from "../state.js";
import { createInput, normalize, type Input, type Timing } from "./route.js";

export interface RoutedEnemySpawn<D extends Definition = Definition> {
    readonly id: Id;
    readonly definition: D;
    readonly route: Input;
    readonly timing: Timing;
    readonly alwaysCheckCurrentPoint: boolean;
}

export interface RoutedEnemyInitialization<D extends Definition = Definition> {
    readonly enemy: RoutedEnemy<D>;
}

function sampleOffset(input: Input, next: () => number): WorldPosition {
    const center = Tile.center(input.startPosition);

    for (let axis = 0; axis < 2; axis++) {
        const range = input.spawnRandomRange[axis]!;
        const offset = input.spawnOffset[axis]!;
        const coordinate = center[axis]!;

        if (
            !Number.isFinite(range * 2) ||
            !Number.isFinite(offset - range) ||
            !Number.isFinite(offset + range) ||
            !Number.isFinite(coordinate + offset - range) ||
            !Number.isFinite(coordinate + offset + range)
        ) {
            throw new RangeError("route spawn bounds must be finite");
        }
    }

    return createWorldPosition(
        input.spawnOffset[0] +
            (-input.spawnRandomRange[0] + next() * (2 * input.spawnRandomRange[0])),
        input.spawnOffset[1] +
            (-input.spawnRandomRange[1] + next() * (2 * input.spawnRandomRange[1])),
    );
}

export function initializeRoutedEnemy<D extends Definition>(
    battle: BattleState,
    spawn: RoutedEnemySpawn<D>,
): Result<RoutedEnemyInitialization<D>>;
export function initializeRoutedEnemy(
    battle: BattleState,
    spawn: RoutedEnemySpawn,
): Result<RoutedEnemyInitialization> {
    assertNonnegativeSafeInteger(spawn.id, "enemy id");

    const input = createInput(spawn.route);
    const rng = createRng(battle.execution.rngState);
    const offset = sampleOffset(input, () => rng.next());
    const route = normalize(input, spawn.timing, offset, spawn.alwaysCheckCurrentPoint);

    battle = { ...battle, execution: { ...battle.execution, rngState: rng.state() } };
    const initialized = initialize(battle, {
        id: spawn.id,
        definition: { ...spawn.definition, route },
        position: World.add(Tile.center(route.startPosition), route.offset),
    });

    return {
        state: initialized.state,
        value: { enemy: initialized.value },
    };
}
