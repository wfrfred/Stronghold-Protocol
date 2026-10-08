import type { Event, Snapshot } from "../core/tactical/battle/contract.js";
import type { DamageType } from "../core/tactical/unit/capability/vitality/damage/contract.js";
import { hasActionDefinition } from "../core/tactical/unit/capability/action/capability.js";
import { hasAllegiance } from "../core/tactical/unit/capability/allegiance.js";
import {
    hasLocomotion,
    hasRoutedLocomotion,
} from "../core/tactical/unit/capability/locomotion/capability.js";
import { isSpatiallyPresent } from "../core/tactical/unit/capability/presence.js";
import { hasSpatial } from "../core/tactical/unit/capability/spatial.js";
import {
    hasVitality,
    hasVitalityDefinition,
} from "../core/tactical/unit/capability/vitality/capability.js";
import type { Direction } from "../core/tactical/geometry/direction.js";
import type { Unit, UnitId } from "../core/tactical/unit/unit.js";

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
}

export type LegacyVisualEvent =
    | readonly ["atk", sourceId: UnitId, targetId: UnitId, "none"]
    | readonly ["dmg", targetId: UnitId, amount: number, "phys" | "arts" | "true"]
    | readonly ["heal", targetId: UnitId, amount: number]
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

const DEATH_WINDOW_TICKS = 24;
const ATTACK_REPLAY_TICKS = 8;
const DAMAGE_TYPE = { PHYSICAL: "phys", ARTS: "arts", TRUE: "true" } as const satisfies Record<
    DamageType,
    string
>;

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

function unitInfo(unit: Unit, data: LegacyData): LegacyUnitInfo {
    const enemy = isEnemy(unit);
    const chess = record(data.lookup("chess", unit.definition.id));
    const operator = Object.keys(chess).length > 0;
    const assetId =
        unit.definition.id === "enemy_1000_gopro" ? "enemy_1000_gopro_2" : unit.definition.id;
    const metadata = operator ? chess : record(data.lookup(enemy ? "enemies" : "tokens", assetId));
    const assets = record(metadata.assets);
    const fallbackAsset = text(metadata.charId, assetId);
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
        maxHp: hasVitalityDefinition(unit.definition) ? unit.definition.vitality.maxHp : 0,
        motion: isFlying(unit) ? "FLY" : "WALK",
    };
}

function unitTuple(unit: Unit, snapshot: Snapshot, dead = false): number[] {
    const blocked = snapshot.blockingRelations.some(
        (relation) => relation.blockedUnitId === unit.id,
    );
    const flags = (blocked ? 1 : 0) | (isFlying(unit) ? 512 : 0);
    let animation = 0;

    if (dead) {
        animation = 4;
    } else if (hasLocomotion(unit) && unit.locomotion.moving) {
        animation = 1;
    }

    return [
        unit.id,
        ...unit.position,
        !dead && hasVitality(unit) ? unit.vitality.hp : 0,
        hasVitalityDefinition(unit.definition) ? unit.definition.vitality.maxHp : 0,
        0,
        0,
        flags,
        animation,
    ];
}

export class TacticalDemoPresentation {
    readonly #data: LegacyData;
    readonly #tombstones = new Map<UnitId, Tombstone>();
    readonly #attacks = new Map<UnitId, RecentAttack>();
    #killedCount = 0;
    #attackCount = 0;
    #damageCount = 0;

    constructor(data: LegacyData) {
        this.#data = data;
    }

    reset(): void {
        this.#tombstones.clear();
        this.#attacks.clear();
        this.#killedCount = 0;
        this.#attackCount = 0;
        this.#damageCount = 0;
    }

    advance(after: Snapshot, events: readonly Event[]): readonly LegacyVisualEvent[] {
        const visible: LegacyVisualEvent[] = [];

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
                    const attack = ["atk", event.sourceUnitId, event.targetUnitId, "none"] as const;
                    this.#attackCount++;
                    this.#attacks.set(event.sourceUnitId, {
                        event: attack,
                        expiresAtTick: after.tickIndex + ATTACK_REPLAY_TICKS,
                    });
                    visible.push(attack);
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
                case "ACTION_RELEASED":
                case "ACTION_FINISHED":
                case "ACTION_CANCELLED":
                case "PROJECTILE_REACHED":
                case "PROJECTILE_HIT":
                case "PROJECTILE_STOPPED":
                case "SKILL_ACTIVATED":
                case "SKILL_FINISHED":
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

    stats(): {
        readonly killedCount: number;
        readonly attackCount: number;
        readonly damageCount: number;
    } {
        return {
            killedCount: this.#killedCount,
            attackCount: this.#attackCount,
            damageCount: this.#damageCount,
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
