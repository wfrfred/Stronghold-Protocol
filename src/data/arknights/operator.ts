import {
    assertFiniteNumber,
    assertNonnegativeSafeInteger,
    assertPositiveSafeInteger,
} from "../../core/common/assert.js";
import { createTilePosition } from "../../core/tactical/geometry/coordinate.js";
import { RangeGrid } from "../../core/tactical/geometry/range.js";
import { parseBlackboard, type ArknightsBlackboardEntry } from "./blackboard.js";
import { parseArknightsSkillLevel, type ArknightsSkillLevel } from "./skill-definition.js";

export interface Configuration {
    readonly elite: 0 | 1 | 2;
    readonly level: number;
    readonly potential: 1 | 2 | 3 | 4 | 5 | 6;
    readonly skillIndex: number;
    readonly skillLevel: number;
    readonly trust: number;
    readonly module?: { readonly id: string; readonly level: 1 | 2 | 3 };
}

interface Attributes {
    maxHp: number;
    attack: number;
    defense: number;
    resistance: number;
    attackSpeed: number;
    baseAttackTime: number;
    blockCapacity: number;
    cost: number;
    respawnTime: number;
}

interface Talent {
    readonly key: string;
    readonly blackboard: readonly ArknightsBlackboardEntry[];
}

export interface Profile {
    readonly id: string;
    readonly configuration: Configuration;
    readonly attributes: Readonly<Attributes>;
    readonly range: RangeGrid;
    readonly skill: ArknightsSkillLevel;
    readonly skillRange: RangeGrid | null;
    readonly talents: readonly Talent[];
    readonly moduleTrait: readonly ArknightsBlackboardEntry[];
}

interface Tables {
    readonly ranges: unknown;
    readonly favor: unknown;
    readonly equipment?: unknown;
    readonly battleEquipment?: unknown;
}

const potentialAttributes: Readonly<Record<string, keyof Attributes>> = {
    MAX_HP: "maxHp",
    ATK: "attack",
    DEF: "defense",
    MAGIC_RESISTANCE: "resistance",
    ATTACK_SPEED: "attackSpeed",
    COST: "cost",
    RESPAWN_TIME: "respawnTime",
};

const moduleAttributes: Readonly<Record<string, keyof Attributes>> = {
    max_hp: "maxHp",
    atk: "attack",
    def: "defense",
    magic_resistance: "resistance",
    attack_speed: "attackSpeed",
    block_cnt: "blockCapacity",
    cost: "cost",
    respawn_time: "respawnTime",
};

function record(value: unknown, name: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${name} must be an object`);
    }

    return value as Record<string, unknown>;
}

function array(value: unknown, name: string): readonly unknown[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${name} must be an array`);
    }

    for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index) || value[index] === undefined) {
            throw new TypeError(`${name} must be dense`);
        }
    }

    return value as readonly unknown[];
}

function text(value: unknown, name: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`${name} must be a nonempty string`);
    }

    return value;
}

function number(value: unknown, name: string): number {
    assertFiniteNumber(value, name);

    return value;
}

function elite(value: unknown): Configuration["elite"] {
    switch (value) {
        case "PHASE_0":
            return 0;

        case "PHASE_1":
            return 1;

        case "PHASE_2":
            return 2;

        default:
            throw new TypeError(`unknown elite phase ${String(value)}`);
    }
}

function unlocked(value: unknown, configuration: Configuration): boolean {
    const condition = record(value, "unlock condition");
    const phase = elite(condition.phase);
    const level = condition.level;
    assertNonnegativeSafeInteger(level, "unlock level");

    return (
        configuration.elite > phase ||
        (configuration.elite === phase && configuration.level >= level)
    );
}

function validateConfiguration(configuration: Configuration): void {
    assertNonnegativeSafeInteger(configuration.elite, "operator elite");
    assertPositiveSafeInteger(configuration.level, "operator level");
    assertPositiveSafeInteger(configuration.potential, "operator potential");
    assertNonnegativeSafeInteger(configuration.skillIndex, "operator skill index");
    assertPositiveSafeInteger(configuration.skillLevel, "operator skill level");
    assertNonnegativeSafeInteger(configuration.trust, "operator trust percentage");

    if (configuration.elite > 2 || configuration.potential > 6 || configuration.trust > 200) {
        throw new RangeError("operator configuration is outside its supported range");
    }
    if (configuration.module !== undefined) {
        text(configuration.module.id, "module identity");
        assertPositiveSafeInteger(configuration.module.level, "module level");

        if (configuration.module.level > 3) {
            throw new RangeError("module level must be between 1 and 3");
        }
    }
}

