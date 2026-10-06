import {
    BattleRuntime,
    type BattleCommand,
    type BattleEvent,
} from "../core/tactical/battle/runtime.js";
import type { BattlefieldMap } from "../core/tactical/battlefield/map.js";
import { hasRoutedLocomotion } from "../core/tactical/unit/locomotion/state.js";
import { hasVitality, hasVitalityDefinition } from "../core/tactical/unit/vitality.js";
import { isSpatiallyPresent } from "../core/tactical/unit/presence.js";
import type { Unit } from "../core/tactical/unit/unit.js";
import { TICKS_PER_SECOND } from "../core/tactical/tick.js";
import { getUnspawnedCount } from "../core/tactical/battle/schedule.js";
import { loadMovementScenario } from "../data/arknights/movement-scenario.js";
import type {
    ArknightsMovementCatalog,
    ArknightsMovementSelection,
} from "../data/arknights/movement-scenario.js";

interface LegacyData {
    lookup(file: string, key: string): unknown;
}

interface LegacyUnitInfo {
    id: number;
    kind: "enemy" | "device";
    side: "enemy" | "ally";
    defId: string;
    name: string;
    spine: string;
    avatar: string;
    x: number;
    y: number;
    facing: number;
    maxHp: number;
    motion: "WALK" | "FLY";
}

interface LegacyView {
    setStage(stage: Record<string, unknown>): unknown;
    enterBattle(field: {
        fieldId: string;
        kind: string;
        stageId: string;
        rect: Record<string, number>;
        units: readonly LegacyUnitInfo[];
    }): unknown;
    setCamera(kind: string, options: { rect: Record<string, number>; instant: boolean }): unknown;
    setLocalFeed(options: { on: boolean; speed?: number }): unknown;
    pushSnapshot(snapshot: {
        fieldId: string;
        gt: number;
        units: readonly number[][];
        dp: number;
        killed: number;
        total: number;
    }): unknown;
    pushEvents(events: {
        fieldId: string;
        gt: number;
        ev: readonly (readonly ["spawn", LegacyUnitInfo])[];
    }): unknown;
    debug: { interp: { snapToNewest(): unknown; maxExtrapolate: number } };
}

export interface TacticalDemoOptions {
    readonly stageId: string;
    readonly data: LegacyData;
    readonly seed?: number;
    readonly onEvent?: (event: unknown) => void;
}

export type TacticalDemoCommand = "APPEAR_CRATES" | "REMOVE_CRATES" | "TRIGGER_DRAGON";

const STAGE_IDS = new Set([
    "act1autochess_01",
    "act1autochess_m01",
    "act1autochess_m02",
    "act2autochess_m02",
    "act2autochess_m04",
]);
const FIXTURES = [
    "enemy_1007_slime",
    "enemy_1000_gopro",
    "enemy_9012_acloon",
    "character_trap_1105_accrate",
    "character_trap_098_mire",
    "character_trap_042_tidectrl",
    "skill_sktok_accrate",
    "skill_sktok_mire",
    "skill_sktok_tidectrl_3",
    "prefab_enemy_1007_slime",
    "prefab_enemy_1000_gopro",
    "prefab_enemy_9012_acloon",
    "prefab_trap_1105_accrate",
    "prefab_trap_098_mire",
    "prefab_trap_042_tidectrl",
    "prefab_sktok_mire",
    "prefab_sktok_tidectrl_3",
];
const fixtureCache = new Map<string, Promise<unknown>>();

function fixture(name: string): Promise<unknown> {
    let loaded = fixtureCache.get(name);
    if (loaded === undefined) {
        loaded = fetch(`/fixtures/${name}.json`)
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`cannot load ${name}: HTTP ${response.status}`);
                }
                return response.json() as Promise<unknown>;
            })
            .catch((error) => {
                fixtureCache.delete(name);
                throw error;
            });
        fixtureCache.set(name, loaded);
    }
    return loaded;
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function text(value: unknown, fallback: string): string {
    return typeof value === "string" && value.length > 0 ? value : fallback;
}

function stageRows(map: BattlefieldMap): string[] {
    const rows: string[][] = [];
    const mechanisms = { MIRE: "m", DEEPSEA: "d", SMOG: "g", INFECTION: "i" } as const;
    for (let row = 0; row < map.rows; row++) {
        rows.push(
            Array.from({ length: map.columns }, (_, col) => {
                const tile = map.tiles[row * map.columns + col]!;
                if (tile.mechanism !== null) {
                    return mechanisms[tile.mechanism.type];
                }
                if (tile.passableMask === "NONE" && tile.buildableType === "NONE") {
                    return "#";
                }
                if (tile.heightType === "HIGHLAND") {
                    return tile.buildableType === "NONE" ? "#" : "h";
                }
                return tile.buildableType === "NONE" ? "r" : "f";
            }),
        );
    }
    const glyph = { START: "S", END: "E", TELEPORT_IN: "I", TELEPORT_OUT: "O" } as const;
    for (const marker of map.markers) {
        rows[marker.position[0]]![marker.position[1]] = glyph[marker.type];
    }
    return rows.map((row) => row.join(""));
}

