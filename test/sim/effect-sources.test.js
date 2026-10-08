import assert from "node:assert/strict";
import { test } from "node:test";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import {
    combatWorkView,
    combatWorkChanges,
    createCombatWork,
    getCombatMechanism,
    getCombatUnit,
    registerCombatUnit,
    updateCombatUnit,
} from "../../dist/core/tactical/battle/execution/work.js";
import { createMechanismDefinition, createMechanismRuntime } from "../../dist/core/tactical/battlefield/mechanism.js";
import { createEffectSourceProgramRef, effectSourceInstallation } from "../../dist/core/tactical/battlefield/effect-source/program.js";
import { copyEffectSourceState } from "../../dist/core/tactical/battlefield/effect-source/state.js";
import { createEffectSourceOperations } from "../../dist/core/tactical/battlefield/effect-source/operations.js";
import {
    finishEffectSource,
    reconcileEffectSources,
    registerEffectSourceUnits,
    setEffectSourceActive,
} from "../../dist/core/tactical/battlefield/effect-source/settlement.js";
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { createEffectProgram } from "../../dist/core/tactical/unit/capability/effects/program.js";
import { createNumericContribution } from "../../dist/core/tactical/modifier/numeric.js";
import { offenseAttackContributions } from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import { resolveDamage } from "../../dist/core/tactical/unit/capability/vitality/damage/settlement.js";

function unit(id, position = [0, 0]) {
    return initializeUnit({
        id,
        position,
        definition: { id: `source-unit-${id}`, vitality: { maxHp: 100 }, offense: { attack: 100 } },
    });
}

function receiverEffect(resources, id, facets = {}) {
    const program = createEffectProgram({
        id,
        initialize: () => ({ addition: 10 }),
        ownState: value => value,
    });

    return resources.registerEffect(program, {
        contributions: {
            contributions: [{
                id: "attack",
                target: offenseAttackContributions,
                project: context => [createNumericContribution({ finalAddition: context.state.addition })],
            }],
        },
        ...facets,
    });
}

function sourceProgram(resources, receiver, overrides = {}) {
    const ref = createEffectSourceProgramRef("domain-source");
    const program = resources.effectSources.register({
        ref,
        initialize: () => ({ remaining: 3 }),
        ownState: value => value,
        selectInitial: ({ battlefield }) => battlefield.unitIds,
        acceptsRegistration: () => true,
        install: ({ source, receiver: target }) => effectSourceInstallation(receiver.ref, {
            expiresAtTick: null,
            initialState: { addition: target.id * 10, sourceId: source.id },
        }),
        ...overrides,
    });

    return {
        program,
        source: createMechanismRuntime({
            id: 20,
            definition: createMechanismDefinition({ id: ref.id }),
            active: true,
            effectSource: resources.effectSources.create(ref, { sourceUnitId: null }),
        }),
    };
}

function fixtureWork(source, units = [unit(1), unit(2)]) {
    const byId = new Map(units.map(current => [current.id, current]));

    return createCombatWork({
        unitIds: [...byId.keys()],
        getUnit: id => byId.get(id),
        blockerOf: () => undefined,
        blockedBy: () => [],
    }, undefined, {
        mechanismIds: [source.id],
        getMechanism: id => id === source.id ? source : undefined,
    });
}

function attack(work, resources, id) {
    return resolveAttackPower(id, combatWorkView(work), resources.offense);
}

function observeMechanismCopies(work, run) {
    const NativeMap = globalThis.Map;
    const mechanismMaps = new WeakSet([work.mechanisms]);
    let currentMechanisms = work.mechanisms;
    let copies = 0;
    class ObservedMap extends NativeMap {
        constructor(entries) {
            super(entries);
            if (entries !== undefined && mechanismMaps.has(entries)) {
                mechanismMaps.add(this);
                currentMechanisms = this;
                copies++;
            }
        }
    }
    try {
        globalThis.Map = ObservedMap;
        const result = run(() => currentMechanisms);

        return { result, copies };
    } finally {
        globalThis.Map = NativeMap;
    }
}

