import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import {
    combatWorkView,
    getCombatUnit,
    combatWorkEvents,
} from "../../dist/core/tactical/battle/execution/work.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { copyUnitSnapshot } from "../../dist/core/tactical/unit/snapshot.js";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import {
    installNewEffect,
    setEffectParticipation,
    finishEffect,
    finalizeEffect,
    removeEffect,
    expireEffects,
} from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { updateEffectState } from "../../dist/core/tactical/unit/capability/effects/transition.js";
import { createNumericContribution } from "../../dist/core/tactical/modifier/numeric.js";
import { compileNumericProjectionBinding } from "../../dist/core/tactical/unit/capability/effects/contribution-bindings.js";
import {
    vitalityMaxHpContributions,
    initializeVitalityState,
} from "../../dist/core/tactical/unit/capability/vitality/capability.js";
import { resolveMaxHp } from "../../dist/core/tactical/unit/capability/vitality/query.js";
import { healUnit } from "../../dist/core/tactical/unit/capability/vitality/healing/settlement.js";
import { createShapeGeometry } from "../../dist/core/tactical/geometry/shape.js";
import { createLegacyCombatSpec } from "../../dist/legacy/combat.js";
import { effectFixtureWork } from "../helpers/effects.js";

const bonus = (amount) => createNumericContribution({ finalAddition: amount });
const address = (instanceId = 0) => ({ unitId: 1, instanceId });
const receiver = (hp = 50) => {
    const unit = initializeUnit({
        id: 1,
        definition: { id: "max-hp-receiver", vitality: { maxHp: 100 } },
        position: [0, 0],
    });
    return { ...unit, vitality: { ...unit.vitality, hp } };
};
const pair = (work) => [getCombatUnit(work, 1).vitality.hp, resolveMaxHp(1, combatWorkView(work))];
const program = (id, amount) =>
    createEffectProgram({
        id,
        initialize: () => ({ amount, revision: 0 }),
        ownState: (state) => ({ ...state }),
    });
const install = (work, ref, resources, patch = {}) =>
    installNewEffect(
        work,
        1,
        ref,
        {
            source: null,
            scope: null,
            expiresAtTick: null,
            ...patch,
        },
        resources,
        0,
    ).work;

test("MaxHP: install, payload, participation, finish and cleanup retain HP percentage", () => {
    for (const hp of [100, 50, 0]) {
        const resources = new CombatResources();
        const effect = resources.registerEffect(program("max-hp", 100), {
            contributions: { maxHp: (instance) => [bonus(instance.state.amount)] },
        });
        const initial = effectFixtureWork(receiver(hp));
        const installed = install(initial, effect.ref, resources);
        assert.deepEqual(pair(installed), [hp * 2, 200]);
        const updated = updateEffectState(
            installed,
            1,
            0,
            effect.ref,
            (state) => ({ ...state, amount: 200 }),
            resources,
        );
        assert.deepEqual(pair(updated), [hp * 3, 300]);
        const disabled = setEffectParticipation(updated, address(), false, resources, 1);
        assert.deepEqual(pair(disabled), [hp, 100]);
        const refreshed = updateEffectState(
            disabled,
            1,
            0,
            effect.ref,
            (state) => ({ ...state, amount: 300 }),
            resources,
        );
        assert.deepEqual(pair(refreshed), [hp, 100]);
        const enabled = setEffectParticipation(refreshed, address(), true, resources, 2);
        assert.deepEqual(pair(enabled), [hp * 4, 400]);
        const finished = finishEffect(enabled, address(), resources, 3);
        assert.deepEqual(pair(finished), [hp, 100]);
        const cleared = finalizeEffect(finished, address(), resources, 3);
        assert.deepEqual(pair(cleared), [hp, 100]);
        assert.deepEqual(getCombatUnit(cleared, 1).vitality.maxHp.entries, []);
        assert.deepEqual(pair(initial), [hp, 100]);
        assert.deepEqual(combatWorkEvents(cleared), []);
    }
});

