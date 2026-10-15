import { invincible, undeadable } from "../../dist/content/tactical/effects/protection.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    unit,
    workFor,
    attach,
    request,
    damageEffect,
    barrier,
    setSelf,
    stateOf,
    view,
} from "../helpers/vitality.js";
import { contributionEffect } from "../helpers/effects.js";
import * as modifier from "../../dist/core/tactical/unit/contribution/value.js";
import {
    setAttackContribution,
    removeAttackContribution,
} from "../../dist/core/tactical/unit/capability/offense/capability.js";
import {
    setResistanceContribution,
    removeResistanceContribution,
} from "../../dist/core/tactical/unit/capability/defense/capability.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import { resolveDamage } from "../../dist/core/tactical/unit/capability/vitality/damage/settlement.js";
import { resolveHealing } from "../../dist/core/tactical/unit/capability/vitality/healing/settlement.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import {
    compose,
    multiplyAttackScale,
    replaceAttackScale,
    multiplyDamage,
    reduceDamage,
} from "../../dist/core/tactical/unit/capability/vitality/damage/rules.js";
import { getUnit, transitionUnit } from "../../dist/core/tactical/battle/state.js";

test("damage pipeline: fatal reactions return the current life state before departure is decided", () => {
    const rescue = damageEffect("fatal-rescue", {}, [{
        stage: "reaction",
        invoke(state, context, _self, report) {
            if (report.deathOccurred && report.request.targetUnitId === context.unit.id) {
                state = transitionUnit(state, context.unit.id, unit => ({
                    ...unit, vitality: { ...unit.vitality, hp: 50 },
                }));
            }
            return { state, value: undefined };
        },
    }]);
    const initial = workFor(unit(1), attach(unit(2, { hp: 100 }), rescue));
    const resolved = resolveDamage(initial, request(100));
    assert.equal(resolved.value.hpLoss, 100);
    assert.equal(resolved.value.deathOccurred, true);
    assert.equal(getUnit(resolved.state, 2).vitality.hp, 50);
    assert.deepEqual(resolved.state.removedUnits, []);
    assert.equal(getUnit(initial, 2).vitality.hp, 100);
});

const rule = (id, stage, invoke, priority = 0, properties = {}) =>
    damageEffect(
        id,
        {},
        [
            {
                stage,
                priority,
                invoke: (state, context, _self, value) => ({
                    state,
                    value: invoke(context, value),
                }),
            },
        ],
        properties,
    );

test("damage pipeline: numeric contributions retain four distinct positions and clamp the direct multiplier", () => {
    assert.equal(
        modifier.apply(100, [
            modifier.create({ addition: 10, multiplier: 0.5, finalAddition: 7, finalScaler: 2 }),
            modifier.create({ addition: 20, multiplier: 0.5, finalAddition: 3, finalScaler: 0.5 }),
        ]),
        270,
    );
    assert.equal(
        modifier.apply(100, [
            modifier.create({ multiplier: -2, finalAddition: 7, finalScaler: 2 }),
        ]),
        14,
    );
});

test("damage pipeline: dynamic low HP attack reads current state and stable prior snapshots", () => {
    const resources = new CombatResources();
    const lowHp = contributionEffect(
        "low-hp",
        {},
        {
            capability: "offense", set: setAttackContribution,
            remove: removeAttackContribution,
            dynamic: true,
            value: (_self, { unit }) =>
                unit.vitality.hp < unit.definition.vitality.maxHp / 2
                    ? [modifier.create({ multiplier: 1 })]
                    : [],
        },
    );
    const source = attach(unit(1, { hp: 750, maxHp: 1000 }), lowHp);
    let battle = workFor(source, unit(2));
    battle = resolveDamage(battle, request(500, { sourceUnitId: 2, targetUnitId: 1 })).state;
    const damaged = view(battle);
    battle = resolveHealing(battle, {
        sourceUnitId: 2,
        targetUnitId: 1,
        power: 400,
        ignoreHealFree: false,
        tick: 12,
    }).state;
    assert.equal(resolveAttackPower(1, damaged), 200);
    assert.equal(damaged.getUnit(1).vitality.hp, 250);
    assert.equal(getUnit(battle, 1).vitality.hp, 650);
    assert.equal(resolveAttackPower(1, view(battle)), 100);
    assert.equal(source.vitality.hp, 750);
});

