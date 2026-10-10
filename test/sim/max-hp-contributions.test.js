import { maxHp } from "../../dist/core/tactical/unit/capability/vitality/contributions.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import { battlefieldView, getUnit } from "../../dist/core/tactical/battle/execution/context.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { copyUnitSnapshot } from "../../dist/core/tactical/unit/snapshot.js";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import {
    installNewEffect,
    setEffectEnabled,
    finishEffects,
    finalizeEffect,
    removeEffect,
    expireEffects,
} from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import { updateEffectState } from "../../dist/core/tactical/unit/capability/effects/lifecycle.js";
import * as modifier from "../../dist/core/tactical/modifier/value.js";
import { sampled } from "../../dist/core/tactical/unit/capability/effects/binding.js";
import { preserveHpRatio } from "../../dist/core/tactical/unit/capability/vitality/max-hp.js";
import {
    updateMaxHpContributions,
    initializeVitalityState,
} from "../../dist/core/tactical/unit/capability/vitality/capability.js";
import { resolveMaxHp } from "../../dist/core/tactical/unit/capability/vitality/query.js";
import { healUnit } from "../../dist/core/tactical/unit/capability/vitality/healing/settlement.js";
import { createShapeGeometry } from "../../dist/core/tactical/geometry/shape.js";
import { createLegacyCombatSpec } from "../../dist/legacy/combat.js";
import { effectFixtureWork } from "../helpers/effects.js";

const bonus = (amount) => modifier.create({ finalAddition: amount });
const address = (instanceId = 0) => ({ type: "EFFECT", unitId: 1, effectId: instanceId });
const receiver = (hp = 50) => {
    const unit = initializeUnit({
        id: 1,
        definition: { id: "max-hp-receiver", vitality: { maxHp: 100 } },
        position: [0, 0],
    });
    return { ...unit, vitality: { ...unit.vitality, hp } };
};
const pair = (work) => [getUnit(work, 1).vitality.hp, resolveMaxHp(1, battlefieldView(work))];
const program = (id, amount) =>
    createEffectProgram({
        id,
        initialize: () => ({ amount, revision: 0 }),
    });
const install = (work, ref, resources, patch = {}) => {
    installNewEffect(
        work,
        1,
        ref,
        {
            source: null,
            scopes: [],
            ...patch,
        },
        resources,
        0,
    );
};

test("MaxHP: install, payload, participation, finish and cleanup retain HP percentage", () => {
    for (const hp of [100, 50, 0]) {
        const resources = new CombatResources();
        const effect = resources.registerEffect(program("max-hp", 100), {
            contributions: [maxHp((instance) => [bonus(instance.state.amount)])],
        });
        const work = effectFixtureWork(receiver(hp));
        const before = work.battlefield.snapshot("draft");
        install(work, effect.ref, resources);
        assert.deepEqual(pair(work), [hp * 2, 200]);

        updateEffectState(
            work,
            1,
            0,
            effect.ref,
            (state) => ({ ...state, amount: 200 }),
            resources,
            0,
        );
        assert.deepEqual(pair(work), [hp * 3, 300]);

        setEffectEnabled(work, address(), false, resources, 1);
        assert.deepEqual(pair(work), [hp, 100]);

        updateEffectState(
            work,
            1,
            0,
            effect.ref,
            (state) => ({ ...state, amount: 300 }),
            resources,
            0,
        );
        assert.deepEqual(pair(work), [hp, 100]);

        setEffectEnabled(work, address(), true, resources, 2);
        assert.deepEqual(pair(work), [hp * 4, 400]);

        finishEffects(work, [address()], resources, 3);
        assert.deepEqual(pair(work), [hp, 100]);

        finalizeEffect(work, address(), resources, 3);
        assert.deepEqual(pair(work), [hp, 100]);
        assert.deepEqual(getUnit(work, 1).vitality.maxHp.entries, []);
        assert.equal(before.getUnit(1).vitality.hp, hp);
        assert.equal(resolveMaxHp(1, before), 100);
        assert.deepEqual(work.events, []);
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
        contributions: [maxHp((instance) => [bonus(instance.state.amount)])],
    });
    const parent = resources.registerEffect(program("parent-hp", 100), {
        contributions: [maxHp((instance) => [bonus(instance.state.amount)])],
        lifecycle: {
            start: (context) => {
                inspect("start", context);
            },
            enable: (context) => {
                inspect("enable", context);
                context.effects.update(context.ref, parent.ref, (state) => ({
                    ...state,
                    amount: 200,
                }));
                inspect("update", context);
                const installed = context.effects.install(1, child.ref, {
                    source: null,
                    scopes: [],
                });
                context.effects.bind(installed.ref, context.ref);
                inspect("child", context);
            },
            disable: (context) => {
                inspect("disable", context);
            },
            finish: (context) => {
                inspect("finish", context);
                assert.deepEqual(context.end, { root: address(), reason: "EXPLICIT" });
                assert.equal(context.facts.getEffect(context.ref).finished, true);
            },
        },
    });
    const work = effectFixtureWork(receiver());
    install(work, parent.ref, resources);
    finishEffects(work, [address()], resources, 1);
    assert.deepEqual(observed, [
        ["start", 50, 100],
        ["enable", 100, 200],
        ["update", 150, 300],
        ["child", 175, 350],
        ["disable", 50, 100],
        ["finish", 50, 100],
    ]);
    const notices = observed.length;
    finalizeEffect(work, address(), resources, 1);
    assert.equal(observed.length, notices);
    assert.equal(
        getUnit(work, 1).effects.instances.some(({ id }) => id === address().effectId),
        false,
    );
    assert.deepEqual(pair(work), [50, 100]);
});

