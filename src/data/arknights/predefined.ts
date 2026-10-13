import {
    assertNonnegativeNumber,
    assertPositiveNumber,
    assertPositiveSafeInteger,
} from "../../core/common/assert.js";
import {
    createPredefinedDefinition,
    type PredefinedDefinition,
} from "../../core/tactical/battle/steps/predefined.js";
import { createMechanismDefinition } from "../../core/tactical/battlefield/mechanism.js";
import { createNavigationModifierDefinition } from "../../core/tactical/battlefield/navigation/modifier.js";
import { Tile, createTileOffset } from "../../core/tactical/geometry/coordinate.js";
import { RangeGrid } from "../../core/tactical/geometry/range.js";
import {
    createDefinition as createDeployableDefinition,
    type Deployable,
} from "../../core/tactical/unit/capability/deployable/capability.js";
import {
    createDefinition as createTileBindingDefinition,
    type TileBinding,
} from "../../core/tactical/unit/capability/tile-binding/capability.js";
import type { Definition as UnitDefinition } from "../../core/tactical/unit/unit.js";
import {
    validateState as validateOccupancyState,
    type State as OccupancyState,
} from "../../core/tactical/unit/capability/occupancy/capability.js";
import type { Definition as VitalityDefinition } from "../../core/tactical/unit/capability/vitality/capability.js";
import type { ArknightsPredefinedInstance } from "./level.js";
import type { PredefinedPrefab } from "./prefab.js";
import { secondsToTicks } from "./tick.js";

function object(value: unknown, name: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${name} must be an object`);
    }

    return value as Record<string, unknown>;
}

function characterPhase(
    instance: ArknightsPredefinedInstance,
    characterValue: unknown,
): Record<string, unknown> {
    const character = object(characterValue, "predefined character record");

    if (!Array.isArray(character.phases)) {
        throw new TypeError("predefined character phases must be an array");
    }

    const phaseIndex = Number(instance.inst.phase.slice(-1));

    return object(character.phases[phaseIndex], "predefined character phase");
}

function phasePrefabKey(phase: Record<string, unknown>): string {
    const key = phase.characterPrefabKey;

    if (typeof key !== "string" || key.length === 0) {
        throw new TypeError("predefined character prefab key must be nonempty");
    }

    return key;
}

export function resolvePredefinedPrefabKey(
    instance: ArknightsPredefinedInstance,
    characterValue: unknown,
): string {
    return phasePrefabKey(characterPhase(instance, characterValue));
}

function predefinedCharacter(
    instance: ArknightsPredefinedInstance,
    profile: PredefinedPrefab,
    characterValue: unknown,
): Record<string, unknown> {
    if (
        instance.uniEquipIds !== null ||
        instance.masterInfos !== null ||
        instance.overrideTalents !== null ||
        instance.tmplId !== null ||
        (instance.skinId !== null && instance.skinId !== "")
    ) {
        throw new TypeError(
            `unsupported predefined character customization for ${instance.inst.characterKey}`,
        );
    }

    const phase = characterPhase(instance, characterValue);

    if (phasePrefabKey(phase) !== profile.prefabKey) {
        throw new TypeError(`predefined character prefab does not match ${profile.prefabKey}`);
    }

    return phase;
}

function unitDefinition(
    instance: ArknightsPredefinedInstance,
    phase: Record<string, unknown>,
    profile: Extract<PredefinedPrefab, { readonly type: "UNIT" }>,
): UnitDefinition & { readonly vitality: VitalityDefinition } & TileBinding["definition"] &
    Deployable["definition"] {
    if (instance.inst.potentialRank !== 0 || instance.inst.favorPoint !== 0) {
        throw new TypeError("predefined unit potential and favor modifiers are not supported");
    }
    if (!Array.isArray(phase.attributesKeyFrames) || phase.attributesKeyFrames.length === 0) {
        throw new TypeError("predefined unit requires attribute keyframes");
    }

    let maxHp: number | undefined;
    let cost: number | undefined;
    let respawnTime: number | undefined;
    let minimumLevel = Infinity;
    let maximumLevel = -Infinity;

    for (const value of phase.attributesKeyFrames) {
        const frame = object(value, "predefined attribute keyframe");
        const attributes = object(frame.data, "predefined keyframe attributes");

        assertPositiveSafeInteger(frame.level, "predefined keyframe level");

        const hp = attributes.maxHp;
        const frameCost = attributes.cost;
        const frameRespawnTime = attributes.respawnTime;

        assertPositiveNumber(hp, "predefined maxHp");
        assertNonnegativeNumber(frameCost, "predefined deployment cost");
        assertNonnegativeNumber(frameRespawnTime, "predefined respawn time");

        if (
            (maxHp !== undefined && maxHp !== hp) ||
            (cost !== undefined && cost !== frameCost) ||
            (respawnTime !== undefined && respawnTime !== frameRespawnTime)
        ) {
            throw new TypeError("varying predefined unit attributes are not supported");
        }

        maxHp = hp;
        cost = frameCost;
        respawnTime = frameRespawnTime;
        minimumLevel = Math.min(minimumLevel, frame.level);
        maximumLevel = Math.max(maximumLevel, frame.level);
    }

    if (instance.inst.level < minimumLevel || instance.inst.level > maximumLevel) {
        throw new RangeError("predefined unit level is outside attribute keyframes");
    }

    return Object.freeze({
        id: instance.inst.characterKey,
        vitality: Object.freeze({ maxHp: maxHp! }),
        tileBinding: createTileBindingDefinition(profile.tileBinding),
        deployable: createDeployableDefinition({
            ...profile.deployable,
            cost: cost!,
            redeployTicks: secondsToTicks(respawnTime!),
            slots: 0,
        }),
    });
}

export function parsePredefinedDefinition(
    id: number,
    instance: ArknightsPredefinedInstance,
    profile: PredefinedPrefab,
    characterValue: unknown,
): PredefinedDefinition {
    const phase = predefinedCharacter(instance, profile, characterValue);

    if (profile.type === "MECHANISM") {
        return createPredefinedDefinition({
            id,
            alias: instance.alias,
            initiallyPresent: !instance.hidden,
            creation: {
                type: "MECHANISM",
                definition: createMechanismDefinition({ id: instance.inst.characterKey }),
                navigationModifiers: [],
            },
        });
    }

    const navigationModifierDefinition = createNavigationModifierDefinition({
        id: `${profile.prefabKey}:tile-navigation`,
        WALK: { denyPassage: false, deniedDepartures: [], costFloor: profile.walkCostFloor },
        FLY: null,
    });
    const definition = unitDefinition(instance, phase, profile);
    const position = Tile.center(instance.position);
    const occupancy: OccupancyState = {
        claims: [{ position: instance.position, slot: "SUPPORT", type: "PRESENT" }],
    };
    validateOccupancyState(occupancy);

    return createPredefinedDefinition({
        id,
        alias: instance.alias,
        initiallyPresent: !instance.hidden,
        creation: {
            type: "UNIT",
            definition,
            position,
            states: { occupancy },
            navigationModifiers: [
                {
                    definition: navigationModifierDefinition,
                    range: RangeGrid.create([createTileOffset(0, 0)]),
                    direction: instance.direction,
                },
            ],
        },
    });
}