test("effect sources: inactive registration is retained and participation keeps sampled receiver instances", () => {
    const resources = new CombatResources();
    const receiver = receiverEffect(resources, "paused-receivers");
    const { source } = sourceProgram(resources, receiver);
    let work = fixtureWork({ ...source, active: false });
    work = reconcileEffectSources(work, resources, 0);
    work = registerCombatUnit(work, unit(3));
    work = registerEffectSourceUnits(work, [3, 3], resources, 0);

    assert.deepEqual(getCombatMechanism(work, 20).effectSource.receivers.map(binding => binding.unitId), [1, 2, 3]);
    assert.equal(getCombatUnit(work, 3).effects, undefined);

    work = setEffectSourceActive(work, 20, true, resources, 1);
    const beforePause = getCombatMechanism(work, 20);
    const receiverInstances = [1, 2, 3].map(id => getCombatUnit(work, id).effects.instances[0]);
    assert.deepEqual([1, 2, 3].map(id => attack(work, resources, id)), [110, 120, 130]);

    work = setEffectSourceActive(work, 20, false, resources, 2);
    assert.deepEqual([1, 2, 3].map(id => attack(work, resources, id)), [100, 100, 100]);
    work = setEffectSourceActive(work, 20, true, resources, 3);

    assert.deepEqual(getCombatMechanism(work, 20).effectSource.receivers, beforePause.effectSource.receivers);
    assert.deepEqual([1, 2, 3].map(id => getCombatUnit(work, id).effects.instances[0].state), receiverInstances.map(instance => instance.state));
    assert.deepEqual([1, 2, 3].map(id => getCombatUnit(work, id).effects.nextInstanceId), [1, 1, 1]);
});

test("effect sources: rejected installation is a committed attempt and repeated notifications do not retry it", () => {
    const resources = new CombatResources();
    let admissions = 0;
    let selections = 0;
    const receiver = receiverEffect(resources, "rejected-receivers", {
        lifecycle: { accepts: () => { admissions++; return false; } },
    });
    const { source } = sourceProgram(resources, receiver, {
        selectInitial: ({ battlefield }) => { selections++; return battlefield.unitIds; },
    });
    let work = reconcileEffectSources(fixtureWork(source), resources, 0);
    work = registerEffectSourceUnits(work, [1, 2, 1], resources, 1);
    work = registerEffectSourceUnits(work, [], resources, 1);
    work = reconcileEffectSources(work, resources, 2);

    assert.equal(selections, 1);
    assert.equal(admissions, 2);
    assert.deepEqual(getCombatMechanism(work, 20).effectSource.receivers, [
        { unitId: 1, address: null, installationAttempts: 1 },
        { unitId: 2, address: null, installationAttempts: 1 },
    ]);
});

test("effect sources: explicit aura reconciliation tracks receiver identity independently from geometric membership", () => {
    const resources = new CombatResources();
    const receiver = receiverEffect(resources, "aura-receivers");
    const select = ({ battlefield }) => battlefield.unitIds.filter(id => battlefield.getUnit(id).position[0] < 1);
    const { source } = sourceProgram(resources, receiver, {
        selectInitial: select,
        selectCurrent: select,
        shouldReinstall: () => true,
    });
    let work = reconcileEffectSources(fixtureWork(source, [unit(1), unit(2, [2, 0])]), resources, 0);
    const firstAddress = getCombatMechanism(work, 20).effectSource.receivers[0].address;

    assert.equal(attack(work, resources, 1), 110);
    assert.equal(attack(work, resources, 2), 100);
    work = updateCombatUnit(work, { ...getCombatUnit(work, 1), position: [2, 0] });
    work = updateCombatUnit(work, { ...getCombatUnit(work, 2), position: [0, 0] });
    work = reconcileEffectSources(work, resources, 1);

    assert.equal(attack(work, resources, 1), 100);
    assert.equal(attack(work, resources, 2), 120);
    assert.equal(getCombatMechanism(work, 20).effectSource.receivers[0].address, null);
    work = updateCombatUnit(work, { ...getCombatUnit(work, 1), position: [0, 0] });
    work = reconcileEffectSources(work, resources, 2);
    const returned = getCombatMechanism(work, 20).effectSource.receivers[0];

    assert.equal(returned.installationAttempts, 2);
    assert.notDeepEqual(returned.address, firstAddress);
    assert.equal(attack(work, resources, 1), 110);
    work = finishEffectSource(work, 20, resources, 3);

    assert.equal(getCombatMechanism(work, 20).effectSource.finished, true);
    assert.equal(getCombatMechanism(work, 20).active, false);
    assert.deepEqual([1, 2].map(id => attack(work, resources, id)), [100, 100]);
});