test("MaxHP: one binding batch coordinates once after every slot has changed", () => {
    const resources = new CombatResources();
    const observed = [];
    const first = sampled({
        id: "first",
        target: updateMaxHpContributions,
        reconcile: preserveHpRatio,
        group: undefined,
        sample: () => [bonus(100)],
    });
    const second = sampled({
        id: "second",
        target: updateMaxHpContributions,
        reconcile: preserveHpRatio,
        group: undefined,
        sample: () => [bonus(100)],
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
    const work = effectFixtureWork(receiver());
    install(work, effect.ref, resources);
    const installedPair = pair(work);
    setEffectEnabled(work, address(), false, resources, 1);
    assert.deepEqual(observed, [50, 150]);
    assert.deepEqual(installedPair, [150, 300]);
    assert.deepEqual(pair(work), [50, 100]);
});

test("MaxHP: ordinary healing consumes the current upper bound and prohibition does not reject coordination", () => {
    const resources = new CombatResources();
    const effect = resources.registerEffect(program("healing-hp", 100), {
        contributions: [maxHp((instance) => [bonus(instance.state.amount)])],
    });
    const work = effectFixtureWork(receiver());
    install(work, effect.ref, resources);
    const unit = getUnit(work, 1);
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
    const coordinated = effectFixtureWork({
        ...blocked,
        vitality: { ...blocked.vitality, hp: 50 },
    });
    install(coordinated, effect.ref, resources);
    assert.deepEqual(pair(coordinated), [100, 200]);
    assert.equal(healUnit(getUnit(coordinated, 1), 50).amount, 0);
    assert.deepEqual(coordinated.events, []);
});

test("MaxHP: group winner replacement and fallback preserve the current HP ratio", () => {
    const resources = new CombatResources();
    const register = (id, amount, strength) =>
        resources.registerEffect(program(id, amount), {
            contributions: [
                maxHp((instance) => [bonus(instance.state.amount)], {
                    group: { id: "hp-group", strength },
                }),
            ],
        });
    const weak = register("weak", 50, 1);
    const strong = register("strong", 200, 2);
    const work = effectFixtureWork(receiver());
    install(work, weak.ref, resources);
    const firstPair = pair(work);
    install(work, strong.ref, resources);
    assert.deepEqual(firstPair, [75, 150]);
    assert.deepEqual(pair(work), [150, 300]);

    updateEffectState(work, 1, 0, weak.ref, (state) => ({ ...state, amount: 100 }), resources, 0);
    assert.deepEqual(pair(work), [150, 300]);

    setEffectEnabled(work, address(1), false, resources, 1);
    assert.deepEqual(pair(work), [100, 200]);

    setEffectEnabled(work, address(1), true, resources, 2);
    assert.deepEqual(pair(work), [150, 300]);

    removeEffect(work, address(1), resources, 3);
    assert.deepEqual(pair(work), [100, 200]);
    removeEffect(work, address(), resources, 3);
    assert.deepEqual(pair(work), [50, 100]);
});

test("MaxHP: unchanged effective values, inactive cleanup and snapshots do not reapply coordination", () => {
    const resources = new CombatResources();
    const effect = resources.registerEffect(program("clamped-hp", -500), {
        contributions: [maxHp((instance) => [bonus(instance.state.amount)])],
    });
    const work = effectFixtureWork(receiver(Math.PI));
    const before = work.battlefield.snapshot("draft");
    install(work, effect.ref, resources, { scopes: [{ type: "TICK", tick: 5 }] });
    const installedUnit = getUnit(work, 1);
    const copied = copyUnitSnapshot(installedUnit);
    assert.equal(copied.vitality.maxHp.entries, installedUnit.vitality.maxHp.entries);
    assert.deepEqual(pair(effectFixtureWork(copied)), pair(work));
    setEffectEnabled(work, address(), true, resources, 1);
    assert.equal(getUnit(work, 1), installedUnit);
    updateEffectState(
        work,
        1,
        0,
        effect.ref,
        (state) => ({ ...state, amount: -600 }),
        resources,
        0,
    );
    assert.equal(getUnit(work, 1).vitality.hp, installedUnit.vitality.hp);
    assert.equal(resolveMaxHp(1, battlefieldView(work)), 1);
    const beforeRevision = getUnit(work, 1);
    updateEffectState(work, 1, 0, effect.ref, (state) => ({ ...state, revision: 1 }), resources, 0);
    assert.equal(getUnit(work, 1).vitality.hp, beforeRevision.vitality.hp);
    expireEffects(work, 5, resources);
    const beforeCleanup = getUnit(work, 1);
    finalizeEffect(work, address(), resources, 5);
    assert.equal(getUnit(work, 1).vitality.hp, beforeCleanup.vitality.hp);
    const cleanedUnit = getUnit(work, 1);
    finishEffects(work, [address()], resources, 5);
    assert.equal(getUnit(work, 1), cleanedUnit);
    assert.equal(copied.vitality.hp, Math.PI / 100);
    assert.deepEqual([before.getUnit(1).vitality.hp, resolveMaxHp(1, before)], [Math.PI, 100]);
});

test("MaxHP: a tick failure does not publish contributions or the HP response", () => {
    const resources = new CombatResources();
    const effect = resources.registerEffect(program("transaction-hp", 100), {
        contributions: [maxHp((instance) => [bonus(instance.state.amount)])],
        lifecycle: {
            enable: (context) => {
                assert.equal(context.facts.getUnit(1).vitality.hp, 100);
                throw new Error("abort hp tick");
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
                baseAttackTimeTicks: 30,
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
                        run: (context) => {
                            install(context.work, effect.ref, resources);
                        },
                    },
                ],
            }),
        },
    );
    const before = runtime.snapshot();
    assert.throws(() => runtime.step(), /abort hp tick/);
    assert.deepEqual(runtime.snapshot(), before);
    assert.equal(before.units.find((unit) => unit.id === 1).vitality.hp, 50);
});