test("damage pipeline: multiplication and replacement retain their explicit execution order", () => {
    for (const [first, second, expected] of [
        [multiplyAttackScale(() => 2), replaceAttackScale(() => 3), 300],
        [replaceAttackScale(() => 3), multiplyAttackScale(() => 2), 600],
    ]) {
        const source = attach(
            unit(1),
            rule("attack-scale", "sourceFormula", compose(first, second)),
        );
        const resultSettlement = resolveDamage(workFor(source, unit(2)), request(100));
        const result = resultSettlement.value;
        assert.equal(result.formulaDamage, expected);
        assert.equal(result.hpLoss, expected);
    }
});

test("damage pipeline: fixed penetration precedes proportional penetration", () => {
    for (const [damageType, defense, resistance, expected] of [
        ["PHYSICAL", 200, 0, 950],
        ["ARTS", 0, 80, 650],
        ["ARTS", 0, 150, 550],
    ]) {
        const resultSettlement = resolveDamage(workFor(unit(1), unit(2, { defense, resistance })), request(1000, {
                damageType,
                operands: {
                    ...createDamageOperands(1000),
                    fixedPenetration: damageType === "PHYSICAL" ? 100 : 10,
                    proportionalPenetration: 0.5,
                },
            }));
        const result = resultSettlement.value;
        assert.equal(result.formulaDamage, expected);
    }
});

test("damage pipeline: resistance contributions clamp before penetration", () => {
    const effect = contributionEffect(
        "resistance",
        {},
        {
            capability: "defense", set: setResistanceContribution,
            remove: removeResistanceContribution,
            value: () => [modifier.create({ finalAddition: 70 })],
        },
    );
    const target = attach(unit(2, { resistance: 80 }), effect);
    let battle = workFor(unit(1), target);
    const resultSettlement = resolveDamage(battle, request(1000, {
            damageType: "ARTS",
            operands: {
                ...createDamageOperands(1000),
                fixedPenetration: 10,
                proportionalPenetration: 0.5,
            },
        }));
    battle = resultSettlement.state;
    const result = resultSettlement.value;
    assert.equal(result.formulaDamage, 550);
    assert.equal(getUnit(battle, 2).vitality.hp, 4450);
    assert.equal(getUnit(battle, 2).definition.defense.resistance, 80);
});

test("damage pipeline: barrier before doubling takes 400 HP; doubling before barrier takes 900", () => {
    for (const [barrierPriority, scalePriority, expected] of [
        [100, 0, 400],
        [0, 100, 900],
    ]) {
        const shield = barrier("barrier", 500, barrierPriority);
        const target = attach(
            attach(unit(2), shield),
            rule(
                "fragile",
                "reception",
                multiplyDamage(() => 2),
                scalePriority,
            ),
        );
        let battle = workFor(unit(1), target);
        const resultSettlement = resolveDamage(battle, request(700));
        battle = resultSettlement.state;
        const result = resultSettlement.value;
        assert.equal(result.hpDamage, expected);
        assert.equal(result.hpLoss, expected);
        assert.equal(stateOf(battle, 2, shield).remainingAmount, 0);
        assert.deepEqual(result.resourceConsumptions, [
            { ownerUnitId: 2, resourceId: "2:0", resource: "barrier", amount: 500 },
        ]);
        assert.equal(target.effects.values()[0].data.remainingAmount, 500);
    }
});

test("damage pipeline: reduction and complete absorption consume shield without HP loss", () => {
    const shield = barrier("barrier", 800);
    const target = attach(
        attach(unit(2), shield),
        rule(
            "reduction",
            "reception",
            reduceDamage(() => 100),
            100,
        ),
    );
    let battle = workFor(unit(1), target);
    const resultSettlement = resolveDamage(battle, request(700));
    battle = resultSettlement.state;
    const result = resultSettlement.value;
    assert.equal(result.hpLoss, 0);
    assert.equal(result.hpDamage, 0);
    assert.equal(result.cancellation, null);
    assert.equal(result.resourceConsumptions[0].amount, 600);
    assert.equal(stateOf(battle, 2, shield).remainingAmount, 200);
    assert.equal(target.effects.values()[0].data.remainingAmount, 800);
});

