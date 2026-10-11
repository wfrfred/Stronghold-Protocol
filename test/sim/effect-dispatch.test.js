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
import { getUnit, transitionUnit } from "../../dist/core/tactical/battle/execution/context.js";
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
            invoke(context, _self, pending) {
                calls.push("first");
                effects.setEnabled(
                    context.battle,
                    { type: "EFFECT", unitId: 2, effectId: 1 },
                    enableSecond,
                );
                return { value: pending };
            },
        },
    ]);
    const second = damageEffect("second", {}, [
        {
            stage: "reception",
            invoke(_context, _self, pending) {
                calls.push("second");
                return { value: pending };
            },
        },
    ]);
    const target = attach(attach(unit(2), first), second);
    const battle = workFor(unit(1), target);
    const resources = new CombatResources();
    resolveDamage(battle, request(), resources);
    assert.deepEqual(calls, ["first"]);
    enableSecond = true;
    resolveDamage(battle, request(), resources);
    assert.deepEqual(calls, ["first", "first", "second"]);
    assert.equal(target.effects.instances[1].status, "ACTIVE");
});

test("finishing a pending Effect removes its Hook before that candidate can execute", () => {
    const calls = [];
    const first = damageEffect("end-second", {}, [
        {
            stage: "reception",
            priority: 10,
            invoke(context, _self, pending) {
                calls.push("first");
                effects.end(context.battle, { type: "EFFECT", unitId: 2, effectId: 1 });
                return { value: pending };
            },
        },
    ]);
    const second = damageEffect(
        "ended",
        {},
        [
            {
                stage: "reception",
                invoke(_context, _self, pending) {
                    calls.push("second");
                    return { value: pending };
                },
            },
        ],
        {
            onEnd() {
                calls.push("end");
            },
        },
    );
    const battle = workFor(unit(1), attach(attach(unit(2), first), second));
    resolveDamage(battle, request(), new CombatResources());
    assert.deepEqual(calls, ["first", "end"]);
    assert.equal(getUnit(battle, 2).effects.instances.length, 1);
    assert.equal(getUnit(battle, 2).vitality.damageHooks.length, 1);
});

test("removed registrations stay absent even when replaced under the same id during nested damage", () => {
    const calls = [];
    const resources = new CombatResources();
    let nested = false;
    let changed = false;
    const replacement = damageHook("second", "sourceFormula", (_context, input) => {
        calls.push("replacement");
        return { value: { ...input, power: input.power * 2 } };
    });
    const added = damageHook("third", "sourceFormula", (_context, input) => {
        calls.push("added");
        return { value: { ...input, power: input.power * 3 } };
    });
    const first = damageHook(
        "first",
        "sourceFormula",
        (context, input) => {
            calls.push(nested ? "nested-first" : "first");
            if (!changed) {
                changed = true;
                transitionUnit(context.battle, 1, (value) =>
                    damage.setHook(
                        damage.setHook(damage.removeHook(value, "second"), replacement),
                        added,
                    ),
                );
                nested = true;
                resources.settleDamage(context.battle, request(10));
                nested = false;
            }
            return { value: input };
        },
        10,
    );
    const old = damageHook("second", "sourceFormula", (_context, input) => {
        calls.push("removed");
        return { value: input };
    });
    const source = damage.setHook(damage.setHook(unit(1, { hp: 1000 }), first), old);
    const battle = workFor(source, unit(2, { hp: 1000 }));
    const initial = resolveDamage(battle, request(100), resources);
    assert.deepEqual(calls, ["first", "nested-first"]);
    assert.equal(initial.hpLoss, 100);
    assert.equal(getUnit(battle, 2).vitality.hp, 890);
    assert.deepEqual(source.vitality.damageHooks, [first, old]);
    calls.length = 0;
    assert.equal(resolveDamage(battle, request(100), resources).hpLoss, 600);
    assert.deepEqual(calls, ["first", "replacement", "added"]);
});

