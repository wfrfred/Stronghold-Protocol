import type { Event, Snapshot } from "../core/tactical/battle/contract.js";
import type { DamageType } from "../core/tactical/unit/capability/vitality/damage/contract.js";
import { hasActionDefinition } from "../core/tactical/unit/capability/action/capability.js";
import { hasAllegiance } from "../core/tactical/unit/capability/allegiance.js";
import {
    hasElemental,
    type ElementType,
} from "../core/tactical/unit/capability/elemental/capability.js";
import {
    elementDamageRatio,
    getCurrentElementType,
} from "../core/tactical/unit/capability/elemental/query.js";
import {
    hasLocomotion,
    hasRoutedLocomotion,
} from "../core/tactical/unit/capability/locomotion/capability.js";
import { isSpatiallyPresent } from "../core/tactical/unit/capability/presence.js";
import { hasSpatial } from "../core/tactical/unit/capability/spatial.js";
import { hasSkill } from "../core/tactical/unit/capability/skill/capability.js";
import { hasStatusFlag } from "../core/tactical/unit/capability/status/capability.js";
import {
    hasVitality,
    hasVitalityDefinition,
    resolveVitalityMaxHp,
} from "../core/tactical/unit/capability/vitality/capability.js";
import type { Direction } from "../core/tactical/geometry/direction.js";
import type { Unit, UnitId } from "../core/tactical/unit/unit.js";
import { TICKS_PER_SECOND } from "../core/tactical/tick.js";

export interface LegacyData {
    lookup(file: string, key: string): unknown;
}

export interface LegacyUnitInfo {
    readonly id: number;
    readonly kind: "op" | "enemy" | "device";
    readonly side: "enemy" | "ally";
    readonly defId: string;
    readonly name: string;
    readonly spine: string;
    readonly avatar: string;
    readonly x: number;
    readonly y: number;
    readonly facing: number;
    readonly dir: Direction;
    readonly maxHp: number;
    readonly motion: "WALK" | "FLY";
    readonly skillActive: boolean;
    readonly skillIndex?: number;
}

type LegacyElementType = "neural" | "erosion" | "burn" | "apoptosis";

export type LegacyElementGauge = readonly [
    unitId: UnitId,
    element: LegacyElementType,
    fill: number,
    cooldownEnd: number,
    cooldown: number,
];

export type LegacyVisualEvent =
    | readonly ["atk", sourceId: UnitId, targetId: UnitId, "none"]
    | readonly [
          "dmg",
          targetId: UnitId,
          amount: number,
          "phys" | "arts" | "true" | LegacyElementType,
      ]
    | readonly ["heal", targetId: UnitId, amount: number]
    | readonly ["skill", unitId: UnitId, active: boolean]
    | readonly [
          "fx",
          "burst",
          x: number,
          y: number,
          { readonly id: UnitId; readonly element: LegacyElementType },
      ]
    | readonly ["die", unitId: UnitId, "killed"]
    | readonly ["leak", unitId: UnitId];

interface PresentedUnit {
    readonly info: LegacyUnitInfo;
    readonly tuple: number[];
}

interface Tombstone extends PresentedUnit {
    readonly expiresAtTick: number;
}

interface RecentAttack {
    readonly event: Extract<LegacyVisualEvent, readonly ["atk", ...unknown[]]>;
    readonly expiresAtTick: number;
}

export interface TacticalDemoPresentationOptions {
    readonly projectileActions?: boolean;
}

const DEATH_WINDOW_TICKS = 24;
const ATTACK_REPLAY_TICKS = 8;
const DAMAGE_TYPE = {
    PHYSICAL: "phys",
    ARTS: "arts",
    TRUE: "true",
    ELEMENTAL: "true",
} as const satisfies Record<DamageType, string>;
const ELEMENT_TYPE = {
    NEURAL: "neural",
    EROSION: "erosion",
    BURN: "burn",
    NECROSIS: "apoptosis",
} as const satisfies Record<ElementType, LegacyElementType>;

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function text(value: unknown, fallback: string): string {
    return typeof value === "string" && value.length > 0 ? value : fallback;
}

function isEnemy(unit: Unit): boolean {
    return hasAllegiance(unit) ? unit.allegiance.side === "ENEMY" : hasRoutedLocomotion(unit);
}

function isFlying(unit: Unit): boolean {
    if (hasSpatial(unit)) {
        return unit.spatial.layer === "AIR";
    }

    return (
        hasRoutedLocomotion(unit) && unit.locomotion.mainRoute.navigation.pathMotionMode === "FLY"
    );
}