test("damage pipeline: Effect overwriting gates hooks while retaining suppressed instances", () => {
    const weak = rule(
        "weak",
        "reception",
        multiplyDamage(() => 2),
        0,
        { group: { id: "fragile", priority: 2 } },
    );
    const strong = rule(
        "strong",
        "reception",
        multiplyDamage(() => 3),
        0,
        { group: { id: "fragile", priority: 3 } },
    );
    const target = attach(attach(unit(2), weak), strong);
    let battle = workFor(unit(1), target);
    assert.equal(resolveDamage(battle, request(100)).value.hpLoss, 300);
    assert.deepEqual(
        getUnit(battle, 2).effects.values().map((self) => self.status),
        ["INACTIVE", "ACTIVE"],
    );
});

test("damage pipeline: Contribution groups and Effect groups have separate responsibilities", () => {
    const attack = contributionEffect(
        "attack",
        {},
        {
            capability: "offense", set: setAttackContribution,
            remove: removeAttackContribution,
            group: { id: "shared", priority: 100 },
            value: () => [modifier.create({ multiplier: 1 })],
        },
    );
    const weak = rule(
        "weak",
        "reception",
        multiplyDamage(() => 2),
        0,
        { group: { id: "shared", priority: 1 } },
    );
    const strong = rule(
        "strong",
        "reception",
        multiplyDamage(() => 3),
        0,
        { group: { id: "shared", priority: 2 } },
    );
    const target = attach(attach(attach(unit(2), attack), weak), strong);
    let battle = workFor(unit(1), target);
    assert.equal(resolveAttackPower(2, view(battle)), 200);
    assert.equal(resolveDamage(battle, request(100)).value.hpLoss, 300);
});

test("damage pipeline: independent formula, output and reaction hooks all execute", () => {
    const reactions = [];
    const observer = damageEffect("observer", { reports: 0 }, [
        {
            stage: "reaction",
            invoke(state, context, self) {
                state = setSelf(state, context, self, (current) => ({
                    reports: current.reports + 1,
                }));
                reactions.push(context.unit.id);

                return { state, value: {} };
            },
        },
    ]);
    const source = attach(
        attach(
            attach(
                unit(1),
                rule(
                    "formula",
                    "sourceFormula",
                    multiplyAttackScale(() => 2),
                ),
            ),
            rule(
                "output",
                "output",
                multiplyDamage(() => 3),
            ),
        ),
        observer,
    );
    const target = attach(
        unit(2),
        damageEffect("target-observer", {}, [
            {
                stage: "reaction",
                priority: 1000,
                invoke: (state, context) => {
                    reactions.push(context.unit.id);

                    return { state, value: {} };
                },
            },
        ]),
    );
    let battle = workFor(source, target);
    const resultSettlement = resolveDamage(battle, request(100));
    battle = resultSettlement.state;
    const result = resultSettlement.value;
    assert.equal(result.formulaDamage, 200);
    assert.equal(result.outputDamage, 600);
    assert.equal(result.hpLoss, 600);
    assert.equal(stateOf(battle, 1, observer).reports, 1);
    assert.deepEqual(reactions, [1, 2]);
    reactions.length = 0;
    battle = resolveDamage(battle, request(100, { targetUnitId: 1 })).state;
    assert.deepEqual(reactions, [1]);
});

test("damage pipeline: priority precedes registration order and disabled candidates do not run", () => {
    for (const reverse of [false, true]) {
        const first = rule(
            "first",
            "reception",
            compose(
                reduceDamage(() => 100),
                multiplyDamage(() => 3),
            ),
        );
        const last = rule(
            "last",
            "reception",
            multiplyDamage(() => 2),
        );
        const ordered = reverse ? [last, first] : [first, last];
        let target = unit(2);
        for (const content of ordered) target = attach(target, content);
        target = attach(
            target,
            rule(
                "high",
                "reception",
                reduceDamage(() => 50),
                1000,
            ),
        );
        const resultSettlement = resolveDamage(workFor(unit(1), target), request(300));
        const result = resultSettlement.value;
        assert.equal(result.hpLoss, reverse ? 1200 : 900);
    }
});

