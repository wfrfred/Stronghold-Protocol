import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initialize } from "../helpers/unit.js";
import * as units from "../../dist/core/tactical/unit/query.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import {
    getUnit,
    removeUnit,
    updateUnit,
} from "../../dist/core/tactical/battle/state.js";
import { effectFixtureWork } from "../helpers/effects.js";

test("Effect installation resolves its typed host against the latest battle", () => {
    const original = initialize({
        id: 1,
        position: [0, 0],
        definition: { id: "typed-host", vitality: { maxHp: 100, defense: 0, resistance: 0 } },
    });
    const host = units.ref(original);
    const previous = effectFixtureWork(original);
    const current = updateUnit(previous, {
        ...original,
        vitality: { ...original.vitality, hp: 25 },
    });
    let observed;
    const installed = effects.install(current, host, {
        id: "read-current-host",
        initialize: () => ({}),
        onInstall(battle, self) {
            const current = units.get(battle, self.host);
            observed = current.vitality.hp;
            assert.equal(current, units.get(battle, host));
            return battle;
        },
    });

    assert.equal(observed, 25);
    assert.notEqual(installed.value, undefined);
    assert.equal(getUnit(installed.state, host.id).vitality.hp, 25);
    assert.equal(getUnit(previous, host.id), original);
    assert.equal(original.effects.values().toArray().length, 0);
});

test("Effect installation rejects a typed host that has left the battle", () => {
    const original = initialize({
        id: 1,
        position: [0, 0],
        definition: { id: "departed-host", vitality: { maxHp: 100, defense: 0, resistance: 0 } },
    });
    const host = units.ref(original);
    const departed = removeUnit(effectFixtureWork(original), host.id);
    let initialized = false;
    let installed = false;
    const result = effects.install(departed, host, {
        id: "must-not-install",
        initialize() {
            initialized = true;
            return {};
        },
        onInstall(battle) {
            installed = true;
            return battle;
        },
    });

    assert.equal(result.state, departed);
    assert.equal(result.value, undefined);
    assert.equal(initialized, false);
    assert.equal(installed, false);
});

