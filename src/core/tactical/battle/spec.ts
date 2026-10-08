import {
    assertNonnegativeNumber,
    assertNonnegativeSafeInteger,
    assertPositiveSafeInteger,
} from "../../common/assert.js";
import { createRng, type Seed } from "../../common/rng.js";
import type { BattlefieldMap } from "../battlefield/map/map.js";
import { createMechanismRuntime, type MechanismRuntime } from "../battlefield/mechanism.js";
import type { NavigationSpatialEffect } from "../battlefield/navigation/effect.js";
import type { NavigationRequestId } from "../battlefield/navigation/request.js";
import type { UnitId } from "../unit/unit.js";
import {
    createPredefinedInstanceDefinition,
    type PredefinedInstanceDefinition,
} from "./predefined.js";
import {
    createUnitPlacementDefinition,
    type UnitPlacementDefinition,
} from "./creation/placement.js";
import {
    createSpawnScheduleDefinition,
    type SpawnScheduleDefinition,
} from "./schedule/definition.js";

export type InitialUnitPlacement = UnitPlacementDefinition;

export interface BattleSpec {
    readonly map: BattlefieldMap;
    readonly schedule: SpawnScheduleDefinition;
    readonly predefines: readonly PredefinedInstanceDefinition[];
    readonly initialUnits?: readonly InitialUnitPlacement[];
    readonly initialMechanisms: readonly Readonly<MechanismRuntime>[];
    readonly initialEffects: readonly Readonly<NavigationSpatialEffect>[];
    readonly maxTicks: number;
    readonly moveMultiplier: number;
    readonly rngState: Seed;
    readonly nextUnitId: UnitId;
    readonly nextNavigationRequestId: NavigationRequestId;
}

export function createBattleSpec(spec: BattleSpec): BattleSpec {
    assertPositiveSafeInteger(spec.maxTicks, "battle tick budget");
    assertNonnegativeNumber(spec.moveMultiplier, "moveMultiplier");

    for (const [name, value] of [
        ["nextUnitId", spec.nextUnitId],
        ["nextNavigationRequestId", spec.nextNavigationRequestId],
    ] as const) {
        assertNonnegativeSafeInteger(value, name);
    }

    createRng(spec.rngState);

    const ids = new Set<number>();

    for (let index = 0; index < spec.predefines.length; index++) {
        const definition = spec.predefines[index];

        if (!Object.hasOwn(spec.predefines, index) || definition === undefined) {
            throw new TypeError("predefined definitions must be dense");
        }

        if (ids.has(definition.id)) {
            throw new RangeError(`duplicate predefined definition: ${definition.id}`);
        }

        ids.add(definition.id);
    }

    return Object.freeze({
        ...spec,
        schedule: createSpawnScheduleDefinition(spec.schedule),
        predefines: Object.freeze(spec.predefines.map(createPredefinedInstanceDefinition)),
        initialUnits: Object.freeze((spec.initialUnits ?? []).map(createUnitPlacementDefinition)),
        initialMechanisms: Object.freeze(
            spec.initialMechanisms.map((mechanism) =>
                Object.freeze(createMechanismRuntime(mechanism)),
            ),
        ),
        initialEffects: Object.freeze(
            spec.initialEffects.map((effect) => Object.freeze({ ...effect })),
        ),
    });
}
