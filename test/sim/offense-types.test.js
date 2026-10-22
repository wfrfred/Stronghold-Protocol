import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Offense queries require capability-preserving identities and expose typed dynamic owners", async () => {
    const { default: ts } = await import("typescript");
    const directory = mkdtempSync(join(tmpdir(), "stronghold-offense-types-"));
    const source = name => JSON.stringify(fileURLToPath(new URL(`../../src/core/tactical/${name}.js`, import.meta.url)));
    const path = join(directory, "offense.mts");

    try {
        writeFileSync(path, `
import type { Ref } from ${source("../common/ref")};
import type { State as BattleState } from ${source("battle/state")};
import type { Unit } from ${source("unit/unit")};
import type { Vitality } from ${source("unit/capability/vitality/capability")};
import { hasOffense, initialize, setAttackContribution, type Input, type Offense, type State } from ${source("unit/capability/offense/capability")};
import { resolveAttack } from ${source("unit/capability/offense/query")};
import * as units from ${source("unit/query")};
import * as attribute from ${source("unit/contribution/attribute")};

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
declare const battle: BattleState;
declare const unit: Unit;
declare const state: State;
declare const weak: Ref<Unit>;
declare const strong: Ref<Unit & Offense & Vitality>;
const compatible: Ref<Unit & Offense> = strong;
const amount = resolveAttack(battle, compatible);
type Amount = Assert<Equal<typeof amount, number | undefined>>;
if (hasOffense(unit)) {
    resolveAttack(battle, units.ref(unit));
}
// @ts-expect-error The caller must preserve the Offense capability proof.
resolveAttack(battle, weak);
// @ts-expect-error A numeric identity is not an Offense Ref.
resolveAttack(battle, 1);
// @ts-expect-error Plain objects cannot manufacture typed identities.
resolveAttack(battle, { id: 1 });
// @ts-expect-error A Unit snapshot is not a Ref.
resolveAttack(battle, unit);

const dynamic: Input = (current, self) => {
    type Current = Assert<Equal<typeof current, BattleState>>;
    type Self = Assert<Equal<typeof self, Unit & Offense>>;
    const reference: Ref<Unit & Offense> = units.ref(self);
    const present = units.get(current, reference);
    if (present !== undefined) {
        present.offense.attack;
        present.definition.offense.attack;
    }
    // @ts-expect-error Offense does not imply Vitality.
    self.vitality.hp;
    return [attribute.create({ finalAddition: self.definition.offense.attack })];
};
const staticInput: Input = [attribute.create({ multiplier: 0.5 })] as const;
setAttackContribution(state, { id: "dynamic", value: dynamic });
setAttackContribution(state, { id: "static", value: staticInput });
// @ts-expect-error Contributions no longer receive a unit/query Context wrapper.
const legacy: Input = ({ unit }: { unit: Unit }) => [];
// @ts-expect-error Dynamic inputs return modifiers rather than a BattleState transition.
const operation: Input = (current: BattleState) => current;
initialize(battle, { attack: 1 });
// @ts-expect-error Offense initialization always requires its Definition.
initialize(battle);
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