test("Effect typed hosts retain capability requirements and private data inference", async () => {
    const { default: ts } = await import("typescript");
    const directory = mkdtempSync(join(tmpdir(), "stronghold-typed-effect-hosts-"));
    const source = (name) =>
        JSON.stringify(fileURLToPath(new URL(`../../src/core/tactical/${name}.js`, import.meta.url)));
    const path = join(directory, "contract.mts");
    writeFileSync(path, `
import type { State as BattleState } from ${source("battle/state")};
import type { Unit } from ${source("unit/unit")};
import type { Ref } from ${source("../common/ref")};
import { ref, get } from ${source("unit/query")};
import type { Locomotion } from ${source("unit/capability/locomotion/capability")};
import type { Vitality } from ${source("unit/capability/vitality/capability")};
import type { Definition } from ${source("unit/effect/definition")};
import { ref as effectRef, type Effect, type View } from ${source("unit/effect/effect")};
import { Effects } from ${source("unit/effect/effects")};
import { install, update } from ${source("unit/effect/operations")};
declare const battle: BattleState;
declare const complete: Ref<Unit & Locomotion & Vitality>;
declare const movement: Ref<Unit & Locomotion>;
declare const bare: Ref<Unit>;
declare const known: Unit & Vitality;
const vitality: Definition<{ charges: number }, Vitality> = {
    id: "vitality",
    initialize: () => ({ charges: 1 }),
    onInstall(state, self) {
        const current: (Unit & Vitality) | undefined = get(state, self.host);
        const hp: number | undefined = current?.vitality.hp;
        const maxHp: number | undefined = current?.definition.vitality.maxHp;
        const charges: number = self.data.charges;
        return update(state, effectRef(self), data => ({ charges: data.charges + 1 }));
    },
    onEnd(state, self, reason) {
        const typed: Effect<{ charges: number }, Vitality> = self;
        const why: string = reason;
        const current: (Unit & Vitality) | undefined = get(state, self.host);
        return state;
    },
};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type InstallCallback = Assert<Equal<Parameters<NonNullable<Definition<{ charges: number }, Vitality>["onInstall"]>>, [BattleState, Effect<{ charges: number }, Vitality>]>>;
type EnableCallback = Assert<Equal<Parameters<NonNullable<Definition<{ charges: number }, Vitality>["onEnable"]>>, [BattleState, Effect<{ charges: number }, Vitality>]>>;
type DisableCallback = Assert<Equal<Parameters<NonNullable<Definition<{ charges: number }, Vitality>["onDisable"]>>, [BattleState, Effect<{ charges: number }, Vitality>]>>;
type TickCallback = Assert<Equal<Parameters<NonNullable<Definition<{ charges: number }, Vitality>["onTick"]>>, [BattleState, Effect<{ charges: number }, Vitality>]>>;
type TerminalCallback = Assert<Equal<Parameters<NonNullable<Definition<{ charges: number }, Vitality>["onEnd"]>>, [BattleState, Effect<{ charges: number }, Vitality>, string]>>;
const legacy = (_state: BattleState, context: {
    self: Effect<{ charges: number }, Vitality>;
    unit: Unit & Vitality;
    ref: Ref<Effect<{ charges: number }, Vitality>>;
}) => _state;
// @ts-expect-error lifecycle callbacks receive the precise Effect rather than a wrapper.
const invalidWrappedCallback: Definition<{ charges: number }, Vitality> = { ...vitality, onInstall: legacy };
// @ts-expect-error onEnd receives the reason separately rather than inside a wrapper.
const invalidWrappedEnd: Definition<{ charges: number }, Vitality> = { ...vitality, onEnd: legacy };
const combined: Definition<object, Locomotion & Vitality> = {
    id: "combined", initialize: () => ({}),
};
declare const effect: Effect<{ charges: number }, Locomotion & Vitality>;
const reference = effectRef(effect);
const typedHost: Ref<Unit & Locomotion & Vitality> = reference.host;
const generic: Ref<View> = reference;
const entries = Effects.empty().add(effect);
const restored: typeof effect | undefined = entries.get(reference);
entries.replace(reference, { ...effect, data: { charges: 2 } });
update(battle, reference, data => ({ ...data, charges: data.charges + 1 }));
// @ts-expect-error public references do not prove the private data transform type.
update(battle, generic, data => data);
// @ts-expect-error precise data fields retain their type through transforms.
update(battle, reference, data => ({ ...data, charges: "wrong" }));
// @ts-expect-error public effect identity does not retain arbitrary host capabilities.
const inventedHost: Ref<Unit & Vitality> = generic.host;
// @ts-expect-error public effect views hide private data.
entries.get(generic)!.data;
// @ts-expect-error public references do not prove writable private state types.
entries.replace(generic, effect);
// @ts-expect-error a precise reference fixes replacement data inference.
entries.replace(reference, { ...effect, data: { charges: "wrong" } });
install(battle, complete, vitality, { data: { charges: 2 } });
install(battle, complete, combined);
install(battle, ref(known), vitality);
// @ts-expect-error covariance cannot invent the required Vitality capability.
install(battle, movement, vitality);
// @ts-expect-error host requirements cannot be weakened by generic inference.
install(battle, bare, vitality);
// @ts-expect-error a composed host requirement needs both capabilities.
install(battle, movement, combined);
// @ts-expect-error a Unit snapshot is not the installation identity API.
install(battle, known, vitality);
// @ts-expect-error a bare ID cannot claim a typed host capability.
install(battle, { id: known.id }, vitality);
// @ts-expect-error private Effect data remains specific to its Definition.
install(battle, complete, vitality, { data: { charges: "two" } });
`);
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
        assert.deepEqual(ts.getPreEmitDiagnostics(program).map((diagnostic) =>
            ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), []);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
