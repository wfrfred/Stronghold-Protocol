import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initialize } from "../helpers/unit.js";
import * as units from "../../dist/core/tactical/unit/query.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { ref } from "../../dist/core/tactical/unit/effect/effect.js";
import { effectFixtureWork } from "../helpers/effects.js";

const host = (id) => initialize({
    id,
    position: [0, 0],
    definition: { id: `ref-host-${id}`, vitality: { maxHp: 100, defense: 0, resistance: 0 } },
});

test("Effect references distinguish host-local identities and retrieve current heterogeneous values", () => {
    const shield = { id: "shield", initialize: () => ({ charges: 2 }) };
    const poison = { id: "poison", initialize: () => ({ damage: 10 }) };
    const firstHost = units.ref(host(1));
    let battle = effectFixtureWork(host(1), host(2));
    const first = effects.install(battle, firstHost, shield);
    battle = first.state;
    const secondHost = units.ref(host(2));
    const second = effects.install(battle, secondHost, poison);
    battle = second.state;
    const firstRef = first.value;
    const secondRef = second.value;
    const previous = battle;
    const original = effects.get(battle, firstRef);

    assert.equal(firstRef.id, secondRef.id);
    assert.notEqual(firstRef.host.id, secondRef.host.id);
    assert.equal(original.host, firstHost);
    assert.equal(firstRef.host, firstHost);
    assert.deepEqual(ref(original), firstRef);
    assert.deepEqual(Object.keys(firstRef).sort(), ["host", "id"]);
    assert.equal(effects.get(battle, secondRef).definition, poison);

    battle = effects.update(battle, firstRef, data => ({ ...data, charges: 1 }));

    assert.equal(effects.get(battle, firstRef).data.charges, 1);
    assert.equal(effects.get(previous, firstRef).data.charges, 2);
    assert.equal(effects.get(battle, secondRef), effects.get(previous, secondRef));
    assert.equal(units.get(battle, firstRef.host).effects.get(firstRef.id), effects.get(battle, firstRef));

    battle = effects.end(battle, firstRef);

    assert.equal(effects.get(battle, firstRef), undefined);
    assert.equal(effects.get(battle, secondRef).data.damage, 10);
});

test("Effect writes preserve both the host and local instance identity", () => {
    const content = { id: "identity", initialize: () => ({ charges: 2 }) };
    const installed = effects.install(effectFixtureWork(host(1), host(2)), units.ref(host(1)), content);
    const self = effects.get(installed.state, installed.value);
    const moved = { ...self, host: units.ref(host(2)) };

    const container = units.get(installed.state, self.host).effects;
    assert.throws(() => container.replace(installed.value, moved), TypeError);
    assert.equal(effects.get(installed.state, installed.value), self);
    const replaced = effects.update(installed.state, installed.value, data => ({ ...data, charges: 1 }));
    const changed = effects.get(replaced, installed.value);
    assert.equal(changed.host, self.host);
    assert.equal(changed.id, self.id);
    assert.equal(changed.definition, self.definition);
    assert.equal(changed.data.charges, 1);
});

test("Unified Effect references retain data and host types through queries and reject invalid writes", async () => {
    const { default: ts } = await import("typescript");
    const directory = mkdtempSync(join(tmpdir(), "stronghold-typed-effect-refs-"));
    const source = (name) => JSON.stringify(fileURLToPath(
        new URL(`../../src/core/${name}.js`, import.meta.url),
    ));
    const path = join(directory, "contract.mts");
    writeFileSync(path, `
import type { Identity, Ref } from ${source("common/ref")};
import type { State as BattleState } from ${source("tactical/battle/state")};
import type { Unit } from ${source("tactical/unit/unit")};
import * as units from ${source("tactical/unit/query")};
import type { Vitality } from ${source("tactical/unit/capability/vitality/capability")};
import type { Locomotion } from ${source("tactical/unit/capability/locomotion/capability")};
import type { Effect, View, Lifetime } from ${source("tactical/unit/effect/effect")};
import { ref } from ${source("tactical/unit/effect/effect")};
import type { Definition } from ${source("tactical/unit/effect/definition")};
import * as effects from ${source("tactical/unit/effect/operations")};

declare const battle: BattleState;
declare const host: Ref<Unit & Vitality & Locomotion>;
declare const shield: Effect<{ charges: number }, Vitality>;
declare const poison: Effect<{ damage: number }, Vitality>;
const definition: Definition<{ charges: number }, Vitality> = {
    id: "shield", initialize: () => ({ charges: 2 }),
};
const installed = effects.install(battle, host, definition);
const installedRef: Ref<Effect<{ charges: number }, Vitality>> | undefined = installed.value;
const known = ref(shield);
const retained: Ref<Effect<{ charges: number }, Vitality>> = known;
const identity: Identity<Effect<{ charges: number }, Vitality>> = {
    host: shield.host, id: shield.id,
};
const owner: Ref<Unit & Vitality> = retained.host;
const weakerOwner: Ref<Unit> = owner;
const unitLifetime: Lifetime = { type: "UNIT", ref: host };
effects.bindLifetime(battle, retained, unitLifetime);
// @ts-expect-error Unit lifetimes require a typed reference rather than a bare Unit ID.
const bareUnitLifetime: Lifetime = { type: "UNIT", unitId: host.id };
// @ts-expect-error an untyped ID address does not prove a Unit reference.
const untypedUnitLifetime: Lifetime = { type: "UNIT", ref: { id: host.id } };

function relay(reference: Ref<Effect<{ charges: number }, Vitality>>) {
    return effects.get(battle, reference);
}
const restored: Effect<{ charges: number }, Vitality> | undefined = relay(retained);
if (restored !== undefined) {
    const charges: number = restored.data.charges;
    const vitalityHost: (Unit & Vitality) | undefined = units.get(battle, restored.host);
    effects.update(battle, retained, data => ({ ...data, charges: 1 }));
    // @ts-expect-error a precise reference fixes the private data returned by its transform.
    effects.update(battle, retained, () => poison.data);
    // @ts-expect-error a private-state transform retains the known field types.
    effects.update(battle, retained, data => ({ ...data, charges: "one" }));
}
const publicRef: Ref<View> = retained;
// @ts-expect-error public identities do not prove a private data type.
effects.update(battle, publicRef, data => data);
// @ts-expect-error update requires a transform rather than a data snapshot.
effects.update(battle, retained, { charges: 1 });
// @ts-expect-error an identity address is not evidence of a referent type.
const forged: Ref<Effect<{ charges: number }, Vitality>> = identity;
// @ts-expect-error a raw address cannot recover Effect private state.
effects.get(battle, { host: owner, id: shield.id });
// @ts-expect-error Unit references cannot identify Effects.
effects.get(battle, host);
// @ts-expect-error Effect references cannot identify Units.
units.get(battle, retained);
// @ts-expect-error a weaker host reference does not prove a capability.
const strongerOwner: Ref<Unit & Vitality> = weakerOwner;
// @ts-expect-error readonly identity fields cannot be retargeted.
retained.host = host;
// @ts-expect-error readonly identity fields cannot be retargeted.
retained.id = 2;
// @ts-expect-error Definition selection is unnecessary for a typed reference query.
effects.get(battle, retained, definition);
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