test("damage and healing share the active receiver candidates across direct nested operations", () => {
    const calls = [];
    const resources = new CombatResources();
    let changed = false;
    const originalHealing = healingHook("original", "reception", (_context, pending) => {
        calls.push("original-healing");
        return { value: pending };
    });
    const newHealing = healingHook("new", "reception", (_context, pending) => {
        calls.push("new-healing");
        return { value: pending };
    });
    const first = damageHook("damage", "reception", (context, pending) => {
        calls.push("damage");
        if (!changed) {
            changed = true;
            transitionUnit(context.battle, 2, (value) =>
                healing.setHook(healing.removeHook(value, "original"), newHealing),
            );
            resolveHealing(context.battle, healRequest(), resources);
        }
        return { value: pending };
    });
    const receiver = healing.setHook(
        damage.setHook(unit(2, { hp: 500, maxHp: 1000 }), first),
        originalHealing,
    );
    const battle = workFor(unit(1), receiver);
    resolveDamage(battle, request(100), resources);
    assert.deepEqual(calls, ["damage"]);
    assert.equal(getUnit(battle, 2).vitality.hp, 410);
    resolveHealing(battle, healRequest(), resources);
    assert.deepEqual(calls, ["damage", "new-healing"]);
    assert.equal(getUnit(battle, 2).vitality.hp, 420);
});

test("nested damage shares a healing receiver enumeration without admitting newly registered damage hooks", () => {
    const calls = [];
    const resources = new CombatResources();
    let changed = false;
    const late = damageHook("late", "reception", (_context, pending) => {
        calls.push("late-damage");
        return { value: pending };
    });
    const first = healingHook("healing", "reception", (context, pending) => {
        calls.push("healing");
        if (!changed) {
            changed = true;
            transitionUnit(context.battle, 2, (value) => damage.setHook(value, late));
            resources.settleDamage(context.battle, request(10));
        }
        return { value: pending };
    });
    const battle = workFor(unit(1), healing.setHook(unit(2, { hp: 500, maxHp: 1000 }), first));
    resolveHealing(battle, healRequest(20), resources);
    assert.deepEqual(calls, ["healing"]);
    assert.equal(getUnit(battle, 2).vitality.hp, 510);
    resolveDamage(battle, request(10), resources);
    assert.deepEqual(calls, ["healing", "late-damage"]);
});

test("cancellation and stopping this Hook stage are separate decisions", () => {
    for (const stopDispatch of [false, true]) {
        const calls = [];
        const cancel = damageHook(
            "cancel",
            "reception",
            (_context, pending) => {
                calls.push("cancel");
                return {
                    value: { ...pending, cancellation: { stage: "RECEPTION", reason: "BLOCKED" } },
                    stopDispatch,
                };
            },
            10,
        );
        const after = damageHook("after", "reception", (_context, pending) => {
            calls.push(pending.cancellation.reason);
            return { value: pending };
        });
        const react = damageHook("reaction", "reaction", (_context, report) => {
            calls.push(`reaction:${report.hpLoss}`);
        });
        let target = damage.setHook(unit(2), cancel);
        target = damage.setHook(damage.setHook(target, after), react);
        const battle = workFor(unit(1), target);
        const report = resolveDamage(battle, request(), new CombatResources());
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
        () => {
            calls.push("first");
            return { stopDispatch: true };
        },
        10,
    );
    const second = damageHook("second", "reaction", () => {
        calls.push("second");
    });
    const self = damage.setHook(damage.setHook(unit(1), first), second);
    const battle = workFor(self);
    resolveDamage(battle, request(10, { targetUnitId: 1 }), new CombatResources());
    assert.deepEqual(calls, ["first"]);
});

test("nested operations read already changed Effect state and inherit the enclosing event tick", () => {
    const uses = [];
    const content = damageEffect("once", { ready: true }, [
        {
            stage: "reception",
            invoke(context, self, pending) {
                uses.push(self.state.ready);
                if (self.state.ready) {
                    setSelf(context, self, { ready: false });
                    context.operations.heal({ sourceUnitId: 1, targetUnitId: 2, power: 10 });
                    context.operations.damage({ ...request(5), tick: 999 });
                }
                return { value: pending };
            },
        },
    ]);
    const battle = workFor(unit(1), attach(unit(2, { hp: 500, maxHp: 1000 }), content));
    resolveDamage(battle, request(100, { tick: 42 }), new CombatResources());
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
            invoke(_context, _self, pending) {
                calls.push(pending.cancellation.reason);
                return { value: pending };
            },
        },
        {
            stage: "reaction",
            invoke(_context, _self, report) {
                calls.push(`reaction:${report.hpLoss}`);
            },
        },
    ]);
    const target = attach(attach(unit(2), statusEffect("invincible", ["INVINCIBLE"])), content);
    const battle = workFor(unit(1), target);
    const result = resolveDamage(battle, request(), new CombatResources());
    assert.equal(result.hpLoss, 0);
    assert.deepEqual(calls, ["INVINCIBLE", "reaction:0"]);
});

