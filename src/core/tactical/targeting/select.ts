import type { Unit, UnitId } from "../unit/unit.js";
import type { CompiledTargeting, TargetQueryContext } from "./query.js";

type Comparator = (left: Unit, right: Unit) => number;

function* acceptedTargets<C extends TargetQueryContext>(
    context: C,
    targeting: CompiledTargeting<C>,
): Iterable<Unit> {
    const visited = new Set<UnitId>();

    for (const id of targeting.candidates(context)) {
        if (visited.has(id)) {
            continue;
        }

        visited.add(id);
        const unit = context.battlefield.getUnit(id);

        if (unit !== undefined && targeting.accepts(context, unit)) {
            yield unit;
        }
    }
}

function siftUp(heap: Unit[], compare: Comparator): void {
    let index = heap.length - 1;

    while (index > 0) {
        const parent = Math.floor((index - 1) / 2);

        if (compare(heap[index]!, heap[parent]!) <= 0) {
            break;
        }

        [heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
        index = parent;
    }
}

function siftDown(heap: Unit[], compare: Comparator): void {
    let index = 0;

    while (index * 2 + 1 < heap.length) {
        const left = index * 2 + 1;
        const right = left + 1;
        let worst = left;

        if (right < heap.length && compare(heap[right]!, heap[left]!) > 0) {
            worst = right;
        }
        if (compare(heap[index]!, heap[worst]!) >= 0) {
            break;
        }

        [heap[index], heap[worst]] = [heap[worst]!, heap[index]!];
        index = worst;
    }
}

export function selectTargets<C extends TargetQueryContext>(
    context: C,
    targeting: CompiledTargeting<C>,
): readonly Unit[] {
    const limit = targeting.limit(context);

    if (limit <= 0) {
        return [];
    }

    const compare: Comparator = (left, right) => {
        const order = targeting.compare(context, left, right);

        return order === 0 ? left.id - right.id : order;
    };

    if (limit === 1) {
        let selected: Unit | null = null;

        for (const target of acceptedTargets(context, targeting)) {
            if (selected === null || compare(target, selected) < 0) {
                selected = target;
            }
        }

        return selected === null ? [] : [selected];
    }

    const selected: Unit[] = [];

    for (const target of acceptedTargets(context, targeting)) {
        if (selected.length < limit) {
            selected.push(target);
            siftUp(selected, compare);
        } else if (compare(target, selected[0]!) < 0) {
            selected[0] = target;
            siftDown(selected, compare);
        }
    }

    return selected.sort(compare);
}