test("damage pipeline: lethal protection keeps HP 1 without removal", () => {
    let battle = workFor(unit(1), attach(unit(2, { hp: 1000 }), undeadable));
    const resultSettlement = resolveDamage(battle, request(5000));
    battle = resultSettlement.state;
    const result = resultSettlement.value;
    assert.equal(getUnit(battle, 2).vitality.hp, 1);
    assert.equal(result.hpLoss, 999);
    assert.equal(result.fatalProtection, true);
    assert.equal(result.deathOccurred, false);
    assert.deepEqual(battle.removedUnits, []);
});

test("damage pipeline: missing target leaves numerical stages uncomputed", () => {
    let battle = workFor(unit(1));
    const resultSettlement = resolveDamage(battle, request(100));
    battle = resultSettlement.state;
    const result = resultSettlement.value;
    assert.equal(result.formulaDamage, null);
    assert.equal(result.outputDamage, null);
    assert.equal(result.hpDamage, null);
    assert.equal(result.cancellation.reason, "TARGET_ABSENT");
    assert.deepEqual(battle.events, []);
});

test("damage pipeline: invincibility preserves shield resources and still notifies reactions", () => {
    const shield = barrier("shield", 500);
    const observations = [];
    const source = attach(
        unit(1),
        damageEffect("observer", {}, [
            {
                stage: "output",
                invoke: (state, ctx, _self, value) => ({
                    state,
                    value: multiplyDamage(() => 2)(ctx, value),
                }),
            },
            {
                stage: "reaction",
                invoke: (state, _ctx, _self, report) => {
                    observations.push(report);

                    return { state, value: {} };
                },
            },
        ]),
    );
    let battle = workFor(source, attach(attach(unit(2), invincible), shield));
    const resultSettlement = resolveDamage(battle, request(700));
    battle = resultSettlement.state;
    const result = resultSettlement.value;
    assert.equal(result.formulaDamage, 700);
    assert.equal(result.outputDamage, 1400);
    assert.equal(result.hpDamage, null);
    assert.equal(result.hpLoss, 0);
    assert.deepEqual(result.resourceConsumptions, []);
    assert.equal(result.cancellation.reason, "INVINCIBLE");
    assert.equal(stateOf(battle, 2, shield).remainingAmount, 500);
    assert.equal(observations[0], result);
});

test("damage pipeline: nested damage and healing observe consumption and latest HP", () => {
    const resources = new CombatResources();
    const shield = barrier("source-shield", 30);
    const once = damageEffect("once", { charges: 1 }, [
        {
            stage: "reaction",
            invoke(state, context, self, report) {
                if (report.request.sourceUnitId !== context.unit.id || self.data.charges === 0)
                    return { state, value: {} };
                state = setSelf(state, context, self, { charges: 0 });
                state = resolveDamage(state, request(40, { sourceUnitId: 2, targetUnitId: 1, tick: context.tick }), context.call).state;
                state = resolveHealing(
                    state,
                    {
                        sourceUnitId: 1,
                        targetUnitId: 2,
                        power: 10,
                        ignoreHealFree: false,
                        tick: context.tick,
                    },
                    context.call,
                ).state;
                state = setSelf(state, context, self, (current) => ({
                    ...current,
                    observedSourceHp: getUnit(state, context.unit.id).vitality.hp,
                    observedTargetHp: getUnit(state, 2).vitality.hp,
                }));

                return { state, value: {} };
            },
        },
    ]);
    let battle = workFor(
        attach(attach(unit(1, { hp: 800, maxHp: 1000 }), shield), once),
        unit(2, { hp: 1000 }),
    );
    const previous = battle;
    const resultSettlement = resolveDamage(battle, request(100));
    battle = resultSettlement.state;
    const result = resultSettlement.value;
    assert.equal(result.hpLoss, 100);
    assert.equal(getUnit(battle, 1).vitality.hp, 790);
    assert.equal(getUnit(battle, 2).vitality.hp, 910);
    assert.equal(stateOf(battle, 1, shield).remainingAmount, 0);
    assert.deepEqual(stateOf(battle, 1, once), {
        charges: 0,
        observedSourceHp: 790,
        observedTargetHp: 910,
    });
    assert.deepEqual(
        battle.events.map((event) => [event.type, event.amount]),
        [
            ["DAMAGE", 100],
            ["DAMAGE", 10],
            ["HEAL", 10],
        ],
    );
    assert.equal(getUnit(previous, 1).vitality.hp, 800);
});
