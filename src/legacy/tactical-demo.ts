import { BattleRuntime, type Command, type Event } from "../core/tactical/battle/runtime.js";
import type { BattlefieldMap } from "../core/tactical/battlefield/map/map.js";
import { TICKS_PER_SECOND } from "../core/tactical/tick.js";
import {
    loadMovementScenario,
    type ArknightsMovementCatalog,
    type ArknightsMovementSelection,
} from "../data/arknights/movement-scenario.js";
import {
    createTacticalCombatDemoSpec,
    type TacticalCombatScenario,
} from "./tactical-demo-combat.js";
import {
    TacticalDemoPresentation,
    type LegacyData,
    type LegacyElementGauge,
    type LegacyUnitInfo,
    type LegacyVisualEvent,
} from "./tactical-demo-presentation.js";
import { createTacticalProjectileResources } from "./projectile-demo.js";
import { hasAllegiance } from "../core/tactical/unit/capability/allegiance.js";
import { hasSkill } from "../core/tactical/unit/capability/skill/capability.js";
import {
    createTacticalMechanicsDemo,
    isTacticalMechanicsScenario,
    type TacticalMechanicsScenario,
} from "./tactical-demo-mechanics.js";
import { hasElemental } from "../core/tactical/unit/capability/elemental/capability.js";

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
        elem: readonly LegacyElementGauge[];
        dp: number;
        killed: number;
        total: number;
    }): unknown;
    pushEvents(events: {
        fieldId: string;
        gt: number;
        ev: readonly (LegacyVisualEvent | readonly ["spawn", LegacyUnitInfo])[];
    }): unknown;
    setProjectiles?(
        projectiles: readonly {
            readonly id: number;
            readonly source: number | null;
            readonly position: readonly [number, number];
            readonly destination: readonly [number, number];
        }[],
    ): unknown;
    debug: { interp: { snapToNewest(): unknown; maxExtrapolate: number } };
}

export interface TacticalDemoOptions {
    readonly stageId: string;
    readonly data: LegacyData;
    readonly seed?: number;
    readonly mode?: "MOVEMENT" | "COMBAT";
    readonly combatScenario?:
        TacticalCombatScenario | TacticalMechanicsScenario | "PROJECTILE_CACHED";
    readonly onEvent?: (event: unknown) => void;
}

