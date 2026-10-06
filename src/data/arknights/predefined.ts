import {
    createPredefinedInstanceDefinition,
    type PredefinedInstanceDefinition,
} from "../../core/tactical/battle/predefined.js";
import { createMechanismDefinition } from "../../core/tactical/battlefield/mechanism.js";
import { createNavigationEffectDefinition } from "../../core/tactical/battlefield/navigation-effect.js";
import { Tile, createTileOffset } from "../../core/tactical/geometry/coordinate.js";
import { RangeGrid } from "../../core/tactical/geometry/range.js";
import type { VitalUnitDefinition } from "../../core/tactical/unit/vitality.js";
import type { ArknightsPredefinedInstance } from "./level.js";
import type { PredefinedPrefab } from "./prefab.js";

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
): VitalUnitDefinition {
    if (instance.inst.potentialRank !== 0 || instance.inst.favorPoint !== 0) {
        throw new TypeError("predefined unit potential and favor modifiers are not supported");
    }
    if (!Array.isArray(phase.attributesKeyFrames) || phase.attributesKeyFrames.length === 0) {
        throw new TypeError("predefined unit requires attribute keyframes");
    }

    let maxHp: number | undefined;
    let minimumLevel = Infinity;
    let maximumLevel = -Infinity;

    for (const value of phase.attributesKeyFrames) {
        const frame = object(value, "predefined attribute keyframe");
        const attributes = object(frame.data, "predefined keyframe attributes");

        if (
            typeof frame.level !== "number" ||
            !Number.isSafeInteger(frame.level) ||
            frame.level < 1
        ) {
            throw new RangeError("predefined keyframe level must be a positive safe integer");
        }

        const hp = attributes.maxHp;

        if (typeof hp !== "number" || !Number.isFinite(hp) || hp <= 0) {
            throw new RangeError("predefined maxHp must be finite and positive");
        }
        if (maxHp !== undefined && maxHp !== hp) {
            throw new TypeError("varying predefined unit attributes are not supported");
        }

        maxHp = hp;
        minimumLevel = Math.min(minimumLevel, frame.level);
        maximumLevel = Math.max(maximumLevel, frame.level);
    }

    if (instance.inst.level < minimumLevel || instance.inst.level > maximumLevel) {
        throw new RangeError("predefined unit level is outside attribute keyframes");
    }

    return Object.freeze({
        id: instance.inst.characterKey,
        vitality: Object.freeze({ maxHp: maxHp! }),
    });
}

export function parsePredefinedInstanceDefinition(
    id: number,
    instance: ArknightsPredefinedInstance,
    profile: PredefinedPrefab,
    characterValue: unknown,
): PredefinedInstanceDefinition {
    const phase = predefinedCharacter(instance, profile, characterValue);

    if (profile.type === "MECHANISM") {
        return createPredefinedInstanceDefinition({
            id,
            alias: instance.alias,
            initiallyPresent: !instance.hidden,
            creation: {
                type: "MECHANISM",
                definition: createMechanismDefinition({ id: instance.inst.characterKey }),
                navigationEffects: [],
            },
        });
    }

    const effect = createNavigationEffectDefinition({
        id: `${profile.prefabKey}:tile-navigation`,
        WALK: { denyPassage: false, deniedDepartures: [], costFloor: profile.walkCostFloor },
        FLY: null,
    });

    return createPredefinedInstanceDefinition({
        id,
        alias: instance.alias,
        initiallyPresent: !instance.hidden,
        creation: {
            type: "UNIT",
            definition: unitDefinition(instance, phase),
            position: Tile.center(instance.position),
            navigationEffects: [
                {
                    definition: effect,
                    range: RangeGrid.create([createTileOffset(0, 0)]),
                    direction: instance.direction,
                },
            ],
        },
    });
}