test("capabilities: TypeScript permits sampled MaxHP and blocking contributions and rejects live installation", async () => {
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
import { sampled, live } from ${module("unit/capability/effects/binding")};
import { updateMaxHpContributions, type VitalityState } from ${module("unit/capability/vitality/capability")};
import { updateAttackContributions } from ${module("unit/capability/offense/capability")};
import { attack, liveAttack } from ${module("unit/capability/offense/contributions")};
import { defense, liveDefense, resistance, liveResistance } from ${module("unit/capability/defense/contributions")};
import { maxHp } from ${module("unit/capability/vitality/contributions")};
import { capacity } from ${module("unit/capability/blocking/contributions")};
import { updateBlockingCapacityContributions, type BlockerState } from ${module("unit/capability/blocking/capability")};
import type { EffectInstance } from ${module("unit/capability/effects/instance")};
import * as contribution from ${module("modifier/contribution")};
import * as computation from ${module("modifier/computation")};
import { CombatResources } from ${module("battle/resources")};
import { createEffectProgram } from ${module("unit/capability/effects/program")};
import type { Target, SampledTarget, Context } from ${module("unit/capability/contribution")};
const computations = new computation.Resources<Context>();
const group = undefined;
sampled({ id: 'hp', target: updateMaxHpContributions, sample: () => [], group });
sampled({ id: 'capacity', target: updateBlockingCapacityContributions, sample: () => [], group });
sampled({ id: 'attack', target: updateAttackContributions, sample: () => [], group });
live({ id: 'attack', target: updateAttackContributions, computations, evaluator: 'attack', evaluate: () => [], group });
// @ts-expect-error MaxHP cannot install live bindings.
live({ id: 'hp', target: updateMaxHpContributions, computations, evaluator: 'hp', evaluate: () => [], group });
// @ts-expect-error Blocking cannot install live bindings.
live({ id: 'capacity', target: updateBlockingCapacityContributions, computations, evaluator: 'capacity', evaluate: () => [], group });
// @ts-expect-error A broad target alias cannot hide the MaxHP restriction.
const broad: Target = updateMaxHpContributions;
// @ts-expect-error A broad target alias cannot hide the blocking restriction.
const broadCapacity: Target = updateBlockingCapacityContributions;
const projection: SampledTarget = updateMaxHpContributions;
// @ts-expect-error A sampled target alias still rejects a live transition.
live({ id: 'hp', target: projection, computations, evaluator: 'hp', evaluate: () => [], group });
const fixed = contribution.create<'SAMPLED'>();
// @ts-expect-error Direct installation cannot insert a live contribution into sampled state.
contribution.register(fixed, { id: 'hp', sequence: 0, kind: "LIVE", participating: true, evaluator: 'hp' });
// @ts-expect-error An update cannot replace a sampled contribution with a live contribution.
contribution.update(fixed, 'hp', () => ({ id: 'hp', sequence: 0, kind: "LIVE", participating: true, evaluator: 'hp' }));
// @ts-expect-error Vitality cannot hold a live contribution.
const invalid: VitalityState = { hp: 100, maxHp: contribution.create([{ id: 'hp', sequence: 0, kind: "LIVE", participating: true, evaluator: 'hp' }]) };
// @ts-expect-error Blocking cannot hold a live contribution.
const invalidBlocker: BlockerState = { capacity: contribution.create([{ id: 'capacity', sequence: 0, kind: "LIVE", participating: true, evaluator: 'capacity' }]), enabled: true, geometry: { radius: 1 } };
const combat = new CombatResources();
const effect = createEffectProgram({ id: 'hp', initialize: () => ({ bonus: 100 }) });
const bonus = (amount: number) => [{ addition: 0, multiplier: 0, finalAddition: amount, finalScaler: 1 }];
combat.registerEffect(effect, { contributions: [
    maxHp(instance => bonus(instance.state.bonus)),
    capacity(instance => bonus(instance.state.bonus)),
    attack(instance => bonus(instance.state.bonus)),
    liveAttack(({ instance }) => bonus(instance.state.bonus), { id: 'live-attack' }),
    defense(instance => bonus(instance.state.bonus)),
    liveDefense(({ instance }) => bonus(instance.state.bonus), { id: 'live-defense' }),
    resistance(instance => bonus(instance.state.bonus)),
    liveResistance(({ instance }) => bonus(instance.state.bonus), { id: 'live-resistance' }),
] });
// @ts-expect-error MaxHP samples cannot read unsignalled live unit facts.
combat.registerEffect(effect, { contributions: [maxHp(instance => bonus(instance.unit.vitality.hp))] });
// @ts-expect-error MaxHP samples cannot read unsignalled battlefield facts.
combat.registerEffect(effect, { contributions: [maxHp(instance => bonus(instance.battlefield.getUnit(1).vitality.hp))] });
// @ts-expect-error Live callbacks preserve the matching program state.
combat.registerEffect(effect, { contributions: [liveAttack(({ instance }) => bonus(instance.state.missing))] });
const other = attack((instance: EffectInstance<{ other: number }>) => bonus(instance.state.other));
// @ts-expect-error An unrelated program state cannot supply a declaration.
combat.registerEffect(effect, { contributions: [other] });
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
