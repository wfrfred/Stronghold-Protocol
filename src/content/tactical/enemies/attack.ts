import type { CompiledAction } from "../../../core/tactical/unit/capability/action/compiled.js";
import type { CompiledActionSegment } from "../../../core/tactical/unit/capability/action/process.js";
import type { AttackTiming } from "./ground.js";

export function withTiming(
    action: CompiledAction,
    timing: AttackTiming,
    attackProgram: readonly CompiledActionSegment[],
): CompiledAction {
    const { windupTicks, recoveryTicks } = timing;
    const program: CompiledActionSegment[] = [];

    if (windupTicks > 0) {
        program.push({
            type: "WAIT",
            blockingMovement: true,
            allowNewAction: false,
            resolve: () => ({ type: "FOR_TICKS", ticks: windupTicks }),
        });
    }

    program.push({ type: "RELEASE", markerId: "normal-attack" });
    program.push(...attackProgram);

    if (recoveryTicks > 0) {
        program.push({
            type: "WAIT",
            blockingMovement: true,
            allowNewAction: false,
            resolve: () => ({ type: "FOR_TICKS", ticks: recoveryTicks }),
        });
    }

    return { ...action, program };
}
