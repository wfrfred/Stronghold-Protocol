import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { prepare } from "../../dist/data/arknights/operator.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/arknights/main-mode-units.json", import.meta.url), "utf8"));
const mudrock = "char_311_mudrok";
const melantha = "char_208_melan";
const base = { elite: 2, level: 90, potential: 1, skillIndex: 1, skillLevel: 7, trust: 0 };

function profile(id = mudrock, configuration = base, overrides = {}) {
    const record = overrides.character ?? fixture.characters[id];
    const selected = record.skills[configuration.skillIndex];
    const module = configuration.module?.id;
    return prepare(
        { id, record },
        overrides.skill ?? fixture.skills[selected?.skillId],
        configuration,
        {
            ranges: fixture.ranges,
            favor: fixture.favor,
            ...(module === undefined ? {} : {
                equipment: fixture.equipment[module],
                battleEquipment: fixture.battleEquipment[module],
            }),
            ...overrides.tables,
        },
    );
}

const blackboard = entries => Object.fromEntries(entries.map(entry => [entry.key, entry.value]));
const talent = (profile, key) => blackboard(profile.talents.find(talent => talent.key === key).blackboard);
const approximate = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test("operator profiles use selected phase attributes, explicit table identity and canonical ranges", () => {
    const before = structuredClone(fixture);
    const configuration = { ...base };
    const prepared = profile(mudrock, configuration);
    assert.equal(prepared.id, mudrock);
    assert.equal(prepared.configuration, configuration);
    assert.deepEqual(prepared.attributes, {
        maxHp: 3928, attack: 882, defense: 602, resistance: 10,
        attackSpeed: 100, baseAttackTime: 1.6, blockCapacity: 3, cost: 36, respawnTime: 70,
    });
    assert.deepEqual(prepared.range, [[0, 0], [0, 1]]);
    assert.equal(prepared.skill.definition.id, "skchr_mudrok_2");
    assert.equal(prepared.skill.definition.spCost, 5);
    assert.equal(blackboard(prepared.skill.blackboard).atk_scale, 2.1);
    assert.equal(prepared.skillRange.length, fixture.ranges["x-4"].grids.length);
    assert.deepEqual(prepared.moduleTrait, []);
    assert.deepEqual(fixture, before);
});

test("phase interpolation preserves fractional attributes and rejects levels outside the selected phase", () => {
    const interpolated = profile(mudrock, { ...base, elite: 1, level: 2 });
    approximate(interpolated.attributes.maxHp, 2207 + 660 / 79);
    approximate(interpolated.attributes.attack, 515 + 172 / 79);
    approximate(interpolated.attributes.defense, 347 + 116 / 79);
    assert.equal(interpolated.attributes.cost, 34);
    assert.equal(Number.isInteger(interpolated.attributes.attack), false);
    assert.throws(() => profile(mudrock, { ...base, elite: 1, level: 81 }), /phase maximum/);
    assert.throws(() => profile(mudrock, { ...base, level: 91 }), /phase maximum/);
    assert.throws(() => profile(mudrock, { ...base, level: 0 }), /positive safe integer/);
    assert.throws(() => profile(mudrock, { ...base, level: 2.5 }), /integer/);
    assert.throws(() => profile(melantha, { ...base, skillIndex: 0 }), /selected operator phase/);
});

test("UI potential maps to cumulative raw ranks and selects the unlocked talent candidate", () => {
    const one = profile();
    const two = profile(mudrock, { ...base, potential: 2 });
    const four = profile(mudrock, { ...base, potential: 4 });
    const six = profile(mudrock, { ...base, potential: 6 });
    assert.equal(one.attributes.cost, 36);
    assert.equal(two.attributes.cost, 35);
    assert.equal(four.attributes.defense, 631);
    assert.equal(six.attributes.cost, 34);
    assert.equal(six.attributes.respawnTime, 66);
    assert.equal(talent(one, "1").hp_ratio, 0.2);
    assert.equal(talent(six, "1").hp_ratio, 0.22);
    assert.equal(talent(six, "1").max_times, 3);
    const eliteOne = profile(mudrock, { ...base, elite: 1, level: 80, potential: 6 });
    assert.equal(talent(eliteOne, "1").max_times, 2);
    assert.deepEqual(eliteOne.talents.map(talent => talent.key), ["1"]);
    assert.throws(() => profile(mudrock, { ...base, potential: 0 }), /integer/);
    assert.throws(() => profile(mudrock, { ...base, potential: 7 }), /supported range/);
});