test("MaxHP: callbacks and synchronous nested successors see coordinated facts", () => {
    const resources = new CombatResources();
    const observed = [];
    const inspect = (label, context) => {
        const unit = context.facts.getUnit(1);
        observed.push([
            label,
            unit.vitality.hp,
            resolveMaxHp(1, { getUnit: context.facts.getUnit }),
        ]);
    };
    const child = resources.registerEffect(program("child-hp", 50), {
        contributions: { maxHp: (instance) => [bonus(instance.state.amount)] },
    });
    const parent = resources.registerEffect(program("parent-hp", 100), {
        contributions: { maxHp: (instance) => [bonus(instance.state.amount)] },
        lifecycle: {
            start: (context) => {
                inspect("start", context);
            },
            enable: (context) => {
                inspect("enable", context);
                context.effects.update(context.address, parent.ref, (state) => ({
                    ...state,
                    amount: 200,
                }));
                inspect("update", context);
                const installed = context.effects.install(1, child.ref, {
                    source: null,
                    scope: null,
                    expiresAtTick: null,
                });
                context.effects.attachParent(installed.address, context.address);
                inspect("child", context);
            },
            disable: (context) => {
                inspect("disable", context);
            },
            finalize: (context) => {
                inspect("finalize", context);
            },
        },
    });
    const installed = install(effectFixtureWork(receiver()), parent.ref, resources);
    const removed = removeEffect(installed, address(), resources, 1);
    assert.deepEqual(observed, [
        ["start", 50, 100],
        ["enable", 100, 200],
        ["update", 150, 300],
        ["child", 175, 350],
        ["disable", 75, 150],
        ["finalize", 50, 100],
    ]);
    assert.deepEqual(pair(removed), [50, 100]);
});

test("MaxHP: one binding batch coordinates once after every slot has changed", () => {
    const resources = new CombatResources();
    const observed = [];
    const first = compileNumericProjectionBinding({
        id: "first",
        target: vitalityMaxHpContributions,
        group: undefined,
        project: () => [bonus(100)],
    });
    const second = compileNumericProjectionBinding({
        id: "second",
        target: vitalityMaxHpContributions,
        group: undefined,
        project: () => [bonus(100)],
    });
    const effect = resources.registerEffect(program("two-bindings", 0), {
        bindings: [
            first,
            {
                ...second,
                setParticipation: (unit, instance, participating) => {
                    observed.push(unit.vitality.hp);
                    return second.setParticipation(unit, instance, participating);
                },
            },
        ],
    });
    const installed = install(effectFixtureWork(receiver()), effect.ref, resources);
    const disabled = setEffectParticipation(installed, address(), false, resources, 1);
    assert.deepEqual(observed, [50, 150]);
    assert.deepEqual(pair(installed), [150, 300]);
    assert.deepEqual(pair(disabled), [50, 100]);
});

test("MaxHP: ordinary healing consumes the current upper bound and prohibition does not reject coordination", () => {
    const resources = new CombatResources();
    const effect = resources.registerEffect(program("healing-hp", 100), {
        contributions: { maxHp: (instance) => [bonus(instance.state.amount)] },
    });
    const installed = install(effectFixtureWork(receiver()), effect.ref, resources);
    const unit = getCombatUnit(installed, 1);
    const healed = healUnit(unit, 500);
    assert.equal(healed.amount, 100);
    assert.equal(healed.unit.vitality.hp, 200);
    const blocked = initializeUnit({
        id: 1,
        position: [0, 0],
        definition: {
            id: "heal-free-hp",
            vitality: { maxHp: 100 },
            status: { initialFlags: ["HEAL_FREE"] },
        },
    });
    const coordinated = install(
        effectFixtureWork({ ...blocked, vitality: { ...blocked.vitality, hp: 50 } }),
        effect.ref,
        resources,
    );
    assert.deepEqual(pair(coordinated), [100, 200]);
    assert.equal(healUnit(getCombatUnit(coordinated, 1), 50).amount, 0);
    assert.deepEqual(combatWorkEvents(coordinated), []);
});

test("MaxHP: group winner replacement and fallback preserve the current HP ratio", () => {
    const resources = new CombatResources();
    const register = (id, amount, strength) =>
        resources.registerEffect(program(id, amount), {
            contributions: {
                group: { id: "hp-group", strength },
                maxHp: (instance) => [bonus(instance.state.amount)],
            },
        });
    const weak = register("weak", 50, 1);
    const strong = register("strong", 200, 2);
    const initial = effectFixtureWork(receiver());
    const first = install(initial, weak.ref, resources);
    const second = install(first, strong.ref, resources);
    assert.deepEqual(pair(first), [75, 150]);
    assert.deepEqual(pair(second), [150, 300]);
    const weakerUpdated = updateEffectState(
        second,
        1,
        0,
        weak.ref,
        (state) => ({ ...state, amount: 100 }),
        resources,
    );
    assert.deepEqual(pair(weakerUpdated), [150, 300]);
    const disabled = setEffectParticipation(weakerUpdated, address(1), false, resources, 1);
    assert.deepEqual(pair(disabled), [100, 200]);
    const enabled = setEffectParticipation(disabled, address(1), true, resources, 2);
    assert.deepEqual(pair(enabled), [150, 300]);
    const ended = removeEffect(enabled, address(1), resources, 3);
    assert.deepEqual(pair(ended), [100, 200]);
    assert.deepEqual(pair(removeEffect(ended, address(), resources, 3)), [50, 100]);
});

