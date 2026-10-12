import assert from "node:assert/strict";
import { test } from "node:test";
import {
    unit,
    workFor,
    attach,
    request,
    damageEffect,
    healingEffect,
    setSelf,
    stateOf,
    statusEffect,
} from "../helpers/vitality.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { getUnit, transitionUnit } from "../../dist/core/tactical/battle/state.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import * as damage from "../../dist/core/tactical/unit/capability/vitality/damage/hook.js";
import * as healing from "../../dist/core/tactical/unit/capability/vitality/healing/hook.js";
import { resolveDamage } from "../../dist/core/tactical/unit/capability/vitality/damage/settlement.js";
import { resolveHealing } from "../../dist/core/tactical/unit/capability/vitality/healing/settlement.js";

function damageHook(id, stage, invoke, priority = 0, enabled = () => true) {
    return { id, stage, priority, enabled, invoke };
}

function healingHook(id, stage, invoke, priority = 0, enabled = () => true) {
    return { id, stage, priority, enabled, invoke };
}

const healRequest = (power = 10, overrides = {}) => ({
    sourceUnitId: 1,
    targetUnitId: 2,
    power,
    tick: 12,
    ...overrides,
});

test("hook dispatch checks each Effect against its current status immediately before invocation", () => {
    const calls = [];
    let enableSecond = false;
    const first = damageEffect("first", {}, [
        {
            stage: "reception",
            priority: 10,
            invoke(state, context, _self, pending) {
                calls.push("first");
                state = effects.setEnabled(
                    state,
                    { type: "EFFECT", unitId: 2, effectId: 1 },
                    enableSecond,
                    context.call,
                );
                return { state, value: { value: pending } };
            },
        },
    ]);
    const second = damageEffect("second", {}, [
        {
            stage: "reception",
            invoke(state, _context, _self, pending) {
                calls.push("second");
                return { state, value: { value: pending } };
            },
        },
    ]);
    const target = attach(attach(unit(2), first), second);
    let battle = workFor(unit(1), target);
    const resources = new CombatResources();
    battle = resolveDamage(battle, request(), resources).state;
    assert.deepEqual(calls, ["first"]);
    enableSecond = true;
    battle = resolveDamage(battle, request(), resources).state;
    assert.deepEqual(calls, ["first", "first", "second"]);
    assert.equal(target.effects.values()[1].status, "ACTIVE");
});

test("finishing a pending Effect removes its Hook before that candidate can execute", () => {
    const calls = [];
    const first = damageEffect("end-second", {}, [
        {
            stage: "reception",
            priority: 10,
            invoke(state, context, _self, pending) {
                calls.push("first");
                state = effects.end(
                    state,
                    { type: "EFFECT", unitId: 2, effectId: 1 },
                    "EXPLICIT",
                    context.call,
                );
                return { state, value: { value: pending } };
            },
        },
    ]);
    const second = damageEffect(
        "ended",
        {},
        [
            {
                stage: "reception",
                invoke(state, _context, _self, pending) {
                    calls.push("second");
                    return { state, value: { value: pending } };
                },
            },
        ],
        {
            onEnd(state) {
                calls.push("end");
                return state;
            },
        },
    );
    let battle = workFor(unit(1), attach(attach(unit(2), first), second));
    battle = resolveDamage(battle, request(), new CombatResources()).state;
    assert.deepEqual(calls, ["first", "end"]);
    assert.equal(getUnit(battle, 2).effects.values().length, 1);
    assert.equal(getUnit(battle, 2).vitality.damageHooks.length, 1);
});

