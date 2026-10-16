import { Definitions } from '../../dist/core/tactical/unit/action/definitions.js';
import { create as createAttack } from '../../dist/content/tactical/actions/attack.js';
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { setData } from "../../dist/core/tactical/unit/effect/effect.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
    parseAttributeModifiers,
    compileAttributeModifiers,
} from "../../dist/data/arknights/modifier.js";
import {
    battlefieldView,
    getUnit,
    removeUnit,
    transitionUnit,
} from "../../dist/core/tactical/battle/state.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import {
    setAttackContribution,
    removeAttackContribution,
} from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import {
    setSpeedContribution,
    removeSpeedContribution,
} from "../../dist/core/tactical/unit/capability/action/capability.js";
import { resolveSpeed } from "../../dist/core/tactical/unit/capability/action/timing.js";
import {
    setMoveSpeedContribution,
    removeMoveSpeedContribution,
} from "../../dist/core/tactical/unit/capability/locomotion/capability.js";
import { resolveMoveSpeed as resolveMoveSpeedPerTick } from "../../dist/core/tactical/unit/capability/locomotion/capability.js";
import { initialize } from "../helpers/unit.js";
import * as modifier from "../../dist/core/tactical/unit/contribution/value.js";
import {
    definition,
    contributionEffect,
    refreshContribution,
    effectFixtureWork,
} from "../helpers/effects.js";

const fixture = (name) =>
    JSON.parse(
        readFileSync(new URL(`../fixtures/arknights/${name}.json`, import.meta.url), "utf8"),
    );
const description = (formulaItem, value, patch = {}) => ({
    attributeType: "ATK",
    formulaItem,
    value,
    loadFromBlackboard: false,
    fetchBaseValueFromSourceEntity: false,
    ...patch,
});
const context = (patch = {}) => ({
    blackboard: new Map(),
    stackCount: 1,
    readSourceAttribute: () => undefined,
    ...patch,
});
const sample = (raw, input = context()) =>
    compileAttributeModifiers(parseAttributeModifiers([raw]))[0].sample(input);
const close = (actual, expected) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

test("attribute modifiers: serialized enum names and numbers normalize only supported consumers", () => {
    const raw = [description("MULTIPLIER", 0.5), description(1, 0.5, { attributeType: 1 })];
    const parsed = parseAttributeModifiers(raw);
    assert.deepEqual(parsed[0], parsed[1]);
    const compiled = compileAttributeModifiers(parsed);
    raw[0].value = 100;
    assert.equal(compiled[0].sample(context()).multiplier, 0.5);
    assert.ok(Object.isFrozen(parsed[0]));
    assert.ok(Object.isFrozen(compiled));
    assert.throws(() => parseAttributeModifiers(Array(1)), /invalid attribute modifier/);
    assert.throws(
        () => parseAttributeModifiers([description("MULTIPLIER", 1, { attributeType: "COST" })]),
        /unsupported modifier/,
    );
    assert.throws(() => parseAttributeModifiers([description("GUESS", 1)]), /unsupported modifier/);
    assert.throws(() => parseAttributeModifiers([description("ADDITION", NaN)]), /finite/);
    assert.throws(
        () => parseAttributeModifiers([description("ADDITION", 1, { loadFromBlackboard: 1 })]),
        /flags/,
    );
    assert.throws(
        () => parseAttributeModifiers([description("ADDITION", 1, { unknownRule: true })]),
        /unsupported modifier field/,
    );
});

test("attribute modifiers: four native operands compose before the domain range", () => {
    const entries = [
        description("ADDITION", 10),
        description("MULTIPLIER", 0.5),
        description("FINAL_ADDITION", 7),
        description("FINAL_SCALER", 1.2),
    ];
    const values = compileAttributeModifiers(parseAttributeModifiers(entries)).map((entry) =>
        entry.sample(context({ stackCount: 3 })),
    );
    close(modifier.apply(100, values), ((100 + 30) * 2.5 + 21) * 3.6);
    assert.equal(values[0].addition, 30);
    assert.equal(values[1].multiplier, 1.5);
    assert.equal(values[2].finalAddition, 21);
    close(values[3].finalScaler, 3.6);
});

test("attribute modifiers: a stacked raw final scaler is corrected once, never exponentiated", () => {
    const result = sample(description("FINAL_SCALER", -0.2), context({ stackCount: 3 }));
    close(result.finalScaler, 0.4);
    close(modifier.apply(100, [result]), 40);
    assert.notEqual(result.finalScaler, 0.8 ** 3);
    assert.equal(sample(description("FINAL_SCALER", 0)).finalScaler, 0);
    assert.equal(
        sample(description("FINAL_SCALER", 1.2), context({ stackCount: 2 })).finalScaler,
        2.4,
    );
    assert.equal(sample(description("FINAL_SCALER", -0.2), context({ stackCount: 0 })), undefined);
    const independent = [
        sample(description("FINAL_SCALER", -0.2)),
        sample(description("FINAL_SCALER", -0.2)),
    ];
    close(modifier.apply(100, independent), 64);
});

