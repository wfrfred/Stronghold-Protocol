import type { Ref } from "../../../../common/ref.js";
import type { Unit } from "../../unit.js";
import type { Vitality } from "./capability.js";

export interface Control {
    readonly stopDispatch?: boolean;
}

export interface Context<R> {
    readonly host: Ref<Unit & Vitality>;
    readonly request: R;
}