test("removed registrations stay absent even when replaced under the same id during nested damage", () => {
    const calls = [];
    const resources = new CombatResources();
    let nested = false;
    let changed = false;
    const replacement = damageHook("second", "sourceFormula", (state, _context, input) => {
        calls.push("replacement");
        return { state, value: { value: { ...input, power: input.power * 2 } } };
    });
    const added = damageHook("third", "sourceFormula", (state, _context, input) => {
        calls.push("added");
        return { state, value: { value: { ...input, power: input.power * 3 } } };
    });
    const first = damageHook(
        "first",
        "sourceFormula",
        (state, context, input) => {
            calls.push(nested ? "nested-first" : "first");
            if (!changed) {
                changed = true;
                state = transitionUnit(state, 1, (value) =>
                    ({ ...value, vitality: damage.setHook(damage.setHook(damage.removeHook(value.vitality, "second"), replacement), added) }),
                );
                nested = true;
                state = resolveDamage(state, request(10), resources, context.call).state;
                nested = false;
            }
            return { state, value: { value: input } };
        },
        10,
    );
    const old = damageHook("second", "sourceFormula", (state, _context, input) => {
        calls.push("removed");
        return { state, value: { value: input } };
    });
    const source = ({ ...unit(1, { hp: 1000 }), vitality: damage.setHook(damage.setHook(unit(1, { hp: 1000 }).vitality, first), old) });
    let battle = workFor(source, unit(2, { hp: 1000 }));
    const initialSettlement = resolveDamage(battle, request(100), resources);
    battle = initialSettlement.state;
    const initial = initialSettlement.value;
    assert.deepEqual(calls, ["first", "nested-first"]);
    assert.equal(initial.hpLoss, 100);
    assert.equal(getUnit(battle, 2).vitality.hp, 890);
    assert.deepEqual(source.vitality.damageHooks, [first, old]);
    calls.length = 0;
    const later = resolveDamage(battle, request(100), resources);
    battle = later.state;
    assert.equal(later.value.hpLoss, 600);
    assert.deepEqual(calls, ["first", "replacement", "added"]);
});

test("damage and healing share the active receiver candidates across direct nested operations", () => {
    const calls = [];
    const resources = new CombatResources();
    let changed = false;
    const originalHealing = healingHook("original", "reception", (state, _context, pending) => {
        calls.push("original-healing");
        return { state, value: { value: pending } };
    });
    const newHealing = healingHook("new", "reception", (state, _context, pending) => {
        calls.push("new-healing");
        return { state, value: { value: pending } };
    });
    const first = damageHook("damage", "reception", (state, context, pending) => {
        calls.push("damage");
        if (!changed) {
            changed = true;
            state = transitionUnit(state, 2, (value) =>
                ({ ...value, vitality: healing.setHook(healing.removeHook(value.vitality, "original"), newHealing) }),
            );
            state = resolveHealing(state, healRequest(), context.call).state;
        }
        return { state, value: { value: pending } };
    });
    const receiver = ({ ...unit(2, { hp: 500, maxHp: 1000 }), vitality: healing.setHook(damage.setHook(unit(2, { hp: 500, maxHp: 1000 }).vitality, first), originalHealing) });
    let battle = workFor(unit(1), receiver);
    battle = resolveDamage(battle, request(100), resources).state;
    assert.deepEqual(calls, ["damage"]);
    assert.equal(getUnit(battle, 2).vitality.hp, 410);
    battle = resolveHealing(battle, healRequest()).state;
    assert.deepEqual(calls, ["damage", "new-healing"]);
    assert.equal(getUnit(battle, 2).vitality.hp, 420);
});

test("nested damage shares a healing receiver enumeration without admitting newly registered damage hooks", () => {
    const calls = [];
    const resources = new CombatResources();
    let changed = false;
    const late = damageHook("late", "reception", (state, _context, pending) => {
        calls.push("late-damage");
        return { state, value: { value: pending } };
    });
    const first = healingHook("healing", "reception", (state, context, pending) => {
        calls.push("healing");
        if (!changed) {
            changed = true;
            state = transitionUnit(state, 2, (value) => ({ ...value, vitality: damage.setHook(value.vitality, late) }));
            state = resolveDamage(state, request(10), resources, context.call).state;
        }
        return { state, value: { value: pending } };
    });
    let battle = workFor(unit(1), ({ ...unit(2, { hp: 500, maxHp: 1000 }), vitality: healing.setHook(unit(2, { hp: 500, maxHp: 1000 }).vitality, first) }));
    battle = resolveHealing(battle, healRequest(20)).state;
    assert.deepEqual(calls, ["healing"]);
    assert.equal(getUnit(battle, 2).vitality.hp, 510);
    battle = resolveDamage(battle, request(10), resources).state;
    assert.deepEqual(calls, ["healing", "late-damage"]);
});