function maxHp(unit: Unit): number {
    if (hasVitality(unit)) {
        return resolveVitalityMaxHp(unit.definition.vitality, unit.vitality);
    }

    return hasVitalityDefinition(unit.definition) ? unit.definition.vitality.maxHp : 0;
}

function skillActive(unit: Unit): boolean {
    return (
        hasSkill(unit) &&
        unit.definition.skill.activation !== "PASSIVE" &&
        (!hasVitality(unit) || unit.vitality.hp > 0) &&
        unit.skill.active !== null
    );
}

function unitInfo(unit: Unit, data: LegacyData): LegacyUnitInfo {
    const enemy = isEnemy(unit);
    const chess = record(data.lookup("chess", unit.definition.id));
    const operator = Object.keys(chess).length > 0;
    const assetId =
        unit.definition.id === "enemy_1000_gopro" ? "enemy_1000_gopro_2" : unit.definition.id;
    const metadata = operator ? chess : record(data.lookup(enemy ? "enemies" : "tokens", assetId));
    const assets = record(metadata.assets);
    const fallbackAsset = text(metadata.charId, assetId);
    const skills = Array.isArray(metadata.skills)
        ? metadata.skills.map(record)
        : [record(metadata.skill)];
    const skillId = hasSkill(unit) ? unit.definition.skill.id : undefined;
    const skillIndex = skills.find((skill) => skill.skillId === skillId)?.index;
    let dir: Direction = "RIGHT";

    if (hasActionDefinition(unit.definition)) {
        const targeting = unit.definition.action.normalAction.targetGroups[0].targeting;

        if (
            targeting.type === "DAMAGE" &&
            targeting.scope.type === "RANGE" &&
            targeting.scope.geometry.type === "GRID"
        ) {
            dir = targeting.scope.geometry.direction;
        } else if (targeting.type === "HEAL" && targeting.geometry.type === "GRID") {
            dir = targeting.geometry.direction;
        }
    }

    const facing =
        enemy && hasLocomotion(unit)
            ? unit.locomotion.steering.lastVelocity[0] > 0
            : dir !== "LEFT";
    let kind: LegacyUnitInfo["kind"] = "device";

    if (operator) {
        kind = "op";
    } else if (enemy) {
        kind = "enemy";
    }

    return {
        id: unit.id,
        kind,
        side: enemy ? "enemy" : "ally",
        defId: unit.definition.id,
        name: text(metadata.name, unit.definition.id),
        spine: text(assets.spine, text(metadata.spine, fallbackAsset)),
        avatar: text(assets.avatar, text(metadata.iconId, text(metadata.avatar, fallbackAsset))),
        x: unit.position[0],
        y: unit.position[1],
        facing: facing ? 1 : -1,
        dir,
        maxHp: maxHp(unit),
        motion: isFlying(unit) ? "FLY" : "WALK",
        skillActive: skillActive(unit),
        ...(typeof skillIndex === "number" ? { skillIndex } : {}),
    };
}

function unitTuple(unit: Unit, snapshot: Snapshot, dead = false): number[] {
    const blocked = snapshot.blockingRelations.some(
        (relation) => relation.blockedUnitId === unit.id,
    );
    const flags =
        (blocked ? 1 : 0) |
        (isFlying(unit) ? 512 : 0) |
        (hasStatusFlag(unit, "STUNNED") ? 2 : 0) |
        (!dead && skillActive(unit) ? 16 : 0) |
        (hasStatusFlag(unit, "INVINCIBLE") ? 64 : 0);
    let animation = 0;

    if (dead) {
        animation = 4;
    } else if (hasStatusFlag(unit, "STUNNED")) {
        animation = 5;
    } else if (hasLocomotion(unit) && unit.locomotion.moving) {
        animation = 1;
    }

    let sp = 0;
    let spMax = 0;

    if (!dead && hasSkill(unit)) {
        const definition = unit.definition.skill;
        const active = unit.skill.active;
        sp = unit.skill.sp;
        spMax = definition.spCost;

        if (active !== null) {
            if (active.remainingAmmo !== undefined && definition.ammo !== undefined) {
                sp = spMax * (active.remainingAmmo / Math.max(1, definition.ammo));
            } else if (active.endsAtTick !== null && active.endsAtTick > active.startedAtTick) {
                const remaining = Math.max(0, active.endsAtTick - snapshot.tickIndex);
                sp = spMax * (remaining / (active.endsAtTick - active.startedAtTick));
            }
        }
    }

    return [
        unit.id,
        ...unit.position,
        !dead && hasVitality(unit) ? unit.vitality.hp : 0,
        maxHp(unit),
        sp,
        spMax,
        flags,
        animation,
    ];
}