function unitInfo(unit: Unit, data: LegacyData): LegacyUnitInfo {
    const routed = hasRoutedLocomotion(unit);
    const assetId =
        unit.definition.id === "enemy_1000_gopro" ? "enemy_1000_gopro_2" : unit.definition.id;
    const metadata = record(data.lookup(routed ? "enemies" : "tokens", assetId));
    return {
        id: unit.id,
        kind: routed ? "enemy" : "device",
        side: routed ? "enemy" : "ally",
        defId: unit.definition.id,
        name: text(metadata.name, routed ? unit.definition.id : "阻隔工事"),
        spine: text(metadata.spine, assetId),
        avatar: text(metadata.iconId, assetId),
        x: unit.position[0],
        y: unit.position[1],
        facing: routed && unit.locomotion.steering.lastVelocity[0] > 0 ? 1 : -1,
        maxHp: hasVitalityDefinition(unit.definition) ? unit.definition.vitality.maxHp : 0,
        motion: routed ? unit.locomotion.mainRoute.navigation.pathMotionMode : "WALK",
    };
}

function unitTuple(unit: Unit): number[] {
    const routed = hasRoutedLocomotion(unit);
    const flying = routed && unit.locomotion.mainRoute.navigation.pathMotionMode === "FLY";
    return [
        unit.id,
        ...unit.position,
        hasVitality(unit) ? unit.vitality.hp : 0,
        hasVitalityDefinition(unit.definition) ? unit.definition.vitality.maxHp : 0,
        0,
        0,
        flying ? 512 : 0,
        routed && unit.locomotion.moving ? 1 : 0,
    ];
}