test("effect sources: shared state operations own data and share the receiver graph without reinstallation", () => {
    const resources = new CombatResources();
    const receiver = receiverEffect(resources, "quota-receivers");
    const { source, program } = sourceProgram(resources, receiver);
    let work = reconcileEffectSources(fixtureWork(source), resources, 0);
    const baseline = work;
    const graph = getCombatMechanism(work, 20).effectSource.receivers;
    const operations = createEffectSourceOperations(() => work, next => { work = next; }, resources);

    for (let index = 0; index < 4; index++) {
        const consumed = operations.tryConsume(20, program.ref, state => state.remaining === 0 ? undefined : { ...state, remaining: state.remaining - 1 });
        assert.equal(consumed, index < 3);
    }

    assert.equal(operations.get(20, program.ref).effectSource.state.remaining, 0);
    assert.equal(getCombatMechanism(baseline, 20).effectSource.state.remaining, 3);
    assert.equal(getCombatMechanism(work, 20).effectSource.receivers, graph);
    const external = { remaining: 2, nested: { amount: 10 } };
    operations.update(20, program.ref, () => external);
    external.nested.amount = 999;

    assert.equal(operations.get(20, program.ref).effectSource.state.nested.amount, 10);
    const copied = copyEffectSourceState(getCombatMechanism(work, 20).effectSource);
    assert.equal(copied.programRef, program.ref);
    assert.equal(copied.receivers, graph);
    work = reconcileEffectSources(work, resources, 1);
    assert.deepEqual([1, 2].map(id => getCombatUnit(work, id).effects.nextInstanceId), [1, 1]);
    work = setEffectSourceActive(work, 20, false, resources, 2);
    assert.equal(operations.tryConsume(20, program.ref, state => ({ ...state, remaining: state.remaining - 1 })), false);
});

test("effect sources: nested damage hooks share current source quota and source ports expire with the callback", () => {
    const resources = new CombatResources();
    let retained;
    let sourceRef;
    const receiver = receiverEffect(resources, "hook-receivers", {
        damage: {
            reception: {
                priority: 0,
                apply: (context, pending) => {
                    retained = context.operations.sources;
                    const consumed = retained.tryConsume(context.instance.state.sourceId, sourceRef, state => state.remaining === 0 ? undefined : { ...state, remaining: state.remaining - 1 });
                    return { value: consumed ? { ...pending, amount: 0 } : pending };
                },
            },
        },
    });
    const { source, program } = sourceProgram(resources, receiver);
    sourceRef = program.ref;
    let work = reconcileEffectSources(fixtureWork(source), resources, 0);

    for (const targetUnitId of [1, 2, 1, 2]) {
        const result = resolveDamage(work, {
            sourceUnitId: null,
            targetUnitId,
            damageType: "TRUE",
            operands: createDamageOperands(10),
            tick: 1,
        }, resources);
        work = result.work;
        assert.equal(result.report.hpLoss, targetUnitId === 2 && getCombatMechanism(work, 20).effectSource.state.remaining === 0 ? 10 : 0);
    }

    assert.equal(getCombatUnit(work, 1).vitality.hp, 100);
    assert.equal(getCombatUnit(work, 2).vitality.hp, 90);
    assert.throws(() => retained.get(20, sourceRef), /no longer active/);
    assert.throws(() => retained.update(20, sourceRef, state => state), /no longer active/);
    assert.throws(() => retained.tryConsume(20, sourceRef, state => state), /no longer active/);
});

test("effect sources: receiver callbacks see completed bindings while retained source values keep their original facts", () => {
    const resources = new CombatResources();
    const receiver = receiverEffect(resources, "binding-visibility");
    const snapshots = [];
    const observations = [];
    let selectedSource;
    let derivedSource;
    const { source, program } = sourceProgram(resources, receiver, {
        selectInitial: () => [3, 1, 2],
        selectCurrent: ({ source: current }) => {
            selectedSource = current;
            return [1, 2, 3];
        },
        install: ({ source: current, receiver: target }) => {
            snapshots.push(current);
            observations.push(current.effectSource.receivers.map(binding => ({ ...binding })));
            if (target.id === 2) {
                derivedSource = resources.effectSources.update(current, program.ref, { remaining: 1 });
            }
            return effectSourceInstallation(receiver.ref, { expiresAtTick: null });
        },
    });
    const initial = fixtureWork(source, [unit(3), unit(1), unit(2)]);
    const work = reconcileEffectSources(initial, resources, 0);
    const completed = getCombatMechanism(work, 20);

    assert.deepEqual(completed.effectSource.receivers.map(binding => binding.unitId), [1, 2, 3]);
    assert.deepEqual(observations.map(bindings => bindings.map(binding => binding.installationAttempts)), [
        [0, 0, 0], [1, 0, 0], [1, 1, 0],
    ]);
    assert.deepEqual(observations.map(bindings => bindings.map(binding => binding.address)), [
        [null, null, null],
        [{ unitId: 1, instanceId: 0 }, null, null],
        [{ unitId: 1, instanceId: 0 }, { unitId: 2, instanceId: 0 }, null],
    ]);
    assert.deepEqual(snapshots.map(current => current.effectSource.receivers), observations);
    assert.deepEqual(selectedSource.effectSource.receivers.map(binding => binding.installationAttempts), [0, 0, 0]);
    assert.deepEqual(derivedSource.effectSource.receivers, observations[1]);
    assert.equal(derivedSource.effectSource.state.remaining, 1);
    assert.equal(completed.effectSource.state.remaining, 3);
    assert.deepEqual(getCombatMechanism(initial, 20).effectSource.receivers, []);
    assert.equal(Object.isFrozen(completed.effectSource), true);
    assert.equal(Object.isFrozen(completed.effectSource.receivers), true);
    assert.equal(completed.effectSource.receivers.every(binding => Object.isFrozen(binding) && Object.isFrozen(binding.address)), true);
    assert.equal(Object.values(Object.getOwnPropertyDescriptors(completed.effectSource)).every(descriptor => "value" in descriptor), true);
});