function readAttributes(value: unknown): Attributes {
    const data = record(value, "operator attribute data");

    return {
        maxHp: number(data.maxHp, "operator maxHp"),
        attack: number(data.atk, "operator attack"),
        defense: number(data.def, "operator defense"),
        resistance: number(data.magicResistance, "operator resistance"),
        attackSpeed: number(data.attackSpeed, "operator attack speed"),
        baseAttackTime: number(data.baseAttackTime, "operator base attack time"),
        blockCapacity: number(data.blockCnt, "operator block capacity"),
        cost: number(data.cost, "operator cost"),
        respawnTime: number(data.respawnTime, "operator respawn time"),
    };
}

function interpolateAttributes(value: unknown, level: number): Attributes {
    const frames = array(value, "operator attribute keyframes").map((value) => {
        const frame = record(value, "operator attribute keyframe");
        assertNonnegativeSafeInteger(frame.level, "operator attribute keyframe level");

        return { level: frame.level, attributes: readAttributes(frame.data) };
    });
    const first = frames[0];
    const last = frames.at(-1);

    if (first === undefined || last === undefined || level < first.level || level > last.level) {
        throw new RangeError("operator level is outside attribute keyframes");
    }

    for (let index = 1; index < frames.length; index++) {
        if (frames[index]!.level <= frames[index - 1]!.level) {
            throw new TypeError("operator attribute keyframes must have increasing levels");
        }
    }

    const upperIndex = frames.findIndex((frame) => frame.level >= level);
    const upper = frames[upperIndex]!;
    const lower = frames[Math.max(0, upperIndex - 1)]!;
    const ratio =
        upper.level === lower.level ? 0 : (level - lower.level) / (upper.level - lower.level);
    const attributes = { ...lower.attributes };

    for (const key of Object.keys(attributes) as (keyof Attributes)[]) {
        attributes[key] += (upper.attributes[key] - lower.attributes[key]) * ratio;
    }

    return attributes;
}

function trustFrame(
    value: unknown,
    percentage: number,
): { battlePhase: number; favorPoint: number } {
    const favor = record(value, "favor table");
    const frames = array(favor.favorFrames, "favor frames");

    for (const value of frames) {
        const frame = record(value, "favor frame");
        const data = record(frame.data, "favor frame data");

        if (data.percent !== percentage) {
            continue;
        }

        assertNonnegativeSafeInteger(data.battlePhase, "favor battle phase");
        assertNonnegativeSafeInteger(data.favorPoint, "favor point");

        return { battlePhase: data.battlePhase, favorPoint: data.favorPoint };
    }

    throw new RangeError(`unknown trust percentage ${percentage}`);
}

function applyPotential(
    character: Record<string, unknown>,
    rank: number,
    attributes: Attributes,
): void {
    const ranks = array(character.potentialRanks, "operator potential ranks");

    if (rank > ranks.length) {
        throw new RangeError("operator potential exceeds its available ranks");
    }

    for (const value of ranks.slice(0, rank)) {
        const potential = record(value, "operator potential rank");

        if (potential.type === "CUSTOM" && potential.buff === null) {
            continue;
        }
        if (potential.type !== "BUFF") {
            throw new TypeError("unsupported operator potential type");
        }

        const buff = record(potential.buff, "potential buff");
        const data = record(buff.attributes, "potential buff attributes");

        for (const value of array(data.attributeModifiers, "potential attribute modifiers")) {
            const modifier = record(value, "potential attribute modifier");
            const type = text(modifier.attributeType, "potential attribute type");
            const key = Object.hasOwn(potentialAttributes, type)
                ? potentialAttributes[type]
                : undefined;

            if (
                key === undefined ||
                modifier.formulaItem !== "ADDITION" ||
                modifier.loadFromBlackboard !== false ||
                modifier.fetchBaseValueFromSourceEntity !== false
            ) {
                throw new TypeError("unsupported operator potential attribute modifier");
            }

            attributes[key] += number(modifier.value, "potential attribute addition");
        }
    }
}

