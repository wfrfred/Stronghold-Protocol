import type { Event, Snapshot } from "../core/tactical/battle/contract.js";
import type { DamageType } from "../core/tactical/battle/damage/contract.js";
import { hasAllegiance } from "../core/tactical/unit/capability/allegiance/capability.js";
import {
    hasElemental,
    type Type as ElementType,
} from "../core/tactical/unit/capability/elemental/capability.js";
import { damageRatio, currentType } from "../core/tactical/unit/capability/elemental/query.js";
import { hasLocomotion } from "../core/tactical/unit/capability/locomotion/capability.js";
import { hasRoute } from "../core/tactical/unit/capability/route/capability.js";
import { isSpatiallyPresent } from "../core/tactical/unit/capability/presence/capability.js";
import { hasLayer } from "../core/tactical/unit/capability/layer/capability.js";
import { hasSkill } from "../core/tactical/unit/capability/skill/capability.js";
import { stun } from "../content/tactical/effects/stun.js";
import { invincible } from "../content/tactical/effects/protection.js";
import {
    hasVitality,
    hasVitalityDefinition,
    resolveMaxHp as resolveVitalityMaxHp,
} from "../core/tactical/unit/capability/vitality/capability.js";
import type { Direction } from "../core/tactical/geometry/direction.js";
import type { Unit, Id } from "../core/tactical/unit/unit.js";
import { TICKS_PER_SECOND } from "../core/tactical/tick.js";

export interface LegacyData {
    lookup(file: string, key: string): unknown;
}

export interface LegacyUnitAnimation {
    readonly attack?: string;
    readonly skillAttack?: string;
    readonly skill?: "BUFF" | "ATTACK";
    readonly recoverySeconds?: number;
    readonly lunge?: boolean;
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
    readonly animation?: LegacyUnitAnimation;
}

export interface LegacyUnitMetadata {
    readonly kind: LegacyUnitInfo["kind"];
    readonly name: string;
    readonly spine: string;
    readonly avatar: string;
    readonly skillIndex?: number;
    readonly animation?: LegacyUnitAnimation;
    readonly direction?: Direction;
}

type LegacyElementType = "neural" | "erosion" | "burn" | "apoptosis";

export type LegacyElementGauge = readonly [
    unitId: Id,
    element: LegacyElementType,
    fill: number,
    cooldownEnd: number,
    cooldown: number,
];

export type LegacyVisualEvent =
    | readonly ["atk", sourceId: Id, targetId: Id, "none", animation?: { readonly skill: boolean }]
    | readonly ["dmg", targetId: Id, amount: number, "phys" | "arts" | "true" | LegacyElementType]
    | readonly ["heal", targetId: Id, amount: number]
    | readonly ["skill", unitId: Id, active: boolean]
    | readonly [
          "fx",
          "burst",
          x: number,
          y: number,
          { readonly id: Id; readonly element: LegacyElementType },
      ]
    | readonly ["die", unitId: Id, "killed"]
    | readonly ["leak", unitId: Id];

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
    readonly unitMetadata?: (unit: Unit) => LegacyUnitMetadata | undefined;
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
    return hasAllegiance(unit) ? unit.allegiance.side === "ENEMY" : hasRoute(unit);
}

function isFlying(unit: Unit): boolean {
    if (hasLayer(unit)) {
        return unit.layer.type === "AIR";
    }

    return hasRoute(unit) && unit.definition.route.pathMotionMode === "FLY";
}

function maxHp(unit: Unit): number {
    if (hasVitality(unit)) {
        return resolveVitalityMaxHp(unit.vitality, unit.definition.vitality);
    }

    return hasVitalityDefinition(unit.definition) ? unit.definition.vitality.maxHp : 0;
}

function skillActive(unit: Unit, animation?: LegacyUnitAnimation["skill"]): boolean {
    return (
        animation !== "ATTACK" &&
        hasSkill(unit) &&
        unit.definition.skill.activation?.trigger !== "PASSIVE" &&
        (!hasVitality(unit) || unit.vitality.hp > 0) &&
        unit.skill.active !== null
    );
}