test("effect sources: finish callbacks observe the current cleared prefix and output keeps ordinary data", () => {
    const resources = new CombatResources();
    const receiver = receiverEffect(resources, "finish-visibility");
    const snapshots = [];
    const { source } = sourceProgram(resources, receiver, {
        keepOnFinish: ({ source: current }) => { snapshots.push(current); return false; },
    });
    const installed = reconcileEffectSources(fixtureWork(source), resources, 0);
    const work = finishEffectSource(installed, 20, resources, 1);
    const completed = getCombatMechanism(work, 20);

    assert.deepEqual(snapshots.map(current => current.effectSource.receivers.map(binding => binding.address)), [
        [{ unitId: 1, instanceId: 0 }, { unitId: 2, instanceId: 0 }],
        [null, { unitId: 2, instanceId: 0 }],
    ]);
    assert.equal(snapshots.every(current => current.effectSource.finished && !current.active), true);
    assert.deepEqual(completed.effectSource.receivers.map(binding => binding.address), [null, null]);
    assert.deepEqual(getCombatMechanism(installed, 20).effectSource.receivers.map(binding => binding.address), [
        { unitId: 1, instanceId: 0 }, { unitId: 2, instanceId: 0 },
    ]);
    assert.equal(Object.values(Object.getOwnPropertyDescriptors(completed.effectSource)).every(descriptor => "value" in descriptor), true);
});

test("effect sources: clearing many absent receivers preserves the input branch and binding histories", () => {
    const resources = new CombatResources();
    const receiver = receiverEffect(resources, "absent-bindings");
    const { source } = sourceProgram(resources, receiver, { selectCurrent: () => [] });
    const registered = {
        ...source,
        effectSource: copyEffectSourceState({
            ...source.effectSource,
            initialized: true,
            receivers: Array.from({ length: 512 }, (_, unitId) => ({
                unitId,
                address: { unitId, instanceId: unitId + 10 },
                installationAttempts: 2,
            })),
        }),
    };
    const initial = fixtureWork(registered, []);
    const observed = observeMechanismCopies(initial, () => reconcileEffectSources(initial, resources, 0));
    const work = observed.result;
    const completed = getCombatMechanism(work, 20);

    assert.equal(observed.copies, 1);
    assert.equal(completed.effectSource.receivers.length, 512);
    assert.equal(completed.effectSource.receivers.every(binding => binding.address === null && binding.installationAttempts === 2), true);
    assert.deepEqual(getCombatMechanism(initial, 20).effectSource.receivers, registered.effectSource.receivers);
    assert.equal(registered.effectSource.receivers.every(binding => binding.address !== null), true);
    assert.equal(reconcileEffectSources(work, resources, 1), work);
});

test("effect sources: preserved binding order is unchanged until a new receiver joins", () => {
    const resources = new CombatResources();
    const receiver = receiverEffect(resources, "existing-binding-order");
    const installedOrder = [];
    const { source } = sourceProgram(resources, receiver, {
        install: ({ receiver: target }) => {
            installedOrder.push(target.id);
            return effectSourceInstallation(receiver.ref, { expiresAtTick: null });
        },
    });
    const registered = {
        ...source,
        effectSource: copyEffectSourceState({
            ...source.effectSource,
            initialized: true,
            receivers: [3, 1, 2].map(unitId => ({ unitId, address: null, installationAttempts: 0 })),
        }),
    };
    let work = reconcileEffectSources(fixtureWork(registered, [unit(3), unit(1), unit(2)]), resources, 0);

    assert.deepEqual(installedOrder, [3, 1, 2]);
    assert.deepEqual(getCombatMechanism(work, 20).effectSource.receivers.map(binding => binding.unitId), [3, 1, 2]);
    work = registerCombatUnit(work, unit(0));
    work = registerEffectSourceUnits(work, [0], resources, 1);

    assert.deepEqual(getCombatMechanism(work, 20).effectSource.receivers.map(binding => binding.unitId), [0, 1, 2, 3]);
    assert.deepEqual(installedOrder, [3, 1, 2, 0]);
});