test("attribute modifiers: missing blackboard keys use the declared operand without changing its formula", () => {
    const raw = description("FINAL_ADDITION", 7, { loadFromBlackboard: true });
    assert.equal(sample(raw).finalAddition, 7);
    assert.equal(
        sample(raw, context({ blackboard: new Map([["atk", 11]]), stackCount: 2 })).finalAddition,
        22,
    );
    assert.equal(sample(raw, context({ blackboard: new Map([["atk", 0]]) })).finalAddition, 0);
    assert.throws(
        () => sample(raw, context({ blackboard: new Map([["atk", Infinity]]) })),
        /finite/,
    );
});

test("attribute modifiers: source sampling selects native addition slots and normally omits an absent source", () => {
    const input = context({
        stackCount: 2,
        readSourceAttribute: (attribute) => {
            assert.equal(attribute, "ATK");
            return 100;
        },
    });
    for (const [formula, value, key, expected] of [
        ["ADDITION", 2.5, "addition", 105],
        ["MULTIPLIER", 0.25, "addition", 50],
        ["FINAL_ADDITION", 2.5, "finalAddition", 105],
        ["FINAL_SCALER", 0.25, "finalAddition", 50],
    ]) {
        const raw = description(formula, value, { fetchBaseValueFromSourceEntity: true });
        assert.equal(sample(raw, input)[key], expected);
        assert.equal(sample(raw), undefined);
    }
    const negative = sample(
        description("FINAL_SCALER", -0.2, { fetchBaseValueFromSourceEntity: true }),
        context({ stackCount: 3, readSourceAttribute: () => 100 }),
    );
    close(negative.finalAddition, 40);
    assert.equal(negative.finalScaler, 1);
});

test("attribute modifiers: BAT and MOVE_SPEED normalize only additive operands to core units", () => {
    const bat = sample(
        description("ADDITION", 0.5, { attributeType: "BASE_ATTACK_TIME" }),
        context({ stackCount: 2 }),
    );
    assert.equal(bat.addition, 30);
    const speed = sample(description("FINAL_ADDITION", 3, { attributeType: "MOVE_SPEED" }));
    assert.equal(speed.finalAddition, 0.1);
    const ratio = sample(description("MULTIPLIER", -0.5, { attributeType: "MOVE_SPEED" }));
    assert.equal(ratio.multiplier, -0.5);
    const sourced = sample(
        description("FINAL_SCALER", 0.5, {
            attributeType: "MOVE_SPEED",
            fetchBaseValueFromSourceEntity: true,
        }),
        context({ readSourceAttribute: () => 2 }),
    );
    assert.equal(sourced.finalAddition, 1 / 30);
});

test("attribute modifiers: BLOCK_CNT uses native number 5 and leaves quantization to Blocking", () => {
    const named = description("ADDITION", 0, {
        attributeType: "BLOCK_CNT",
        loadFromBlackboard: true,
    });
    const numeric = { ...named, attributeType: 5 };
    assert.deepEqual(parseAttributeModifiers([named]), parseAttributeModifiers([numeric]));
    const value = sample(
        numeric,
        context({ blackboard: new Map([["block_cnt", -0.25]]), stackCount: 2 }),
    );
    assert.equal(value.addition, -0.5);
    assert.equal(modifier.apply(3, [value]), 2.5);
});

test("attribute modifiers: Warfarin's actual ATK descriptor is a percentage contribution", () => {
    const raw = fixture("modifiers_bldsk_s_2");
    const [compiled] = compileAttributeModifiers(parseAttributeModifiers(raw.attributeModifiers));
    assert.equal(compiled.attributeType, "ATK");
    const value = compiled.sample(context({ blackboard: new Map([["atk", 0.9]]) }));
    assert.equal(value.multiplier, 0.9);
    close(modifier.apply(100, [value]), 190);
});