function selectedSkill(
    character: Record<string, unknown>,
    skill: unknown,
    configuration: Configuration,
): {
    parsed: ArknightsSkillLevel;
    rangeId: unknown;
} {
    const selected = record(
        array(character.skills, "operator skills")[configuration.skillIndex],
        "selected operator skill",
    );
    const source = record(skill, "skill record");

    if (source.skillId !== text(selected.skillId, "selected skill identity")) {
        throw new TypeError("selected skill record does not match the operator skill");
    }
    if (!unlocked(selected.unlockCond, configuration)) {
        throw new RangeError("selected operator skill is locked");
    }

    const common = array(character.allSkillLvlup, "common skill upgrades");
    const mastery = array(selected.levelUpCostCond, "skill mastery upgrades");
    const upgrades = [...common, ...mastery];

    if (configuration.skillLevel > upgrades.length + 1) {
        throw new RangeError("selected skill level exceeds its available upgrades");
    }

    for (const value of upgrades.slice(0, configuration.skillLevel - 1)) {
        if (!unlocked(record(value, "skill upgrade").unlockCond, configuration)) {
            throw new RangeError("selected skill level requires a higher elite phase or level");
        }
    }

    const level = record(
        array(source.levels, "skill levels")[configuration.skillLevel - 1],
        "selected skill level",
    );

    if (level.durationType === "AMMO" || level.durationType === 1) {
        throw new TypeError(
            "AMMO operator skills require dedicated content and are unsupported here",
        );
    }

    return {
        parsed: parseArknightsSkillLevel(skill, configuration.skillLevel),
        rangeId: level.rangeId,
    };
}

function range(value: unknown, id: unknown): RangeGrid {
    const key = text(id, "operator range identity");
    const source = record(record(value, "range table")[key], `range ${key}`);

    if (source.id !== key || source.direction !== 1) {
        throw new TypeError("operator range must use its matching identity and default direction");
    }

    return RangeGrid.create(
        array(source.grids, "range grids").map((value) => {
            const grid = record(value, "range grid");

            return createTilePosition(
                number(grid.row, "range row"),
                number(grid.col, "range column"),
            );
        }),
    );
}

function selectCandidate(
    value: unknown,
    configuration: Configuration,
): Record<string, unknown> | undefined {
    let selected:
        | { candidate: Record<string, unknown>; phase: number; level: number; rank: number }
        | undefined;

    for (const entry of array(value, "talent candidates")) {
        const candidate = record(entry, "talent candidate");
        const rank = candidate.requiredPotentialRank;
        assertNonnegativeSafeInteger(rank, "talent required potential rank");

        if (
            rank > configuration.potential - 1 ||
            !unlocked(candidate.unlockCondition, configuration)
        ) {
            continue;
        }
        if (candidate.validModeIndices !== undefined && candidate.validModeIndices !== null) {
            throw new TypeError("mode-specific operator talent candidates are unsupported");
        }

        const condition = record(candidate.unlockCondition, "talent unlock condition");
        const phase = elite(condition.phase);
        const level = number(condition.level, "talent unlock level");

        if (
            selected === undefined ||
            phase > selected.phase ||
            (phase === selected.phase && level > selected.level) ||
            (phase === selected.phase && level === selected.level && rank > selected.rank)
        ) {
            selected = { candidate, phase, level, rank };
        }
    }

    return selected?.candidate;
}

function talent(candidate: Record<string, unknown>): Talent {
    return {
        key: text(candidate.prefabKey, "talent prefab key"),
        blackboard: parseBlackboard(candidate.blackboard, "talent blackboard"),
    };
}