test("MaxHP: unchanged effective values, inactive cleanup and snapshots do not reapply coordination", () => {
    const resources = new CombatResources();
    const effect = resources.registerEffect(program("clamped-hp", -500), {
        contributions: { maxHp: (instance) => [bonus(instance.state.amount)] },
    });
    const initial = effectFixtureWork(receiver(Math.PI));
    const installed = install(initial, effect.ref, resources, { expiresAtTick: 5 });
    const copied = copyUnitSnapshot(getCombatUnit(installed, 1));
    assert.equal(copied.vitality.maxHp.entries, getCombatUnit(installed, 1).vitality.maxHp.entries);
    assert.deepEqual(pair(effectFixtureWork(copied)), pair(installed));
    assert.equal(setEffectParticipation(installed, address(), true, resources, 1), installed);
    const updated = updateEffectState(
        installed,
        1,
        0,
        effect.ref,
        (state) => ({ ...state, amount: -600 }),
        resources,
    );
    assert.equal(getCombatUnit(updated, 1).vitality.hp, getCombatUnit(installed, 1).vitality.hp);
    assert.equal(resolveMaxHp(1, combatWorkView(updated)), 1);
    const noChange = updateEffectState(
        updated,
        1,
        0,
        effect.ref,
        (state) => ({ ...state, revision: 1 }),
        resources,
    );
    assert.equal(getCombatUnit(noChange, 1).vitality.hp, getCombatUnit(updated, 1).vitality.hp);
    const expired = expireEffects(noChange, 5, resources);
    const hp = getCombatUnit(expired, 1).vitality.hp;
    const cleared = finalizeEffect(expired, address(), resources, 5);
    assert.equal(getCombatUnit(cleared, 1).vitality.hp, hp);
    assert.equal(finishEffect(cleared, address(), resources, 5), cleared);
    assert.equal(copied.vitality.hp, Math.PI / 100);
    assert.deepEqual(pair(initial), [Math.PI, 100]);
});

test("MaxHP: a tick failure does not publish contributions or the HP response", () => {
    const resources = new CombatResources();
    const fault = { enabled: true };
    const effect = resources.registerEffect(program("transaction-hp", 100), {
        contributions: { maxHp: (instance) => [bonus(instance.state.amount)] },
        lifecycle: {
            enable: (context) => {
                assert.equal(context.facts.getUnit(1).vitality.hp, 100);
                if (fault.enabled) {
                    throw new Error("abort hp tick");
                }
            },
        },
    });
    const range = {
        type: "SHAPES",
        geometry: createShapeGeometry({ shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 5 }] }),
    };
    const acting = {
        id: "hp-installer",
        allegiance: { side: "ALLY" },
        vitality: { maxHp: 100 },
        action: {
            normalAction: {
                triggerBindingId: "primary",
                intervalTicks: 30,
                recoveryTicks: 0,
                targetGroups: [
                    {
                        id: "primary",
                        targeting: {
                            type: "DAMAGE",
                            scope: { type: "RANGE", geometry: range },
                            canTargetAir: true,
                            includeBlockingRelations: false,
                            preferBlockingRelations: false,
                            ignoreTargetFree: false,
                            ignoreInvisible: false,
                            maxTargets: 1,
                        },
                        operations: [],
                    },
                ],
                followUps: [],
            },
        },
    };
    const runtime = new BattleRuntime(
        {
            ...createLegacyCombatSpec({
                rows: 1,
                columns: 3,
                operators: [],
                enemies: [],
                maxTicks: 10,
                seed: 17,
            }),
            initialUnits: [
                { definition: acting, position: [0, 0] },
                {
                    definition: {
                        id: "hp-target",
                        allegiance: { side: "ENEMY" },
                        vitality: { maxHp: 100 },
                        hit: { geometry: range.geometry },
                    },
                    position: [1, 0],
                    states: { vitality: { ...initializeVitalityState({ maxHp: 100 }), hp: 50 } },
                },
            ],
        },
        {
            combat: resources,
            compileAction: (definition) => ({
                definition,
                bind: () => new Map([["primary", [1]]]),
                program: [
                    {
                        type: "EXECUTE",
                        run: (context) => ({ work: install(context.work, effect.ref, resources) }),
                    },
                ],
            }),
        },
    );
    const before = runtime.snapshot();
    assert.throws(() => runtime.step(), /abort hp tick/);
    assert.deepEqual(runtime.snapshot(), before);
    fault.enabled = false;
    runtime.step();
    const after = runtime.snapshot();
    assert.equal(after.tickIndex, 1);
    assert.equal(after.units.find((unit) => unit.id === 1).vitality.hp, 100);
    assert.equal(before.units.find((unit) => unit.id === 1).vitality.hp, 50);
});