test("skipping modifier events selects the dedicated reception stage and suppresses reactions", () => {
    const calls = [];
    let target = damage.setHook(
        unit(2),
        damageHook("ordinary", "reception", (_context, value) => {
            calls.push("ordinary");
            return { value };
        }),
    );
    target = damage.setHook(
        target,
        damageHook("skipped", "skippedReception", (_context, value) => {
            calls.push("skipped");
            return { value: { ...value, amount: value.amount / 2 } };
        }),
    );
    target = damage.setHook(
        target,
        damageHook("reaction", "reaction", () => {
            calls.push("reaction");
        }),
    );
    const battle = workFor(unit(1), target);
    const result = resolveDamage(
        battle,
        request(100, {
            receptionPolicy: { considerInvincibility: true, skipModifierEvents: true },
        }),
        new CombatResources(),
    );
    assert.equal(result.hpLoss, 50);
    assert.deepEqual(calls, ["skipped"]);
});

test("healing hooks resolve output and reception before notifying each participant", () => {
    const calls = [];
    const source = healingEffect("healing-output", {}, [
        {
            stage: "output",
            invoke(_context, _self, pending) {
                calls.push("output");
                return { value: { ...pending, amount: pending.amount * 2 } };
            },
        },
        {
            stage: "reaction",
            invoke(_context, _self, report) {
                calls.push(`source:${report.amount}`);
            },
        },
    ]);
    const target = healingEffect("healing-reception", {}, [
        {
            stage: "reception",
            invoke(_context, _self, pending) {
                calls.push("reception");
                return { value: { ...pending, amount: pending.amount + 5 } };
            },
        },
        {
            stage: "reaction",
            invoke(_context, _self, report) {
                calls.push(`target:${report.amount}`);
            },
        },
    ]);
    const battle = workFor(
        attach(unit(1), source),
        attach(unit(2, { hp: 990, maxHp: 1000 }), target),
    );
    const result = resolveHealing(battle, healRequest(10), new CombatResources());
    assert.equal(result.amount, 10);
    assert.deepEqual(calls, ["output", "reception", "target:10", "source:10"]);
    assert.equal(getUnit(battle, 2).vitality.hp, 1000);
});

test("healing cancellation stays visible to reception and reaction while ignoreHealFree changes the request rule", () => {
    const calls = [];
    const observer = healingEffect("observe-healing", {}, [
        {
            stage: "reception",
            invoke(_context, _self, pending) {
                calls.push(pending.cancellation?.reason ?? "accepted");
                return { value: pending };
            },
        },
        {
            stage: "reaction",
            invoke(_context, _self, report) {
                calls.push(`reaction:${report.amount}`);
            },
        },
    ]);
    const target = attach(unit(2, { hp: 500, maxHp: 1000, flags: ["HEAL_FREE"] }), observer);
    const battle = workFor(unit(1), target);
    const resources = new CombatResources();
    assert.equal(resolveHealing(battle, healRequest(10), resources).amount, 0);
    assert.equal(
        resolveHealing(battle, healRequest(10, { ignoreHealFree: true }), resources).amount,
        10,
    );
    assert.deepEqual(calls, ["HEAL_FREE", "reaction:0", "accepted", "reaction:10"]);
});

test("healing uses the dedicated skipped stage and suppresses output and reaction modifiers", () => {
    const calls = [];
    const source = healing.setHook(
        unit(1),
        healingHook("output", "output", (_context, value) => {
            calls.push("output");
            return { value: { ...value, amount: value.amount * 2 } };
        }),
    );
    let target = healing.setHook(
        unit(2, { hp: 500, maxHp: 1000 }),
        healingHook("ordinary", "reception", (_context, value) => {
            calls.push("ordinary");
            return { value };
        }),
    );
    target = healing.setHook(
        target,
        healingHook("skipped", "skippedReception", (_context, value) => {
            calls.push("skipped");
            return { value: { ...value, amount: value.amount / 2 } };
        }),
    );
    target = healing.setHook(
        target,
        healingHook("reaction", "reaction", () => {
            calls.push("reaction");
        }),
    );
    const battle = workFor(source, target);
    const result = resolveHealing(
        battle,
        healRequest(100, { skipModifierEvents: true }),
        new CombatResources(),
    );
    assert.equal(result.amount, 50);
    assert.deepEqual(calls, ["skipped"]);
});