function applyModule(
    id: string,
    configuration: Configuration,
    tables: Tables,
    favorPoint: number,
    attributes: Attributes,
    talents: (Talent | undefined)[],
): readonly ArknightsBlackboardEntry[] {
    const module = configuration.module;

    if (module === undefined) {
        return [];
    }

    const equipment = record(tables.equipment, "module equipment record");

    if (equipment.uniEquipId !== module.id || equipment.charId !== id) {
        throw new TypeError("module equipment does not match the selected operator and module");
    }
    if (
        !unlocked(
            { phase: equipment.unlockEvolvePhase, level: equipment.unlockLevel },
            configuration,
        )
    ) {
        throw new RangeError("module requires a higher elite phase or level");
    }

    const favors = record(equipment.unlockFavors, "module trust unlocks");
    const requiredFavor = favors[module.level];
    assertNonnegativeSafeInteger(requiredFavor, "module required favor point");

    if (favorPoint < requiredFavor) {
        throw new RangeError("module level requires more trust");
    }

    const battle = record(tables.battleEquipment, "module battle equipment record");
    const phase = array(battle.phases, "module phases")
        .map((value) => record(value, "module phase"))
        .find((phase) => phase.equipLevel === module.level);

    if (phase === undefined) {
        throw new RangeError("unknown module level");
    }

    for (const entry of parseBlackboard(phase.attributeBlackboard, "module attributes")) {
        const key = Object.hasOwn(moduleAttributes, entry.key)
            ? moduleAttributes[entry.key]
            : undefined;

        if (key === undefined || entry.valueStr !== null) {
            throw new TypeError(`unsupported module attribute ${entry.key}`);
        }

        attributes[key] += entry.value;
    }

    const trait = new Map<string, ArknightsBlackboardEntry>();

    for (const value of array(phase.parts, "module parts")) {
        const part = record(value, "module part");

        if (part.isToken === true || part.target === "DISPLAY") {
            continue;
        }
        if (
            (part.validInGameTag !== undefined && part.validInGameTag !== null) ||
            (part.validInMapTag !== undefined && part.validInMapTag !== null)
        ) {
            throw new TypeError("mode-specific operator module parts are unsupported");
        }
        if (part.target === "TRAIT" || part.target === "TRAIT_DATA_ONLY") {
            const candidate = selectCandidate(
                record(part.overrideTraitDataBundle, "module trait bundle").candidates,
                configuration,
            );

            if (candidate !== undefined) {
                for (const entry of parseBlackboard(
                    candidate.blackboard,
                    "module trait blackboard",
                )) {
                    trait.set(entry.key, entry);
                }
            }
        } else if (part.target === "TALENT" || part.target === "TALENT_DATA_ONLY") {
            const candidate = selectCandidate(
                record(part.addOrOverrideTalentDataBundle, "module talent bundle").candidates,
                configuration,
            );

            if (candidate === undefined) {
                continue;
            }

            const index = candidate.talentIndex;
            const selected = talent(candidate);

            if (index === -1) {
                const previous = talents.findIndex((talent) => talent?.key === selected.key);

                if (previous === -1) {
                    talents.push(selected);
                } else {
                    talents[previous] = selected;
                }
            } else {
                assertNonnegativeSafeInteger(index, "module talent index");

                if (index >= talents.length) {
                    throw new RangeError(
                        "module talent index is outside the operator talent slots",
                    );
                }

                talents[index] = selected;
            }
        } else {
            throw new TypeError(`unsupported module target ${String(part.target)}`);
        }
    }

    return Array.from(trait.values());
}

export function prepare(
    input: { readonly id: string; readonly record: unknown },
    skill: unknown,
    configuration: Configuration,
    tables: Tables,
): Profile {
    const id = text(input.id, "operator table identity");
    const character = record(input.record, "operator character record");
    validateConfiguration(configuration);
    const phase = record(
        array(character.phases, "operator phases")[configuration.elite],
        "selected operator phase",
    );
    assertPositiveSafeInteger(phase.maxLevel, "operator phase maximum level");

    if (configuration.level > phase.maxLevel) {
        throw new RangeError("operator level exceeds the selected phase maximum");
    }

    const attributes = interpolateAttributes(phase.attributesKeyFrames, configuration.level);
    const favor = trustFrame(tables.favor, configuration.trust);

    if (character.favorKeyFrames !== null) {
        const frames = array(character.favorKeyFrames, "operator favor keyframes");
        const last = record(frames.at(-1), "final operator favor keyframe");
        const bonus = interpolateAttributes(
            frames,
            Math.min(favor.battlePhase, number(last.level, "final favor keyframe level")),
        );

        for (const key of Object.keys(attributes) as (keyof Attributes)[]) {
            attributes[key] += bonus[key];
        }
    }

    applyPotential(character, configuration.potential - 1, attributes);
    const selected = selectedSkill(character, skill, configuration);
    const talents =
        character.talents === null
            ? []
            : array(character.talents, "operator talents").map((value) => {
                  const candidate = selectCandidate(
                      record(value, "operator talent").candidates,
                      configuration,
                  );

                  return candidate === undefined ? undefined : talent(candidate);
              });
    const moduleTrait = applyModule(
        id,
        configuration,
        tables,
        favor.favorPoint,
        attributes,
        talents,
    );

    for (const key of Object.keys(attributes) as (keyof Attributes)[]) {
        assertFiniteNumber(attributes[key], `prepared operator ${key}`);
    }

    return {
        id,
        configuration,
        attributes,
        range: range(tables.ranges, phase.rangeId),
        skill: selected.parsed,
        skillRange: selected.rangeId === null ? null : range(tables.ranges, selected.rangeId),
        talents: talents.filter((talent): talent is Talent => talent !== undefined),
        moduleTrait,
    };
}