test("effect sources: flushes publish attempts before lifecycle work and preserve nested facts on retry", () => {
    const resources = new CombatResources();
    const fault = { enabled: true };
    const borrowed = [];
    const prefixes = [];
    const published = [];
    let readMechanisms;
    const marker = receiverEffect(resources, "nested-buffer-marker", {
        lifecycle: {
            start: context => {
                context.effects.update(context.address, marker.ref, state => ({ ...state, addition: 77 }));
            },
        },
    });
    const receiver = receiverEffect(resources, "buffered-installation", {
        lifecycle: {
            start: context => {
                borrowed.push(context);
                const nested = context.effects.install(3, marker.ref, {
                    source: null,
                    scope: null,
                    expiresAtTick: null,
                });
                assert.equal(nested.type, "INSTALLED");
                assert.equal(context.facts.getEffect(nested.address).state.addition, 77);
                context.effects.update(context.address, receiver.ref, state => ({ ...state, nested: nested.address }));
                if (fault.enabled && context.address.unitId === 2) {
                    throw new Error("buffered source install failed");
                }
            },
        },
    });
    const { source } = sourceProgram(resources, receiver, {
        selectInitial: () => [1, 2],
        install: ({ source: current }) => {
            prefixes.push(current);
            return effectSourceInstallation(receiver.ref, { expiresAtTick: null });
        },
    });
    const initial = fixtureWork(source, [unit(1), unit(2), unit(3)]);
    const services = {
        ...resources,
        effectLifecycle: {
            get: instance => {
                const lifecycle = resources.effectLifecycle.get(instance);
                if (instance.programRef === receiver.ref) {
                    return {
                        ...lifecycle,
                        start: context => {
                            const current = getCombatMechanism({ ...initial, mechanisms: readMechanisms() }, 20);
                            published.push(current);
                            assert.equal(current.effectSource.initialized, true);
                            assert.equal(current.effectSource.receivers.find(binding => binding.unitId === context.address.unitId).installationAttempts, 1);
                            if (context.address.unitId === 2) {
                                assert.deepEqual(current.effectSource.receivers[0].address, { unitId: 1, instanceId: 0 });
                            }
                            lifecycle.start(context);
                        },
                    };
                }

                return lifecycle;
            },
        },
    };
    const failed = observeMechanismCopies(initial, read => {
        readMechanisms = read;
        assert.throws(() => reconcileEffectSources(initial, services, 0), /buffered source install failed/);
    });
    assert.equal(failed.copies, 2);
    assert.equal(getCombatMechanism(initial, 20), source);
    assert.equal(source.effectSource.initialized, false);
    assert.deepEqual(source.effectSource.receivers, []);
    assert.equal(initial.units.size, 0);
    assert.equal(getCombatUnit(initial, 3).effects, undefined);
    for (const context of borrowed) {
        assert.throws(() => context.effects.update(context.address, receiver.ref, state => state), /no longer active/);
    }

    fault.enabled = false;
    const retry = observeMechanismCopies(initial, read => {
        readMechanisms = read;
        return reconcileEffectSources(initial, services, 0);
    });
    const ordinary = observeMechanismCopies(initial, read => {
        readMechanisms = read;
        return reconcileEffectSources(initial, services, 0);
    });
    assert.equal(retry.copies, 3);
    assert.equal(ordinary.copies, 3);
    assert.deepEqual(combatWorkChanges(retry.result), combatWorkChanges(ordinary.result));
    assert.deepEqual(getCombatUnit(retry.result, 3).effects.instances.map(instance => [instance.id, instance.state.addition]), [[0, 77], [1, 77]]);
    assert.deepEqual([1, 2].map(id => getCombatUnit(retry.result, id).effects.instances[0].state.nested), [
        { unitId: 3, instanceId: 0 }, { unitId: 3, instanceId: 1 },
    ]);
    assert.deepEqual(prefixes.map(current => current.effectSource.receivers.map(binding => binding.installationAttempts)), [
        [0, 0], [1, 0], [0, 0], [1, 0], [0, 0], [1, 0],
    ]);
    assert.deepEqual(published.map(current => current.effectSource.receivers.map(binding => binding.installationAttempts)), [
        [1, 0], [1, 1], [1, 0], [1, 1], [1, 0], [1, 1],
    ]);
});