function unitInfo(unit: Unit, data: LegacyData, supplied?: LegacyUnitMetadata): LegacyUnitInfo {
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
    const skillIndex =
        supplied?.skillIndex ?? skills.find((skill) => skill.skillId === skillId)?.index;
    const direction = "direction" in unit.definition ? unit.definition.direction : undefined;
    const dir: Direction =
        supplied?.direction ??
        (direction === "UP" || direction === "DOWN" || direction === "LEFT" || direction === "RIGHT"
            ? direction
            : "RIGHT");

    const facing = enemy && hasLocomotion(unit) ? unit.locomotion.velocity[0] > 0 : dir !== "LEFT";
    let kind: LegacyUnitInfo["kind"] = "device";

    if (operator) {
        kind = "op";
    } else if (enemy) {
        kind = "enemy";
    }

    return {
        id: unit.id,
        kind: supplied?.kind ?? kind,
        side: enemy ? "enemy" : "ally",
        defId: unit.definition.id,
        name: supplied?.name ?? text(metadata.name, unit.definition.id),
        spine: supplied?.spine ?? text(assets.spine, text(metadata.spine, fallbackAsset)),
        avatar:
            supplied?.avatar ??
            text(assets.avatar, text(metadata.iconId, text(metadata.avatar, fallbackAsset))),
        x: unit.position[0],
        y: unit.position[1],
        facing: facing ? 1 : -1,
        dir,
        maxHp: maxHp(unit),
        motion: isFlying(unit) ? "FLY" : "WALK",
        skillActive: skillActive(unit, supplied?.animation?.skill),
        ...(typeof skillIndex === "number" ? { skillIndex } : {}),
        ...supplied,
    };
}