test("cancellation and stopping this Hook stage are separate decisions", () => {
    for (const stopDispatch of [false, true]) {
        const calls = [];
        const cancel = damageHook(
            "cancel",
            "reception",
            (state, _context, pending) => {
                calls.push("cancel");
                return {
                    state,
                    value: {
                        value: {
                            ...pending,
                            cancellation: { stage: "RECEPTION", reason: "BLOCKED" },
                        },
                        stopDispatch,
                    },
                };
            },
            10,
        );
        const after = damageHook("after", "reception", (state, _context, pending) => {
            calls.push(pending.cancellation.reason);
            return { state, value: { value: pending } };
        });
        const react = damageHook("reaction", "reaction", (state, _context, report) => {
            calls.push(`reaction:${report.hpLoss}`);

            return { state, value: {} };
        });
        let target = ({ ...unit(2), vitality: damage.setHook(unit(2).vitality, cancel) });
        target = ({ ...target, vitality: damage.setHook(damage.setHook(target.vitality, after), react) });
        let battle = workFor(unit(1), target);
        const reportSettlement = resolveDamage(battle, request(), new CombatResources());
        battle = reportSettlement.state;
        const report = reportSettlement.value;
        assert.equal(report.hpLoss, 0);
        assert.deepEqual(
            calls,
            stopDispatch ? ["cancel", "reaction:0"] : ["cancel", "BLOCKED", "reaction:0"],
        );
    }
});

test("reaction stages run once per participant and can stop their own receiver enumeration", () => {
    const calls = [];
    const first = damageHook(
        "first",
        "reaction",
        (state) => {
            calls.push("first");
            return { state, value: { stopDispatch: true } };
        },
        10,
    );
    const second = damageHook("second", "reaction", (state) => {
        calls.push("second");

        return { state, value: {} };
    });
    const self = ({ ...unit(1), vitality: damage.setHook(damage.setHook(unit(1).vitality, first), second) });
    let battle = workFor(self);
    battle = resolveDamage(battle, request(10, { targetUnitId: 1 }), new CombatResources()).state;
    assert.deepEqual(calls, ["first"]);
});

test("nested operations read already changed Effect state and inherit the enclosing event tick", () => {
    const uses = [];
    const resources = new CombatResources();
    const content = damageEffect("once", { ready: true }, [
        {
            stage: "reception",
            invoke(state, context, self, pending) {
                uses.push(self.data.ready);
                if (self.data.ready) {
                    state = setSelf(state, context, self, { ready: false });
                    state = resolveHealing(
                        state,
                        { sourceUnitId: 1, targetUnitId: 2, power: 10, tick: context.tick },
                        context.call,
                    ).state;
                    state = resolveDamage(
                        state,
                        request(5, { tick: context.tick }),
                        resources,
                        context.call,
                    ).state;
                }
                return { state, value: { value: pending } };
            },
        },
    ]);
    let battle = workFor(unit(1), attach(unit(2, { hp: 500, maxHp: 1000 }), content));
    battle = resolveDamage(battle, request(100, { tick: 42 }), new CombatResources()).state;
    assert.deepEqual(uses, [true, false]);
    assert.deepEqual(stateOf(battle, 2, content), { ready: false });
    assert.equal(getUnit(battle, 2).vitality.hp, 405);
    assert.deepEqual(
        battle.events.map((event) => [event.type, event.amount, event.tick]),
        [
            ["HEAL", 10, 42],
            ["DAMAGE", 5, 42],
            ["DAMAGE", 100, 42],
        ],
    );
});

test("invincibility cancels reception while allowing ordinary observation and reaction hooks", () => {
    const calls = [];
    const content = damageEffect("observe", {}, [
        {
            stage: "reception",
            invoke(state, _context, _self, pending) {
                calls.push(pending.cancellation.reason);
                return { state, value: { value: pending } };
            },
        },
        {
            stage: "reaction",
            invoke(state, _context, _self, report) {
                calls.push(`reaction:${report.hpLoss}`);

                return { state, value: {} };
            },
        },
    ]);
    const target = attach(attach(unit(2), statusEffect("invincible", ["INVINCIBLE"])), content);
    let battle = workFor(unit(1), target);
    const resultSettlement = resolveDamage(battle, request(), new CombatResources());
    battle = resultSettlement.state;
    const result = resultSettlement.value;
    assert.equal(result.hpLoss, 0);
    assert.deepEqual(calls, ["INVINCIBLE", "reaction:0"]);
});

test("skipping modifier events selects the dedicated reception stage and suppresses reactions", () => {
    const calls = [];
    let target = ({ ...unit(2), vitality: damage.setHook(unit(2).vitality, damageHook("ordinary", "reception", (state, _context, value) => {
            calls.push("ordinary");
            return { state, value: { value } };
        })) });
    target = ({ ...target, vitality: damage.setHook(target.vitality, damageHook("skipped", "skippedReception", (state, _context, value) => {
            calls.push("skipped");
            return { state, value: { value: { ...value, amount: value.amount / 2 } } };
        })) });
    target = ({ ...target, vitality: damage.setHook(target.vitality, damageHook("reaction", "reaction", (state) => {
            calls.push("reaction");

            return { state, value: {} };
        })) });
    let battle = workFor(unit(1), target);
    const resultSettlement = resolveDamage(
        battle,
        request(100, {
            receptionPolicy: { considerInvincibility: true, skipModifierEvents: true },
        }),
        new CombatResources(),
    );
    battle = resultSettlement.state;
    const result = resultSettlement.value;
    assert.equal(result.hpLoss, 50);
    assert.deepEqual(calls, ["skipped"]);
});