test("attribute modifiers: native Mire percentages affect existing ASPD and normalized speed", () => {
    const raw = fixture("buff_mire_attr");
    const blackboard = new Map(
        fixture("skill_sktok_mire").levels[0].blackboard.map(({ key, value }) => [key, value]),
    );
    const compiled = compileAttributeModifiers(
        parseAttributeModifiers(raw.node._buff.attributes.attributeModifiers),
    );
    const sampled = new Map(
        compiled.map((entry) => [entry.attributeType, entry.sample(context({ blackboard }))]),
    );
    const program = definition(
        "compiled-mire",
        {},
        {
            onEnable(state, ctx) {
                const id = `${ctx.ref.id}`;
                return transitionUnit(state, ctx.ref.host.id, (unit) => ({
                    ...unit,
                    action: setSpeedContribution(unit.action, {
                        id,
                        value: [sampled.get("ATTACK_SPEED")],
                    }),
                    locomotion: setMoveSpeedContribution(unit.locomotion, {
                        id,
                        value: [sampled.get("MOVE_SPEED")],
                    }),
                }));
            },
            onDisable(state, ctx) {
                const id = `${ctx.ref.id}`;
                return transitionUnit(state, ctx.ref.host.id, (unit) => ({
                    ...unit,
                    action: removeSpeedContribution(unit.action, id),
                    locomotion: removeMoveSpeedContribution(unit.locomotion, id),
                }));
            },
        },
    );
    const unit = initialize({
        id: 0,
        position: [0, 0],
        definition: {
            id: "mire-receiver",
            locomotion: {
                moveSpeedPerTick: 1 / 30,
                minimumMoveSpeedPerTick: 0.1 / 30,
                steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 },
            },
            action: { definitions: Definitions.empty().add(createAttack({ id: 'normal', speed: 200,
                    triggerBindingId: "unused",
                    intervalTicks: 30,
                    recoveryTicks: 0,
                    targetGroups: [
                        {
                            id: "unused",
                            targeting: {
                                type: "DAMAGE",
                                scope: { type: "BLOCKER" },
                                canTargetAir: false,
                                includeBlockingRelations: true,
                                preferBlockingRelations: true,
                                ignoreTargetFree: false,
                                ignoreInvisible: false,
                                maxTargets: 1,
                            },
                            operations: [{ type: "DAMAGE", power: 0, damageType: "TRUE" }],
                        },
                    ],
                    followUps: [],
                 })) },
        },
    });
    let installed = effectFixtureWork(unit);
    installed = effects.install(installed, unitRef(getUnit(installed, 0)), program).state;
    const receiver = getUnit(installed, 0);
    assert.equal(
        resolveSpeed(installed, unitRef(receiver), receiver.definition.action.definitions.values()[0]),
        190,
    );
    close(
        resolveMoveSpeedPerTick(receiver.definition.locomotion, receiver.locomotion, {
            unit: receiver,
            battlefield: battlefieldView(installed),
        }),
        0.95 / 30,
    );
});

test("attribute modifiers: inspiration samples belong to the Effect input and refresh only explicitly", () => {
    const raw = fixture("buff_encourage_atk");
    const [compiled] = compileAttributeModifiers(
        parseAttributeModifiers(raw.node._buff.attributes.attributeModifiers),
    );
    const output = {
        capability: "offense", set: setAttackContribution,
        remove: removeAttackContribution,
        value: (instance) => [
            compiled.sample(
                context({
                    blackboard: new Map([["atk", instance.data.ratio]]),
                    readSourceAttribute: () => instance.data.sourceAttack,
                }),
            ),
        ],
    };
    const amplify = contributionEffect(
        "source-amplification",
        {},
        {
            capability: "offense", set: setAttackContribution,
            remove: removeAttackContribution,
            value: () => [modifier.create({ multiplier: 1 })],
        },
    );
    const program = contributionEffect(
        "compiled-inspiration",
        { sourceAttack: 0, ratio: 0.6 },
        output,
    );
    const unit = (id, power) =>
        initialize({
            id,
            position: [id, 0],
            definition: { id: `inspiration-${id}`, offense: { attack: power } },
        });
    let work = effectFixtureWork(unit(0, 100), unit(1, 20));
    const resolve = (work, id) => resolveAttackPower(id, battlefieldView(work));
    const sampleInput = (work) => ({ sourceAttack: resolve(work, 0), ratio: 0.6 });
    const installed = effects.install(work, unitRef(getUnit(work, 1)), program, {
        source: 0,
        data: sampleInput(work),
    });
    work = installed.state;
    const ref = installed.value;
    assert.equal(resolve(work, 1), 80);
    const copied = getUnit(work, 1);
    work = effects.install(work, unitRef(getUnit(work, 0)), amplify).state;
    assert.equal(resolve(work, 0), 200);
    assert.equal(resolve(work, 1), 80);
    work = effects.setEnabled(work, ref, false);
    assert.equal(resolve(work, 1), 20);
    work = effects.setEnabled(work, ref, true);
    assert.equal(resolve(work, 1), 80);
    work = effects.replaceEffect(
        work,
        ref,
        setData(
            getUnit(work, 1).effects.values().find((instance) => instance.id === ref.id),
            sampleInput(work),
        ),
    );
    work = refreshContribution(work, ref, program, output);
    assert.equal(resolve(work, 1), 140);
    work = removeUnit(work, 0, "RETREAT");
    assert.equal(resolve(work, 1), 140);
    assert.equal(copied.effects.values()[0].data.sourceAttack, 100);
    work = effects.end(work, ref);
    assert.equal(resolve(work, 1), 20);
});