export async function createTacticalDemo(view: LegacyView, options: TacticalDemoOptions) {
    const { stageId, data, seed = 123 } = options;
    if (!STAGE_IDS.has(stageId)) {
        throw new RangeError(`unsupported demo stage: ${stageId}`);
    }
    const [rawLevel, entries] = await Promise.all([
        fixture(`level_${stageId}`),
        Promise.all(FIXTURES.map(async (name) => [name, await fixture(name)] as const)),
    ]);
    const records = new Map(entries);
    const catalog: ArknightsMovementCatalog = {
        character: (key) => records.get(`character_${key}`),
        skill: (key) => records.get(`skill_${key}`),
        prefab: (key) => records.get(`prefab_${key}`),
        enemy: (key) => records.get(key === "enemy_1000_gopro_2" ? "enemy_1000_gopro" : key),
    };
    const rawPredefines = record(record(rawLevel).predefines).tokenInsts;
    const supported = new Set(["trap_1105_accrate", "trap_098_mire", "trap_042_tidectrl"]);
    const selection: ArknightsMovementSelection = {
        actions: [{ waveIndex: 0, fragmentIndex: 0, actionIndex: 0 }],
        branches: stageId === "act1autochess_01" ? ["dragon"] : [],
        predefines: Array.isArray(rawPredefines)
            ? rawPredefines.flatMap((value, index) =>
                  supported.has(String(record(record(value).inst).characterKey))
                      ? [
                            {
                                source: "predefines" as const,
                                collection: "tokenInsts" as const,
                                index,
                            },
                        ]
                      : [],
              )
            : [],
    };
    const scenario = loadMovementScenario(rawLevel, selection, catalog, seed);
    const legacyStage = record(data.lookup("stages", stageId));
    const renderedStageId = `ts-demo:${stageId}`;
    const stage = {
        ...legacyStage,
        id: renderedStageId,
        rows: Array.isArray(legacyStage.rows) ? legacyStage.rows : stageRows(scenario.spec.map),
        devices: [],
    };
    const route = scenario.level.routes[0]!;
    const kind = route.startPosition[0] <= 6 ? "boss" : "normal";
    const rect =
        kind === "boss" ? { r0: 0, r1: 6, c0: 0, c1: 20 } : { r0: 6, r1: 13, c0: 0, c1: 20 };
    const fieldId = "ts-tactical-demo";
    const commands = new Map<number, readonly BattleCommand[]>();
    const crateIds = scenario.spec.predefines
        .filter((definition) => definition.creation.type === "UNIT")
        .map((definition) => definition.id);
    let runtime = new BattleRuntime(scenario.spec);
    let snapshot = runtime.snapshot();
    let knownUnits = new Set<number>();
    let accumulatedTicks = 0;
    let stopped = false;
    const previousExtrapolate = view.debug.interp.maxExtrapolate;

    function publish(events: readonly BattleEvent[] = []): void {
        const visible = snapshot.units.filter(isSpatiallyPresent);
        const fresh = visible.filter((unit) => !knownUnits.has(unit.id));
        if (fresh.length > 0) {
            view.pushEvents({
                fieldId,
                gt: snapshot.tickIndex / TICKS_PER_SECOND,
                ev: fresh.map((unit) => ["spawn", unitInfo(unit, data)] as const),
            });
        }
        knownUnits = new Set(visible.map((unit) => unit.id));
        view.pushSnapshot({
            fieldId,
            gt: snapshot.tickIndex / TICKS_PER_SECOND,
            units: visible.map(unitTuple),
            dp: 0,
            killed: 0,
            total:
                snapshot.spawning.spawnedCount +
                getUnspawnedCount(scenario.spec.schedule, snapshot.spawning),
        });
        for (const event of events) {
            if (event.type === "ENEMY_SPAWNED" || event.type === "UNIT_REMOVED") {
                options.onEvent?.(event);
            }
        }
    }

    function enter(): void {
        const visible = snapshot.units.filter(isSpatiallyPresent);
        view.setStage(stage);
        view.enterBattle({
            fieldId,
            kind,
            rect,
            stageId: renderedStageId,
            units: visible.map((unit) => unitInfo(unit, data)),
        });
        view.setCamera(kind, { rect, instant: true });
        view.setLocalFeed({ on: true, speed: 1 });
        view.debug.interp.maxExtrapolate = 0;
        knownUnits = new Set(visible.map((unit) => unit.id));
        publish();
        view.debug.interp.snapToNewest();
    }

    function advance(
        requested: readonly BattleCommand[] = commands.get(snapshot.tickIndex) ?? [],
    ): readonly BattleEvent[] {
        const result = runtime.step(requested);
        snapshot = runtime.snapshot();
        return result.events;
    }

    function step(): void {
        if (stopped || runtime.result !== null) {
            return;
        }
        publish(advance());
    }

    function seek(seconds: number): void {
        if (stopped) {
            return;
        }
        const target = Math.max(
            0,
            Math.min(scenario.spec.maxTicks, Math.round(seconds * TICKS_PER_SECOND)),
        );
        runtime = new BattleRuntime(scenario.spec);
        snapshot = runtime.snapshot();
        accumulatedTicks = 0;
        while (snapshot.tickIndex < target && runtime.result === null) {
            advance();
        }
        enter();
    }

    enter();
    return {
        stageId,
        seed,
        duration: scenario.spec.maxTicks / TICKS_PER_SECOND,
        get time() {
            return snapshot.tickIndex / TICKS_PER_SECOND;
        },
        snapshot: () => runtime.snapshot(),
        stats: () => ({
            tickIndex: snapshot.tickIndex,
            units: snapshot.units.length,
            mechanisms: snapshot.mechanisms.length,
            spawnedCount: snapshot.spawning.spawnedCount,
            completedRouteCount: snapshot.completedRouteCount,
            walkRevision: runtime.navigationMaps.WALK.revision,
            result: runtime.result,
            seed,
        }),
        step() {
            step();
            view.debug.interp.snapToNewest();
        },
        tick(seconds: number): void {
            if (stopped) {
                return;
            }
            if (seconds <= 0) {
                view.debug.interp.snapToNewest();
                return;
            }
            accumulatedTicks += seconds * TICKS_PER_SECOND;
            while (accumulatedTicks >= 1 && runtime.result === null) {
                step();
                accumulatedTicks -= 1;
            }
            if (runtime.result !== null) {
                view.debug.interp.snapToNewest();
            }
        },
        seek,
        reset(): void {
            commands.clear();
            seek(0);
        },
        command(type: TacticalDemoCommand): void {
            if (stopped || runtime.result !== null) {
                return;
            }
            const tick = snapshot.tickIndex;
            const requested: readonly BattleCommand[] =
                type === "TRIGGER_DRAGON"
                    ? [{ type: "TRIGGER_BRANCH", branchId: "dragon", isLoop: true }]
                    : crateIds.map((definitionId) =>
                          type === "APPEAR_CRATES"
                              ? { type: "APPEAR_PREDEFINED", definitionId }
                              : { type: "REMOVE_PREDEFINED", definitionId, reason: "SCRIPT" },
                      );
            const events = advance(requested);
            for (const future of commands.keys()) {
                if (future >= tick) {
                    commands.delete(future);
                }
            }
            commands.set(tick, requested);
            publish(events);
            view.debug.interp.snapToNewest();
        },
        stop(): void {
            stopped = true;
            view.setLocalFeed({ on: false });
            view.debug.interp.maxExtrapolate = previousExtrapolate;
        },
    };
}