test("trust follows favor-table battle phases, reaches full attributes at 100 percent and remains saturated", () => {
    const values = [0, 1, 2, 49, 50, 99, 100, 200].map(trust => profile(mudrock, { ...base, trust }).attributes);
    assert.deepEqual(values.map(attributes => attributes.maxHp), [3928, 3928, 3938, 4168, 4178, 4418, 4428, 4428]);
    approximate(values[3].defense, 602 + 60 * 24 / 50);
    approximate(values[5].defense, 602 + 60 * 49 / 50);
    assert.deepEqual(values[6], values[7]);
    assert.throws(() => profile(mudrock, { ...base, trust: 0.5 }), /integer/);
    assert.throws(() => profile(mudrock, { ...base, trust: 201 }), /supported range/);
    const missing = structuredClone(fixture.favor);
    missing.favorFrames = missing.favorFrames.filter(frame => frame.data.percent !== 49);
    assert.throws(() => profile(mudrock, { ...base, trust: 49 }, { tables: { favor: missing } }), /unknown trust/);
});

test("skill unlock, common upgrades and mastery gates follow the selected character skill", () => {
    assert.throws(() => profile(mudrock, { ...base, elite: 0, level: 50, skillLevel: 1 }), /skill is locked/);
    assert.throws(() => profile(mudrock, { ...base, elite: 1, level: 80, skillLevel: 8 }), /higher elite/);
    const mastery = profile(mudrock, { ...base, skillLevel: 10 });
    assert.equal(mastery.skill.definition.spCost, 4);
    assert.equal(blackboard(mastery.skill.blackboard).atk_scale, 2.7);
    const common = { elite: 0, level: 40, potential: 1, skillIndex: 0, skillLevel: 4, trust: 0 };
    assert.equal(profile(melantha, common).skill.level, 4);
    assert.throws(() => profile(melantha, { ...common, skillLevel: 5 }), /higher elite/);
    assert.throws(() => profile(melantha, { ...common, elite: 1, level: 55, skillLevel: 8 }), /available upgrades/);
    assert.throws(() => profile(mudrock, { ...base, skillIndex: 3 }), /selected operator skill/);
    assert.throws(() => profile(mudrock, base, { skill: fixture.skills["skcom_atk_up[1]"] }), /does not match/);
    const ammo = structuredClone(fixture.skills["skchr_mudrok_2"]);
    ammo.levels[6].durationType = "AMMO";
    assert.throws(() => profile(mudrock, base, { skill: ammo }), /AMMO.*unsupported/);
});

test("same-phase talent upgrades remain separate from static attributes and absent skill range stays null", () => {
    const configuration = { elite: 1, level: 54, potential: 6, skillIndex: 0, skillLevel: 7, trust: 100 };
    const lower = profile(melantha, configuration);
    const maximum = profile(melantha, { ...configuration, level: 55 });
    assert.equal(talent(lower, "1").atk, 0.04);
    assert.equal(talent(maximum, "1").atk, 0.08);
    assert.equal(maximum.attributes.attack, 828);
    assert.equal(maximum.attributes.cost, 13);
    assert.equal(maximum.attributes.respawnTime, 60);
    assert.equal(maximum.skillRange, null);
});