export class TacticalDemoPresentation {
    readonly #data: LegacyData;
    readonly #projectileActions: boolean;
    readonly #tombstones = new Map<UnitId, Tombstone>();
    readonly #attacks = new Map<UnitId, RecentAttack>();
    readonly #pendingAttackTargets = new Map<UnitId, UnitId>();
    #killedCount = 0;
    #attackCount = 0;
    #damageCount = 0;
    #elementDamageCount = 0;
    #elementBurstCount = 0;

    constructor(data: LegacyData, options: TacticalDemoPresentationOptions = {}) {
        this.#data = data;
        this.#projectileActions = options.projectileActions === true;
    }

    reset(): void {
        this.#tombstones.clear();
        this.#attacks.clear();
        this.#pendingAttackTargets.clear();
        this.#killedCount = 0;
        this.#attackCount = 0;
        this.#damageCount = 0;
        this.#elementDamageCount = 0;
        this.#elementBurstCount = 0;
    }

    advance(after: Snapshot, events: readonly Event[]): readonly LegacyVisualEvent[] {
        const visible: LegacyVisualEvent[] = [];
        const resumableSources = new Set<UnitId>();

        if (this.#projectileActions) {
            for (const execution of after.actionExecution.executions) {
                resumableSources.add(execution.sourceUnitId);
            }
            for (const event of events) {
                if (
                    event.type === "ACTION_RELEASED" ||
                    event.type === "ACTION_FINISHED" ||
                    event.type === "ACTION_CANCELLED"
                ) {
                    resumableSources.add(event.sourceUnitId);
                }
            }
        }

        for (const [id, tombstone] of this.#tombstones) {
            if (tombstone.expiresAtTick <= after.tickIndex) {
                this.#tombstones.delete(id);
            }
        }
        for (const [id, attack] of this.#attacks) {
            if (attack.expiresAtTick <= after.tickIndex) {
                this.#attacks.delete(id);
            }
        }

        for (const event of events) {
            switch (event.type) {
                case "ACTION": {
                    this.#attackCount++;

                    if (resumableSources.has(event.sourceUnitId)) {
                        this.#pendingAttackTargets.set(event.sourceUnitId, event.targetUnitId);
                    } else {
                        visible.push(
                            this.#attack(event.sourceUnitId, event.targetUnitId, after.tickIndex),
                        );
                    }

                    break;
                }

                case "ACTION_RELEASED": {
                    if (!this.#projectileActions) {
                        break;
                    }

                    const projectile = after.projectiles.instances.find(
                        (instance) =>
                            instance.source === event.sourceUnitId &&
                            instance.launchedAtTick === event.tick,
                    );
                    const target =
                        projectile?.traceTarget ??
                        this.#pendingAttackTargets.get(event.sourceUnitId);

                    if (target !== undefined) {
                        visible.push(this.#attack(event.sourceUnitId, target, after.tickIndex));
                    }

                    break;
                }

                case "ACTION_FINISHED":
                case "ACTION_CANCELLED": {
                    this.#pendingAttackTargets.delete(event.sourceUnitId);
                    break;
                }

                case "DAMAGE":
                    this.#damageCount++;
                    visible.push([
                        "dmg",
                        event.targetUnitId,
                        Math.round(event.amount),
                        DAMAGE_TYPE[event.damageType],
                    ]);
                    break;

                case "HEAL":
                    visible.push(["heal", event.targetUnitId, Math.round(event.amount)]);
                    break;

                case "SKILL_ACTIVATED":
                case "SKILL_FINISHED": {
                    const unit = after.units.find((unit) => unit.id === event.unitId);

                    if (
                        unit !== undefined &&
                        hasSkill(unit) &&
                        unit.definition.skill.activation === "PASSIVE"
                    ) {
                        break;
                    }

                    visible.push(["skill", event.unitId, event.type === "SKILL_ACTIVATED"]);
                    break;
                }

                case "ELEMENT_DAMAGE":
                    this.#elementDamageCount++;
                    visible.push([
                        "dmg",
                        event.targetUnitId,
                        Math.round(event.amount),
                        ELEMENT_TYPE[event.elementType],
                    ]);
                    break;

                case "ELEMENT_HEAL": {
                    const amount = Object.values(event.amounts).reduce(
                        (sum, value) => sum + value,
                        0,
                    );
                    visible.push(["heal", event.targetUnitId, Math.round(amount)]);
                    break;
                }

                case "ELEMENT_BURST": {
                    this.#elementBurstCount++;

                    const removed = events.find(
                        (candidate) =>
                            candidate.type === "UNIT_REMOVED" &&
                            candidate.unitId === event.burst.targetUnitId,
                    );
                    const unit =
                        after.units.find((unit) => unit.id === event.burst.targetUnitId) ??
                        (removed?.type === "UNIT_REMOVED" ? removed.unit : undefined);

                    if (unit !== undefined) {
                        visible.push([
                            "fx",
                            "burst",
                            ...unit.position,
                            {
                                id: unit.id,
                                element: ELEMENT_TYPE[event.burst.type],
                            },
                        ]);
                    }

                    break;
                }

                case "UNIT_REMOVED": {
                    if (event.reason !== "DEATH") {
                        break;
                    }

                    visible.push(["die", event.unitId, "killed"]);

                    const unit = event.unit;

                    if (isEnemy(unit)) {
                        this.#killedCount++;
                    }

                    this.#tombstones.set(event.unitId, {
                        info: unitInfo(unit, this.#data),
                        tuple: unitTuple(unit, after, true),
                        expiresAtTick: after.tickIndex + DEATH_WINDOW_TICKS,
                    });

                    break;
                }

                case "ROUTE_COMPLETED":
                    visible.push(["leak", event.unitId]);
                    break;

                case "ENEMY_SPAWNED":
                case "PROJECTILE_REACHED":
                case "PROJECTILE_HIT":
                case "PROJECTILE_STOPPED":
                case "ELEMENT_RECOVERED":
                case "UNIT_DEPLOYED":
                case "UNIT_RELOCATED":
                case "SUPPORT_LOST":
                case "NAVIGATION":
                case "ROUTE":
                    break;
            }
        }

        return visible;
    }