test("healing hooks resolve output and reception before notifying each participant", () => {
    const calls = [];
    const source = healingEffect("healing-output", {}, [
        {
            stage: "output",
            invoke(state, _context, _self, pending) {
                calls.push("output");
                return { state, value: { value: { ...pending, amount: pending.amount * 2 } } };
            },
        },
        {
            stage: "reaction",
            invoke(state, _context, _self, report) {
                calls.push(`source:${report.amount}`);

                return { state, value: {} };
            },
        },
    ]);
    const target = healingEffect("healing-reception", {}, [
        {
            stage: "reception",
            invoke(state, _context, _self, pending) {
                calls.push("reception");
                return { state, value: { value: { ...pending, amount: pending.amount + 5 } } };
            },
        },
        {
            stage: "reaction",
            invoke(state, _context, _self, report) {
                calls.push(`target:${report.amount}`);

                return { state, value: {} };
            },
        },
    ]);
    let battle = workFor(
        attach(unit(1), source),
        attach(unit(2, { hp: 990, maxHp: 1000 }), target),
    );
    const resultSettlement = resolveHealing(battle, healRequest(10));
    battle = resultSettlement.state;
    const result = resultSettlement.value;
    assert.equal(result.amount, 10);
    assert.deepEqual(calls, ["output", "reception", "target:10", "source:10"]);
    assert.equal(getUnit(battle, 2).vitality.hp, 1000);
});

test("healing cancellation stays visible to reception and reaction while ignoreHealFree changes the request rule", () => {
    const calls = [];
    const observer = healingEffect("observe-healing", {}, [
        {
            stage: "reception",
            invoke(state, _context, _self, pending) {
                calls.push(pending.cancellation?.reason ?? "accepted");
                return { state, value: { value: pending } };
            },
        },
        {
            stage: "reaction",
            invoke(state, _context, _self, report) {
                calls.push(`reaction:${report.amount}`);

                return { state, value: {} };
            },
        },
    ]);
    const target = attach(unit(2, { hp: 500, maxHp: 1000, flags: ["HEAL_FREE"] }), observer);
    let battle = workFor(unit(1), target);
    const cancelled = resolveHealing(battle, healRequest(10));
    battle = cancelled.state;
    assert.equal(cancelled.value.amount, 0);
    const accepted = resolveHealing(battle, healRequest(10, { ignoreHealFree: true }));
    battle = accepted.state;
    assert.equal(accepted.value.amount, 10);
    assert.deepEqual(calls, ["HEAL_FREE", "reaction:0", "accepted", "reaction:10"]);
});

test("healing uses the dedicated skipped stage and suppresses output and reaction modifiers", () => {
    const calls = [];
    const source = ({ ...unit(1), vitality: healing.setHook(unit(1).vitality, healingHook("output", "output", (state, _context, value) => {
            calls.push("output");
            return { state, value: { value: { ...value, amount: value.amount * 2 } } };
        })) });
    let target = ({ ...unit(2, { hp: 500, maxHp: 1000 }), vitality: healing.setHook(unit(2, { hp: 500, maxHp: 1000 }).vitality, healingHook("ordinary", "reception", (state, _context, value) => {
            calls.push("ordinary");
            return { state, value: { value } };
        })) });
    target = ({ ...target, vitality: healing.setHook(target.vitality, healingHook("skipped", "skippedReception", (state, _context, value) => {
            calls.push("skipped");
            return { state, value: { value: { ...value, amount: value.amount / 2 } } };
        })) });
    target = ({ ...target, vitality: healing.setHook(target.vitality, healingHook("reaction", "reaction", (state) => {
            calls.push("reaction");

            return { state, value: {} };
        })) });
    let battle = workFor(source, target);
    const resultSettlement = resolveHealing(battle, healRequest(100, { skipModifierEvents: true }));
    battle = resultSettlement.state;
    const result = resultSettlement.value;
    assert.equal(result.amount, 50);
    assert.deepEqual(calls, ["skipped"]);
});
