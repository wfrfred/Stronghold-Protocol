import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("direct Effect definitions type host capabilities, private state and immutable outputs", async () => {
    const { default: ts } = await import("typescript");
    const directory = mkdtempSync(join(tmpdir(), "stronghold-effect-types-"));
    const module = (name) =>
        JSON.stringify(
            fileURLToPath(new URL(`../../src/core/tactical/${name}.js`, import.meta.url)),
        );
    const path = join(directory, "contract.mts");
    writeFileSync(
        path,
        `
import { initializeUnit } from ${module("unit/initialize")};
import type { Unit } from ${module("unit/unit")};
import type { BattleState } from ${module("battle/execution/context")};
import type { Vitality, VitalityState } from ${module("unit/capability/vitality/capability")};
import { setMaxHpContribution } from ${module("unit/capability/vitality/capability")};
import { setAttackContribution } from ${module("unit/capability/offense/capability")};
import { setCapacityContribution } from ${module("unit/capability/blocking/capability")};
import type { Definition } from ${module("unit/effect/definition")};
import { install, setState } from ${module("unit/effect/operations")};
import { find } from ${module("unit/effect/query")};
import type { Contribution, Input } from ${module("unit/contribution/contribution")};
import type { QueryContext } from ${module("unit/query")};
const host=initializeUnit({id:1,position:[0,0],definition:{id:'host',vitality:{maxHp:100}}});
const content: Definition<{charges:number},Vitality> = {
 id:'shield',initialize:()=>({charges:2}),
 onTick(context) {
   const hp:number=context.unit.vitality.hp;
   context.setState(current=>({charges:current.charges-1}));
   // @ts-expect-error private state remains specific to this definition.
   context.setState({missing:1});
   // @ts-expect-error stored values are readonly.
   context.self.status='ENDING';
   // @ts-expect-error shared host state must use immutable transitions.
   context.unit.vitality.hp=hp;
 }
};
declare const battle:BattleState;
const ref=install(battle,host,content);
const bare=initializeUnit({id:2,position:[0,0],definition:{id:'bare'}});
// @ts-expect-error required host capabilities must be present.
install(battle,bare,content);
if(ref!==undefined) {
 setState(battle,ref,content,{charges:5});
 // @ts-expect-error state transitions preserve Definition's state type.
 setState(battle,ref,content,{charges:'five'});
 const found=find(host,content,ref.effectId);
 if(found!==undefined){const charges:number=found.state.charges;}
}
declare const capabilityHost:Unit & Vitality & {readonly tag:'kept';readonly vitality:VitalityState & {readonly hp:100}};
const fixed:Contribution={id:'fixed',value:[]};
const dynamic:Contribution<Input<QueryContext>>={id:'dynamic',value:()=>[]};
const changed=setMaxHpContribution(capabilityHost,fixed);
const retained:'kept'=changed.tag;
const hp:number=changed.vitality.hp;
// @ts-expect-error state setters widen changed values.
const staleHp:100=changed.vitality.hp;
setAttackContribution(capabilityHost,dynamic);
// @ts-expect-error MaxHP cannot coordinate HP from a query-time closure.
setMaxHpContribution(capabilityHost,dynamic);
// @ts-expect-error blocking capacity requires settled static values.
setCapacityContribution(capabilityHost,dynamic);
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