    #attack(source: UnitId, target: UnitId, tick: number): RecentAttack["event"] {
        const event = ["atk", source, target, "none"] as const;
        this.#attacks.set(source, {
            event,
            expiresAtTick: tick + ATTACK_REPLAY_TICKS,
        });

        return event;
    }

    units(snapshot: Snapshot): readonly PresentedUnit[] {
        const presented = snapshot.units.filter(isSpatiallyPresent).map((unit) => ({
            info: unitInfo(unit, this.#data),
            tuple: unitTuple(unit, snapshot),
        }));
        const liveIds = new Set(snapshot.units.map((unit) => unit.id));

        for (const [id, tombstone] of this.#tombstones) {
            if (!liveIds.has(id) && snapshot.tickIndex < tombstone.expiresAtTick) {
                presented.push({ info: { ...tombstone.info }, tuple: [...tombstone.tuple] });
            }
        }

        return presented.sort((left, right) => left.info.id - right.info.id);
    }

    elements(snapshot: Snapshot): readonly LegacyElementGauge[] {
        const gauges: LegacyElementGauge[] = [];

        for (const unit of snapshot.units) {
            if (
                !isSpatiallyPresent(unit) ||
                !hasElemental(unit) ||
                (hasVitality(unit) && unit.vitality.hp <= 0)
            ) {
                continue;
            }

            const recovery = unit.elemental.recovery;

            if (recovery !== null) {
                gauges.push([
                    unit.id,
                    ELEMENT_TYPE[recovery.type],
                    1,
                    recovery.endsAtTick / TICKS_PER_SECOND,
                    (recovery.endsAtTick - recovery.startedAtTick) / TICKS_PER_SECOND,
                ]);
                continue;
            }

            const type = getCurrentElementType(unit);

            if (type === undefined) {
                continue;
            }

            const fill = Math.min(
                0.99,
                Math.max(0.01, Math.floor(elementDamageRatio(unit) * 100 + 1e-9) / 100),
            );
            gauges.push([unit.id, ELEMENT_TYPE[type], fill, 0, 0]);
        }

        return gauges;
    }

    stats(): {
        readonly killedCount: number;
        readonly attackCount: number;
        readonly damageCount: number;
        readonly elementDamageCount: number;
        readonly elementBurstCount: number;
    } {
        return {
            killedCount: this.#killedCount,
            attackCount: this.#attackCount,
            damageCount: this.#damageCount,
            elementDamageCount: this.#elementDamageCount,
            elementBurstCount: this.#elementBurstCount,
        };
    }

    replayEvents(snapshot: Snapshot): readonly LegacyVisualEvent[] {
        const live = new Set(snapshot.units.filter(isSpatiallyPresent).map((unit) => unit.id));

        return [...this.#attacks]
            .filter(([id, attack]) => live.has(id) && snapshot.tickIndex < attack.expiresAtTick)
            .sort(([left], [right]) => left - right)
            .map(([, attack]) => [...attack.event]);
    }
}