test("module stages use their total attributes, trust gates and potential-aware talent replacement", () => {
    const moduleId = "uniequip_002_mudrok";
    const configured = level => ({ ...base, trust: 100, potential: 6, module: { id: moduleId, level } });
    const stages = [1, 2, 3].map(level => profile(mudrock, configured(level)));
    assert.deepEqual(stages.map(profile => profile.attributes.maxHp), [4673, 4753, 4828]);
    assert.deepEqual(stages.map(profile => profile.attributes.attack), [937, 952, 962]);
    assert.deepEqual(stages.map(profile => talent(profile, "1").hp_ratio), [0.22, 0.24, 0.25]);
    assert.equal(talent(stages[2], "1").sp, 2);
    assert.equal(stages[2].talents.length, 2);
    assert.deepEqual(blackboard(stages[2].moduleTrait), { damage_scale: 0.85 });
    assert.equal(profile(mudrock, { ...configured(3), potential: 1 }).talents[0].blackboard.find(entry => entry.key === "hp_ratio").value, 0.23);
    assert.throws(() => profile(mudrock, { ...configured(1), level: 59 }), /module requires/);
    assert.throws(() => profile(mudrock, { ...configured(2), trust: 49 }), /more trust/);
    assert.equal(profile(mudrock, { ...configured(2), trust: 50 }).configuration.module.level, 2);
    assert.throws(() => profile(mudrock, { ...configured(3), trust: 99 }), /more trust/);
    assert.throws(() => profile(melantha, { elite: 1, level: 55, potential: 1, skillIndex: 0, skillLevel: 7, trust: 100, module: { id: moduleId, level: 1 } }), /does not match/);
    const y = profile(mudrock, { ...base, trust: 100, module: { id: "uniequip_003_mudrok", level: 3 } });
    assert.deepEqual(blackboard(y.moduleTrait), { atk: 0.08, def: 0.08 });
    assert.equal(y.attributes.attack, 967);
    assert.equal(y.attributes.defense, 732);
    assert.equal(talent(y, "2").damage_resistance, 0.35);
});

test("module data-only replacements and new talent keys preserve unmodified source data", () => {
    const moduleId = "uniequip_002_mudrok";
    const battle = structuredClone(fixture.battleEquipment[moduleId]);
    const phase = battle.phases[2];
    phase.parts[1].target = "TALENT_DATA_ONLY";
    const addition = structuredClone(phase.parts[1]);
    addition.addOrOverrideTalentDataBundle.candidates = [{
        ...addition.addOrOverrideTalentDataBundle.candidates[0],
        talentIndex: -1, prefabKey: "extra", blackboard: [{ key: "description_key", value: 0, valueStr: "preserved" }],
    }];
    phase.parts.push(addition);
    const before = structuredClone(battle);
    const configuration = { ...base, trust: 100, module: { id: moduleId, level: 3 } };
    const prepared = profile(mudrock, configuration, { tables: { battleEquipment: battle } });
    assert.deepEqual(prepared.talents.map(talent => talent.key), ["1", "2", "extra"]);
    assert.equal(talent(prepared, "1").sp, 2);
    assert.equal(prepared.talents[2].blackboard[0].valueStr, "preserved");
    assert.deepEqual(battle, before);
});

test("unsupported potential formulas and malformed range or module records fail explicitly", () => {
    const character = structuredClone(fixture.characters[mudrock]);
    character.potentialRanks[0].buff.attributes.attributeModifiers[0].formulaItem = "MULTIPLIER";
    assert.throws(() => profile(mudrock, { ...base, potential: 2 }, { character }), /unsupported.*modifier/);
    const ranges = structuredClone(fixture.ranges);
    ranges["1-1"].grids.push({ ...ranges["1-1"].grids[0] });
    assert.throws(() => profile(mudrock, base, { tables: { ranges } }), /duplicate range/);
    const configuration = { ...base, trust: 100, module: { id: "uniequip_002_mudrok", level: 3 } };
    assert.throws(() => profile(mudrock, configuration, { tables: { battleEquipment: { phases: [] } } }), /unknown module level/);
    assert.throws(() => profile(mudrock, { ...configuration, module: { ...configuration.module, level: 4 } }), /between 1 and 3/);
});