function unitTuple(
    unit: Unit,
    snapshot: Snapshot,
    {
        dead = false,
        moving = false,
        skillAnimation,
    }: {
        readonly dead?: boolean;
        readonly moving?: boolean;
        readonly skillAnimation?: LegacyUnitAnimation["skill"];
    } = {},
): number[] {
    const blocked = snapshot.blockingRelations.some(
        (relation) => relation.blockedUnitId === unit.id,
    );
    const stunned = unit.effects
        .values()
        .some((effect) => effect.definition === stun && effect.status === "ACTIVE");
    const protectedFromDamage = unit.effects
        .values()
        .some((effect) => effect.definition === invincible && effect.status === "ACTIVE");
    const flags =
        (blocked ? 1 : 0) |
        (isFlying(unit) ? 512 : 0) |
        (stunned ? 2 : 0) |
        (!dead && skillActive(unit, skillAnimation) ? 16 : 0) |
        (protectedFromDamage ? 64 : 0);
    let animation = 0;

    if (dead) {
        animation = 4;
    } else if (stunned) {
        animation = 5;
    } else if (moving) {
        animation = 1;
    }

    let sp = 0;
    let spMax = 0;

    if (!dead && hasSkill(unit)) {
        const definition = unit.definition.skill;
        const active = unit.skill.active;
        sp = unit.skill.sp?.value ?? 0;
        spMax = definition.sp?.requirement ?? 0;

        if (active !== null) {
            const sustain = active.sustain;

            if (sustain.type === "AMMO") {
                sp = spMax * (Math.max(0, sustain.remaining) / Math.max(1, sustain.initial));
            } else if (sustain.type === "TIME" && sustain.endsAtTick > active.startedAtTick) {
                const remaining = Math.max(0, sustain.endsAtTick - snapshot.tickIndex);
                sp = spMax * (remaining / (sustain.endsAtTick - active.startedAtTick));
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
    readonly #unitMetadata: TacticalDemoPresentationOptions["unitMetadata"];
    readonly #tombstones = new Map<Id, Tombstone>();
    readonly #attacks = new Map<Id, RecentAttack>();
    readonly #pendingAttackTargets = new Map<Id, Id>();
    readonly #activeSkillAttacks = new Set<Id>();
    #lastPresentedSnapshot: Snapshot | undefined;
    #movingUnitIds = new Set<Id>();
    #killedCount = 0;
    #attackCount = 0;
    #damageCount = 0;
    #elementDamageCount = 0;
    #elementBurstCount = 0;

    constructor(data: LegacyData, options: TacticalDemoPresentationOptions = {}) {
        this.#data = data;
        this.#projectileActions = options.projectileActions === true;
        this.#unitMetadata = options.unitMetadata;
    }

    reset(): void {
        this.#tombstones.clear();
        this.#attacks.clear();
        this.#pendingAttackTargets.clear();
        this.#activeSkillAttacks.clear();
        this.#lastPresentedSnapshot = undefined;
        this.#movingUnitIds.clear();
        this.#killedCount = 0;
        this.#attackCount = 0;
        this.#damageCount = 0;
        this.#elementDamageCount = 0;
        this.#elementBurstCount = 0;
    }

    advance(after: Snapshot, events: readonly Event[]): readonly LegacyVisualEvent[] {
        const visible: LegacyVisualEvent[] = [];
        const resumableSources = new Set<Id>();

        if (this.#projectileActions) {
            for (const execution of after.actions.instances) {
                resumableSources.add(execution.source.id);
            }
            for (const event of events) {
                if (event.type === "ACTION_RELEASED" || event.type === "ACTION_CANCELLED") {
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
                        unit.definition.skill.activation?.trigger === "PASSIVE"
                    ) {
                        break;
                    }

                    if (
                        this.#activeSkillAttacks.has(event.unitId) ||
                        (unit !== undefined &&
                            this.#unitMetadata?.(unit)?.animation?.skill === "ATTACK")
                    ) {
                        if (event.type === "SKILL_ACTIVATED") {
                            this.#activeSkillAttacks.add(event.unitId);
                        } else {
                            this.#activeSkillAttacks.delete(event.unitId);
                        }

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
                            candidate.unitId === event.burst.host.id,
                    );
                    const unit =
                        after.units.find((unit) => unit.id === event.burst.host.id) ??
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
                    this.#activeSkillAttacks.delete(event.unitId);

                    if (event.reason !== "DEATH") {
                        break;
                    }

                    visible.push(["die", event.unitId, "killed"]);

                    const unit = event.unit;

                    if (isEnemy(unit)) {
                        this.#killedCount++;
                    }

                    this.#tombstones.set(event.unitId, {
                        info: unitInfo(unit, this.#data, this.#unitMetadata?.(unit)),
                        tuple: unitTuple(unit, after, { dead: true }),
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
                case "ELEMENT_BURST_ENDED":
                case "UNIT_DEPLOYED":
                case "DEPLOYMENT_REJECTED":
                case "UNIT_RELOCATED":
                case "SUPPORT_LOST":
                case "ROUTE":
                    break;
            }
        }

        return visible;
    }

    #attack(source: Id, target: Id, tick: number): RecentAttack["event"] {
        const event: RecentAttack["event"] = this.#activeSkillAttacks.has(source)
            ? ["atk", source, target, "none", { skill: true }]
            : ["atk", source, target, "none"];
        this.#attacks.set(source, {
            event,
            expiresAtTick: tick + ATTACK_REPLAY_TICKS,
        });

        return event;
    }

    units(snapshot: Snapshot): readonly PresentedUnit[] {
        if (snapshot.tickIndex !== this.#lastPresentedSnapshot?.tickIndex) {
            const previous = new Map(
                this.#lastPresentedSnapshot?.units.map((unit) => [unit.id, unit.position]),
            );
            this.#movingUnitIds = new Set(
                snapshot.units
                    .filter((unit) => {
                        const position = previous.get(unit.id);

                        return (
                            hasLocomotion(unit) &&
                            position !== undefined &&
                            (position[0] !== unit.position[0] || position[1] !== unit.position[1])
                        );
                    })
                    .map((unit) => unit.id),
            );
            this.#lastPresentedSnapshot = snapshot;
        }

        const presented = snapshot.units.filter(isSpatiallyPresent).map((unit) => {
            const supplied = this.#unitMetadata?.(unit);

            return {
                info: unitInfo(unit, this.#data, supplied),
                tuple: unitTuple(unit, snapshot, {
                    moving: this.#movingUnitIds.has(unit.id),
                    skillAnimation: supplied?.animation?.skill,
                }),
            };
        });
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

            const recovery = unit.elemental.burst;

            if (recovery !== null) {
                gauges.push([
                    unit.id,
                    ELEMENT_TYPE[recovery.type],
                    1,
                    (snapshot.tickIndex + recovery.remainingTicks) / TICKS_PER_SECOND,
                    unit.definition.elemental.bursts[recovery.type].durationTicks /
                        TICKS_PER_SECOND,
                ]);
                continue;
            }

            const type = currentType(unit);

            if (type === undefined) {
                continue;
            }

            const fill = Math.min(
                0.99,
                Math.max(0.01, Math.floor(damageRatio(unit) * 100 + 1e-9) / 100),
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