export type TacticalDemoCommand =
    | "APPEAR_CRATES"
    | "REMOVE_CRATES"
    | "TRIGGER_DRAGON"
    | "RETREAT_SOURCE"
    | "STOP_PROJECTILES"
    | "ACTIVATE_SKILL"
    | "FINISH_SKILL";

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
    "prefab_tile_deepsea",
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
            .catch((error: unknown) => {
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

export async function createTacticalDemo(view: LegacyView, options: TacticalDemoOptions) {
    const { stageId, data, seed = 123, mode = "MOVEMENT" } = options;
    const projectileActions =
        mode === "COMBAT" &&
        (options.combatScenario === "PROJECTILE" || options.combatScenario === "PROJECTILE_CACHED");
    const combatScenario =
        options.combatScenario === "PROJECTILE_CACHED" ? "PROJECTILE" : options.combatScenario;
    const mechanicsScenario =
        mode === "COMBAT" && isTacticalMechanicsScenario(combatScenario) ? combatScenario : null;

    if (!STAGE_IDS.has(stageId)) {
        throw new RangeError(`unsupported demo stage: ${stageId}`);
    }

    if (mode === "COMBAT" && stageId !== "act1autochess_m01") {
        throw new RangeError(`unsupported combat demo stage: ${stageId}`);
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
    let predefines: ArknightsMovementSelection["predefines"] = [];

    if (Array.isArray(rawPredefines)) {
        predefines = rawPredefines.flatMap((value, index) => {
            const characterKey = String(record(record(value).inst).characterKey);

            if (!supported.has(characterKey)) {
                return [];
            }

            return [{ source: "predefines" as const, collection: "tokenInsts" as const, index }];
        });
    }

    const selection: ArknightsMovementSelection = {
        actions: [{ waveIndex: 0, fragmentIndex: 0, actionIndex: 0 }],
        branches: stageId === "act1autochess_01" ? ["dragon"] : [],
        predefines,
    };
    const scenario = loadMovementScenario(rawLevel, selection, catalog, seed);

    const route = scenario.level.routes[0]!;
    const mechanics =
        mechanicsScenario === null
            ? null
            : createTacticalMechanicsDemo(
                  scenario.spec.map,
                  route,
                  data,
                  seed,
                  mechanicsScenario,
                  mechanicsScenario === "SKILL" ? await fixture("skill_skcom_atk_up_2") : undefined,
              );
    const spec =
        mechanics?.input ??
        (mode === "COMBAT"
            ? createTacticalCombatDemoSpec(
                  scenario.spec.map,
                  route,
                  data,
                  seed,
                  isTacticalMechanicsScenario(combatScenario) ? undefined : combatScenario,
              )
            : scenario.spec);
    const presentation = new TacticalDemoPresentation(data, { projectileActions });

    const legacyStage = record(data.lookup("stages", stageId));
    const renderedStageId = `ts-demo:${stageId}`;
    const stage = {
        ...legacyStage,
        id: renderedStageId,
        rows: Array.isArray(legacyStage.rows) ? legacyStage.rows : stageRows(spec.map),
        devices: [],
    };
    const kind = route.startPosition[0] <= 6 ? "boss" : "normal";
    const rect =
        kind === "boss" ? { r0: 0, r1: 6, c0: 0, c1: 20 } : { r0: 6, r1: 13, c0: 0, c1: 20 };
    const fieldId = "ts-tactical-demo";

    const commands = new Map<number, readonly Command[]>();
    const crateIds = spec.predefines
        .filter((definition) => definition.creation.type === "UNIT")
        .map((definition) => definition.id);

    const resources = mechanics === null ? {} : { combat: mechanics.combat };
    const createRuntime = () =>
        new BattleRuntime(
            spec,
            projectileActions
                ? createTacticalProjectileResources(options.combatScenario === "PROJECTILE_CACHED")
                : resources,
        );
    let runtime = createRuntime();
    let snapshot = runtime.snapshot();
    let knownUnits = new Set<number>();
    let accumulatedTicks = 0;
    let stopped = false;
    const previousExtrapolate = view.debug.interp.maxExtrapolate;

    function publish(
        events: readonly Event[] = [],
        visuals: readonly LegacyVisualEvent[] = [],
    ): void {
        const visible = presentation.units(snapshot);
        const fresh = visible.filter((unit) => !knownUnits.has(unit.info.id));

        if (fresh.length > 0 || visuals.length > 0) {
            view.pushEvents({
                fieldId,
                gt: snapshot.tickIndex / TICKS_PER_SECOND,
                ev: [...fresh.map((unit) => ["spawn", unit.info] as const), ...visuals],
            });
        }

        knownUnits = new Set(visible.map((unit) => unit.info.id));
        view.pushSnapshot({
            fieldId,
            gt: snapshot.tickIndex / TICKS_PER_SECOND,
            units: visible.map((unit) => unit.tuple),
            elem: presentation.elements(snapshot),
            dp: 0,
            killed: presentation.stats().killedCount,
            total: runtime.spawnCounts.spawnedCount + runtime.spawnCounts.unspawnedCount,
        });
        view.setProjectiles?.(snapshot.projectiles.instances);

        for (const event of events) {
            if (event.type === "UNIT_REMOVED") {
                options.onEvent?.({
                    type: event.type,
                    unitId: event.unitId,
                    reason: event.reason,
                    tick: event.tick,
                });
                continue;
            }

            if (
                event.type === "ENEMY_SPAWNED" ||
                event.type === "ROUTE_COMPLETED" ||
                event.type === "ACTION" ||
                event.type === "ACTION_RELEASED" ||
                event.type === "ACTION_FINISHED" ||
                event.type === "ACTION_CANCELLED" ||
                event.type === "PROJECTILE_REACHED" ||
                event.type === "PROJECTILE_HIT" ||
                event.type === "PROJECTILE_STOPPED" ||
                event.type === "DAMAGE" ||
                event.type === "HEAL" ||
                event.type === "SKILL_ACTIVATED" ||
                event.type === "SKILL_FINISHED" ||
                event.type === "ELEMENT_DAMAGE" ||
                event.type === "ELEMENT_HEAL" ||
                event.type === "ELEMENT_BURST" ||
                event.type === "ELEMENT_RECOVERED"
            ) {
                options.onEvent?.(event);
            }
        }
    }

    function enter(): void {
        const visible = presentation.units(snapshot);
        view.setStage(stage);
        view.enterBattle({
            fieldId,
            kind,
            rect,
            stageId: renderedStageId,
            units: visible.map((unit) => unit.info),
        });
        view.setCamera(kind, { rect, instant: true });
        view.setLocalFeed({ on: true, speed: 1 });
        view.debug.interp.maxExtrapolate = 0;
        knownUnits = new Set(visible.map((unit) => unit.info.id));
        publish([], presentation.replayEvents(snapshot));
        view.debug.interp.snapToNewest();
    }

    function advance(requested: readonly Command[] = commands.get(snapshot.tickIndex) ?? []) {
        const result = runtime.step(requested);
        snapshot = runtime.snapshot();
        const visuals = presentation.advance(snapshot, result.events);

        return { events: result.events, visuals };
    }

    function step(): void {
        if (stopped || runtime.result !== null) {
            return;
        }

        const result = advance();
        publish(result.events, result.visuals);
    }

    function seek(seconds: number): void {
        if (stopped) {
            return;
        }

        const target = Math.max(0, Math.min(spec.maxTicks, Math.round(seconds * TICKS_PER_SECOND)));
        runtime = createRuntime();
        snapshot = runtime.snapshot();
        accumulatedTicks = 0;
        presentation.reset();

        while (snapshot.tickIndex < target && runtime.result === null) {
            advance();
        }

        enter();
    }

    function skillStats() {
        const source = snapshot.units.find(hasSkill);

        if (source === undefined) {
            return null;
        }

        const { skill } = source;
        const { spCost } = source.definition.skill;
        const active = skill.active;

        return {
            sp: skill.sp,
            maxSp: spCost,
            active: active !== null,
            remainingTicks:
                active?.endsAtTick == null
                    ? 0
                    : Math.max(0, active.endsAtTick - snapshot.tickIndex),
            remainingAmmo: active?.remainingAmmo,
            ready: active === null && skill.sp >= spCost && snapshot.result === null,
        };
    }

    function elementStats() {
        const target = snapshot.units.find(hasElemental);
        const type = mechanics?.elementType;

        if (target === undefined || type == null) {
            return null;
        }

        return {
            remainingEp: target.elemental.ep[type],
            maxEp: target.definition.elemental.maxEp,
            recoveryTicks: Math.max(
                0,
                (target.elemental.recovery?.endsAtTick ?? 0) - snapshot.tickIndex,
            ),
        };
    }

    enter();

    return {
        stageId,
        seed,
        duration: spec.maxTicks / TICKS_PER_SECOND,

        get time() {
            return snapshot.tickIndex / TICKS_PER_SECOND;
        },

        snapshot: () => runtime.snapshot(),
        stats: () => ({
            mode,
            combatScenario: options.combatScenario ?? "MIXED",
            ...presentation.stats(),
            skill: skillStats(),
            elementType: mechanics?.elementType ?? null,
            element: elementStats(),
            blockingCount: snapshot.blockingRelations.length,
            activeActionCount: snapshot.actionExecution.executions.length,
            projectileCount: snapshot.projectiles.instances.length,
            projectileActions,
            sourcePresent: snapshot.units.some(
                (unit) => hasAllegiance(unit) && unit.allegiance.side === "ALLY",
            ),
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

        nextRelease(): void {
            if (!projectileActions || stopped || runtime.result !== null) {
                return;
            }

            const events: Event[] = [];
            const visuals: LegacyVisualEvent[] = [];

            while (snapshot.tickIndex < spec.maxTicks) {
                const advanced = advance();
                events.push(...advanced.events);
                visuals.push(...advanced.visuals);

                if (
                    snapshot.result !== null ||
                    advanced.events.some((event) => event.type === "ACTION_RELEASED")
                ) {
                    break;
                }
            }

            publish(events, visuals);
            view.debug.interp.snapToNewest();
        },

        nextSkillReady(): void {
            if (mechanicsScenario !== "SKILL" || stopped || runtime.result !== null) {
                return;
            }

            const events: Event[] = [];

            while (snapshot.result === null && skillStats()?.ready !== true) {
                const advanced = advance();
                events.push(...advanced.events);
            }

            publish(events, presentation.replayEvents(snapshot));
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
            let requested: readonly Command[];

            if (type === "ACTIVATE_SKILL" || type === "FINISH_SKILL") {
                const source = snapshot.units.find(hasSkill);

                if (source === undefined) {
                    return;
                }

                requested = [{ type, unitId: source.id }];
            } else if (type === "RETREAT_SOURCE") {
                if (!projectileActions) {
                    return;
                }

                const source = snapshot.units.find(
                    (unit) => hasAllegiance(unit) && unit.allegiance.side === "ALLY",
                );

                if (source === undefined) {
                    return;
                }

                requested = [{ type: "RETREAT_UNIT", unitId: source.id }];
            } else if (type === "STOP_PROJECTILES") {
                if (!projectileActions || snapshot.projectiles.instances.length === 0) {
                    return;
                }

                requested = snapshot.projectiles.instances.map((instance) => ({
                    type: "STOP_PROJECTILE",
                    projectileId: instance.id,
                }));
            } else if (mode === "COMBAT") {
                return;
            } else if (type === "TRIGGER_DRAGON") {
                requested = [{ type: "TRIGGER_BRANCH", branchId: "dragon", isLoop: true }];
            } else {
                requested = crateIds.map((definitionId) =>
                    type === "APPEAR_CRATES"
                        ? { type: "APPEAR_PREDEFINED", definitionId }
                        : { type: "REMOVE_PREDEFINED", definitionId, reason: "SCRIPT" },
                );
            }

            const result = advance(requested);

            for (const future of commands.keys()) {
                if (future >= tick) {
                    commands.delete(future);
                }
            }

            commands.set(tick, requested);
            publish(result.events, result.visuals);
            view.debug.interp.snapToNewest();
        },

        stop(): void {
            stopped = true;
            view.setLocalFeed({ on: false });
            view.debug.interp.maxExtrapolate = previousExtrapolate;
        },
    };
}
