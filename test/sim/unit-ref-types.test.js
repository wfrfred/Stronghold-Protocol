import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Unit Refs preserve guard proofs, permit covariance and reject forged or stronger identities", async () => {
    const { default: ts } = await import("typescript");
    const directory = mkdtempSync(join(tmpdir(), "stronghold-unit-ref-types-"));
    const source = name => JSON.stringify(fileURLToPath(new URL(`../../src/core/tactical/${name}.js`, import.meta.url)));
    const path = join(directory, "refs.mts");
    try {
        writeFileSync(path, `
import type { Unit, Ref } from ${source("unit/unit")};
import type { State as BattleState } from ${source("battle/state")};
import * as units from ${source("unit/query")};
import { hasLocomotion, type Locomotion } from ${source("unit/capability/locomotion/capability")};
import { hasVitality, type Vitality } from ${source("unit/capability/vitality/capability")};
import { hasSkill, type Skill } from ${source("unit/capability/skill/capability")};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
declare const battle: BattleState;
declare const strong: Ref<Unit & Locomotion & Vitality>;
declare const moving: Ref<Unit & Locomotion>;
declare const known: Unit & Locomotion & Vitality;
const weaker: Ref<Unit & Locomotion> = strong;
const base: Ref<Unit> = weaker;
// @ts-expect-error A weaker proof cannot satisfy a stronger requirement.
const stronger: Ref<Unit & Locomotion & Vitality> = moving;
// @ts-expect-error Unit identities require a query-generated proof.
const forged: Ref<Unit & Locomotion> = { id: 1 };
// @ts-expect-error Ref identities are immutable.
weaker.id = 2;
// @ts-expect-error A bare ID is not a typed Unit identity.
units.get(battle, 1);
// @ts-expect-error A known Unit is not itself a Ref.
units.get(battle, known);
// @ts-expect-error Ref construction requires a known Unit, not a bare ID.
units.ref(1);
const preserved = units.ref(known);
type Preserved = Assert<Equal<typeof preserved, Ref<Unit & Locomotion & Vitality>>>;
const current = units.get(battle, strong);
type Current = Assert<Equal<typeof current, (Unit & Locomotion & Vitality) | undefined>>;
const locomotives = units.filter(battle, hasLocomotion);
type Locomotives = Assert<Equal<typeof locomotives, Ref<Unit & Locomotion>[]>>;
const skills = units.filter(battle, hasSkill);
type Skills = Assert<Equal<typeof skills, Ref<Unit & Skill>[]>>;
const both = units.filter(battle, (unit): unit is Unit & Locomotion & Vitality =>
    hasLocomotion(unit) && hasVitality(unit));
type Both = Assert<Equal<typeof both, Ref<Unit & Locomotion & Vitality>[]>>;
// @ts-expect-error An ordinary condition does not prove a Unit structure.
units.filter(battle, unit => unit.id > 0);
`);
        const program = ts.createProgram([path], {
            noEmit: true, strict: true, exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true, target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
            skipLibCheck: true, types: [],
        });
        assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic =>
            ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), []);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
