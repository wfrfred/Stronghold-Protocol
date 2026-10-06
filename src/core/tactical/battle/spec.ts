import { createRng } from "../../common/rng.js";
import type { Seed } from "../../common/rng.js";
import type { BattlefieldMap } from "../battlefield/map.js";
import type { MechanismRuntime } from "../battlefield/mechanism.js";
import type { NavigationSpatialEffect } from "../battlefield/navigation-effect.js";
import type { NavigationRequestId } from "../navigation/request.js";
import type { RouteDefinition } from "../route/definition.js";
import { validateRouteExecution } from "../route/execution.js";
import { createRouteTiming } from "../route/state.js";
import type { RouteTiming } from "../route/state.js";
import type { EnemyDefinition } from "../unit/enemy.js";
import type { SteeringParameters } from "../unit/locomotion/steering.js";
import type { UnitId } from "../unit/unit.js";

export interface ScheduledEnemySpawn {
    readonly tick: number;
    readonly definition: EnemyDefinition;
    readonly route: RouteDefinition;
    readonly timing: RouteTiming;
    readonly alwaysCheckCurrentPoint: boolean;
}

export interface BattleSpec {
    readonly map: BattlefieldMap;
    readonly spawns: readonly ScheduledEnemySpawn[];
    readonly initialMechanisms: readonly Readonly<MechanismRuntime>[];
    readonly initialEffects: readonly Readonly<NavigationSpatialEffect>[];
    readonly maxTicks: number;
    readonly moveMultiplier: number;
    readonly steeringParameters: SteeringParameters;
    readonly rngState: Seed;
    readonly nextUnitId: UnitId;
    readonly nextNavigationRequestId: NavigationRequestId;
}

function nonnegative(value: number, name: string): number {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and non-negative`);
    return value;
}

export function createBattleSpec(spec: BattleSpec): BattleSpec {
    if (!Number.isSafeInteger(spec.maxTicks) || spec.maxTicks <= 0) {
        throw new RangeError("battle must have a finite positive tick budget");
    }
    nonnegative(spec.moveMultiplier, "moveMultiplier");
    for (const [name, value] of [["nextUnitId", spec.nextUnitId], ["nextNavigationRequestId", spec.nextNavigationRequestId]] as const) {
        if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
    }
    createRng(spec.rngState);
    const spawns: ScheduledEnemySpawn[] = [];
    for (const spawn of spec.spawns) {
        if (spawn === undefined) throw new TypeError("battle spawns must be dense");
        if (!Number.isSafeInteger(spawn.tick) || spawn.tick < 0) {
            throw new RangeError("spawn.tick must be a non-negative safe integer");
        }
        validateRouteExecution(spawn.route, spawn.alwaysCheckCurrentPoint);
        if (!Number.isFinite(spawn.definition.locomotion.moveSpeedPerTick * spec.moveMultiplier)) {
            throw new RangeError("spawn movement budget must be finite");
        }
        spawns.push(Object.freeze({ ...spawn, timing: createRouteTiming(spawn.timing) }));
    }
    if (!Number.isSafeInteger(spec.nextUnitId + spawns.length)) throw new RangeError("unit identity budget overflows");
    spawns.sort((left, right) => left.tick - right.tick);
    return Object.freeze({
        ...spec,
        spawns: Object.freeze(spawns),
        initialMechanisms: Object.freeze(spec.initialMechanisms.map(mechanism => Object.freeze({ ...mechanism }))),
        initialEffects: Object.freeze(spec.initialEffects.map(effect => Object.freeze({ ...effect }))),
    });
}
