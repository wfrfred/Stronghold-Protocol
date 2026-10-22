import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import { createRng } from "../../../common/rng.js";
import { createWorldPosition, Tile, World, type WorldPosition } from "../../geometry/coordinate.js";
import type { Definition, Id, Unit } from "../../unit/unit.js";
import type { Definitions, Product } from "../../unit/capability/catalog.js";
import type { Route } from "../../unit/capability/route/capability.js";
import { initialize as initializeUnit } from "../../unit/initialize.js";
import type { Result, State as BattleState } from "../state.js";
import { createInput, normalize, type Input as RouteInput, type Timing } from "./route.js";

export interface Input<D extends Definition & Partial<Definitions> = Definition> {
    readonly id: Id;
    readonly definition: D;
    readonly route: RouteInput;
    readonly timing: Timing;
    readonly alwaysCheckCurrentPoint: boolean;
}

export interface Initialization<D extends Definition & Partial<Definitions> = Definition> {
    readonly unit: Unit & Product<D> & Route;
}

function sampleOffset(input: RouteInput, next: () => number): WorldPosition {
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

export function initialize<D extends Definition & Partial<Definitions>>(
    battle: BattleState,
    spawn: Input<D>,
): Result<Initialization<D>>;
export function initialize(battle: BattleState, spawn: Input): Result<Initialization> {
    assertNonnegativeSafeInteger(spawn.id, "unit id");

    const input = createInput(spawn.route);
    const rng = createRng(battle.execution.rngState);
    const offset = sampleOffset(input, () => rng.next());
    const route = normalize(input, spawn.timing, offset, spawn.alwaysCheckCurrentPoint);

    battle = { ...battle, execution: { ...battle.execution, rngState: rng.state() } };
    const initialized = initializeUnit(battle, {
        id: spawn.id,
        definition: { ...spawn.definition, route },
        position: World.add(Tile.center(route.startPosition), route.offset),
    });

    return {
        state: initialized.state,
        value: { unit: initialized.value },
    };
}