test("MaxHP: TypeScript permits maintained projections and rejects live-provider installation", async () => {
    const { default: ts } = await import("typescript");
    const directory = mkdtempSync(join(tmpdir(), "stronghold-max-hp-types-"));
    const module = (name) =>
        JSON.stringify(
            fileURLToPath(new URL(`../../src/core/tactical/${name}.js`, import.meta.url)),
        );
    const path = join(directory, "max-hp.mts");
    writeFileSync(
        path,
        `
import { compileNumericProjectionBinding, compileNumericProviderBinding } from ${module("unit/capability/effects/contribution-bindings")};
import { vitalityMaxHpContributions, type VitalityState } from ${module("unit/capability/vitality/capability")};
import { offenseAttackContributions } from ${module("unit/capability/offense/capability")};
import { createNumericContributionState, registerNumericContribution, updateNumericContribution } from ${module("modifier/contribution")};
import { NumericContributionResources } from ${module("modifier/providers")};
import { CombatResources } from ${module("battle/resources")};
import { createEffectProgram } from ${module("unit/capability/effects/program")};
import type { NumericContributionTarget, NumericProjectionTarget, NumericProviderFacts } from ${module("unit/capability/contribution")};
const providers = new NumericContributionResources<NumericProviderFacts>();
const group = undefined;
compileNumericProjectionBinding({ id: 'hp', target: vitalityMaxHpContributions, project: () => [], group });
compileNumericProjectionBinding({ id: 'attack', target: offenseAttackContributions, project: () => [], group });
compileNumericProviderBinding({ id: 'attack', target: offenseAttackContributions, providers, providerRef: 'attack', evaluate: () => [], group });
// @ts-expect-error MaxHP cannot install live provider bindings.
compileNumericProviderBinding({ id: 'hp', target: vitalityMaxHpContributions, providers, providerRef: 'hp', evaluate: () => [], group });
// @ts-expect-error A broad target alias cannot hide the MaxHP restriction.
const broad: NumericContributionTarget = vitalityMaxHpContributions;
const projection: NumericProjectionTarget = vitalityMaxHpContributions;
// @ts-expect-error A projection target alias still rejects a provider transition.
compileNumericProviderBinding({ id: 'hp', target: projection, providers, providerRef: 'hp', evaluate: () => [], group });
const fixed = createNumericContributionState<'values'>();
// @ts-expect-error Direct installation cannot insert a provider into value-only state.
registerNumericContribution(fixed, { id: 'hp', sequence: 0, participating: true, providerRef: 'hp' });
// @ts-expect-error An update cannot replace a maintained value with a provider.
updateNumericContribution(fixed, 'hp', () => ({ id: 'hp', sequence: 0, participating: true, providerRef: 'hp' }));
// @ts-expect-error Vitality cannot hold a provider-bearing state.
const invalid: VitalityState = { hp: 100, maxHp: createNumericContributionState([{ id: 'hp', sequence: 0, participating: true, providerRef: 'hp' }]) };
const combat = new CombatResources();
const effect = createEffectProgram({ id: 'hp', initialize: () => ({ bonus: 100 }), ownState: state => ({ ...state }) });
combat.registerEffect(effect, { contributions: { maxHp: instance => [{ addition: 0, multiplier: 0, finalAddition: instance.state.bonus, finalScaler: 1 }] } });
// @ts-expect-error MaxHP projection cannot read unsignalled live unit facts.
combat.registerEffect(effect, { contributions: { maxHp: context => [{ addition: 0, multiplier: 0, finalAddition: context.unit.vitality.hp, finalScaler: 1 }] } });
`,
    );
    try {
        const program = ts.createProgram([path], {
            noEmit: true,
            strict: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            skipLibCheck: true,
            types: [],
        });
        assert.deepEqual(
            ts
                .getPreEmitDiagnostics(program)
                .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
            [],
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
