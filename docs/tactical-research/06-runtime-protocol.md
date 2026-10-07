# Tactical runtime protocol

本文规定当前 Core 的同步交战、Effect 生命周期及调用期可见性。它描述项目已实现的有限协议，不把当前阶段顺序推广为官方所有攻击、回复和死亡路径。

## 1. 事实、资源与执行作用域

| 内容 | 归属 |
| --- | --- |
| Unit、HP、Effect 身份与状态、父关系、领域贡献、身份分配进度 | 权威运行事实；完成的 transition 立即成为当前工作状态 |
| EffectProgram、领域 hook、贡献求值函数及注册表 | 可重建 Resources；不捕获上一次的 HP、位置或实例状态 |
| 活跃事件的候选身份、已进入 callback 的实例暂存 | 同步执行 scope；正常／异常退出都释放，不进入 snapshot |

[CombatWork](../../src/core/tactical/battle/execution/work.ts) 组织当前交战事实与结果；[EffectDispatchScope](../../src/core/tactical/unit/capability/effects/dispatch.ts) 组织调用期范围。两者不代替 Blocking 等领域已经选择的阶段基线。

## 2. 内容的组合登记

[CombatResources.registerEffect](../../src/core/tactical/battle/resources.ts) 接收领域 facets：

```typescript
resources.registerEffect(program, {
    contributions,
    bindings,
    damage,
    healing,
    lifecycle,
});
```

所有字段都可省略。`resources.registerEffect(program)` 合法：实例可以没有贡献、接收 hook 或生命周期动作；领域登记缺席表示没有该领域行为。

这是组合层向各领域登记的入口。[EffectProgram](../../src/core/tactical/unit/capability/effects/program.ts) 仅定义程序身份、状态初始化及状态取得所有权，不追加一套包办所有 subsystem 的行为槽位。Damage、Healing、Status 等继续拥有自身契约；同一实例可以同时具有多个 facet。

## 3. Effect 生命周期与父关系

[公开生命周期操作](../../src/core/tactical/unit/capability/effects/lifecycle.ts) 统一维护实例及领域 bindings。内容程序只获得明确的 [Effect operations](../../src/core/tactical/unit/capability/effects/contract.ts)，不能直接增删实例数组。Status 通过 [自身 binding](../../src/core/tactical/unit/capability/status/binding.ts) 接入。

| 转换 | 完成后的事实 |
| --- | --- |
| 安装 | 先清理接收者的 finished 实例；登记新身份，执行 start，再安装 bindings、判断 admission、开始参与 |
| 当前参与变化 | 实例参与事实和领域 bindings 同步变化；停止参与保留载荷，恢复不自动重新采样 |
| 状态更新 | 实例载荷及已安装的领域投影同步更新 |
| finish | 停止参与，执行相应 disable，标记 finished，并同步向精确父身份的子实例传播 |
| finalize | 先移除登记身份，再执行结束动作并清理 bindings；子实例由自身接收者独立清理 |

自动安装在清理连锁完成后读取最新身份计数器，避免 ON_FINISH 嵌套安装后复用 ID。安装拒绝是正常结果，保留已完成的 start 前缀和身份进度。

父身份是 `{ unitId, instanceId }`，独立于来源和 lifetime owner。`attachEffectParent()` 返回 `{ work, result }`；内容操作 `effects.attachParent()` 提交同一工作变化并返回 `result`：

| result.type | 含义 |
| --- | --- |
| `BOUND` | 已建立请求中的活父绑定，或本来已绑定同一活父 |
| `CHILD_ABSENT` | 子实例未登记 |
| `CHILD_FINISHED` | 子实例已经结束 |
| `PARENT_UNAVAILABLE` | 父实例缺席或已结束；`reason` 为 `ABSENT`／`FINISHED` |

`finishIfParentFinished` 默认 `true`：父缺席和父已结束都通过统一 finish 操作结束子实例，不伪造父绑定，不隐式 finalize。显式传 `false` 时返回拒绝且不改变子实例。活父重绑与环关系属于非法图，仍抛异常。

## 4. 候选范围与已进入程序

每个接收 Unit 在一个活跃领域事件内捕获全部登记身份，包含当前非参与的实例。同接收者的嵌套事件和参与查询复用该范围；另一个没有活跃事件的接收者从自己的当前登记建立范围。事件完全退出后，后续事件重新建立范围，不冻结整次 Damage 或整个 tick。

候选轮到前重新读取当前实例、参与事实和领域资格。新实例按 UID 立即可见，但不进入旧范围；旧停用候选恢复后可以参与。候选身份冻结，HP、载荷及有效参数仍按对应查询契约读取。

领域事件结束后清理接收者的 finished 实例。嵌套 cleanup 可以先于外层事件结束，运行结束动作并安装新实例；它不会重建尚活跃的外层候选。

已经进入的 callback 不因实例 finish／finalize 自动中断。finalize 删除 UID 前向活跃 invocation 保存该实例最后事实，callback 后继可以读取最后载荷；UID 和参与查询已经看不到该登记。这个暂存退出 callback 即清除，不延迟 cleanup，也不进入 Resources 或 snapshot。

## 5. 领域排序、取消与嵌套

Damage／Healing 拥有自己的排序与结算流程。一个事件内部按 priority 降序、获得次序升序、instance ID 升序执行；逐候选资格 live。priority 不用于跨 Unit 合并排序。

| 确认报告后的反应 | Unit 顺序 |
| --- | --- |
| Damage | 来源，再目标 |
| Healing | 目标，再来源 |

来源为空时跳过；来源和目标为同一 Unit 时只执行一次该报告反应。每个 Unit 内独立按该领域事件 priority 排序。以上是当前项目合同，不是对所有官方后置通知顺序的兼容声明。

领域 cancellation 与 `stopDispatch` 独立。取消 HP 应用不自动停止已进入派发的剩余候选，不回滚实例消耗、嵌套回复或允许的内容后继；只有明确 `stopDispatch` 停止该事件的后续候选。

[Hook context](../../src/core/tactical/unit/capability/vitality/hook.ts) 只暴露阶段事实及明确注入的 Effect／Damage／Healing operation，不暴露 Work、全量 Resources 或任意 Battlefield mutation。公式阶段只提供 Effect 操作。嵌套领域操作完整结算后返回本次报告，后继读取最新工作事实；本次报告不汇总嵌套操作的净 HP 变化。

## 6. Core 接收政策与原始数据适配

Core 的伤害类别与接收政策独立。`TRUE` 不自动跳过 Modifier 事件；Damage 的 `skipModifierEvents` 与 `considerInvincibility` 是独立输入。

Core Healing 的两个输入也独立：

| 输入 | 控制内容 |
| --- | --- |
| `ignoreHealFree` | 是否绕过接收时的 HEAL_FREE 判定 |
| `skipModifierEvents` | 是否跳过普通输出／接收／报告反应，改用独立 `skippedReception` |

因此直接 Core 调用的 `skipModifierEvents: true` 不隐含 `ignoreHealFree: true`。接收许可在该请求的 admission 时判断；随后 hook 改变 HEAL_FREE 不追溯撤销已经接纳的回复，新的请求重新判断。

[readArknightsHealingRequest](../../src/data/arknights/healing.ts) 只适配原生 `Torappu.Battle.Action.Nodes+HealViaMaxHpRatio` 的两个布尔字段。调用者已经解析来源／目标并结算 `power`；适配器不解释黑板比例、目标描述或完整动作程序。其映射为：

```typescript
ignoreHealFree = raw._ignoreHealFree || raw._skipModifierEvent;
skipModifierEvents = raw._skipModifierEvent;
```

这个原始数据映射表达该原生动作的 skip 接收绕过普通 HEAL_FREE 判断，不把两种 Core 输入合并，也不宣布其他原生回复动作采用同一描述格式。

## 7. 异常与权威发布

正常拒绝、领域取消和零 HP 变化都是可提交结果。只有未处理异常或明确 tick abort 才放弃本 tick 工作事实；权威 Battlefield 在整 tick 成功后发布。

候选范围和活跃实例暂存在 `finally` 中释放。异常后的新事件必须重新建立身份范围；不得把失败调用的候选、HP、实例载荷、身份进度或公开事件留入下一次权威结果。

## 8. 验收范围

[派发回归](../../test/sim/effect-dispatch.test.js)、[生命周期回归](../../test/sim/effects.test.js) 和 [贡献回归](../../test/sim/contributions.test.js) 验证上述协议。共享 [Effect fixture](../../test/helpers/effects.js) 使用统一安装入口；手工 Unit fixture 先通过 [initializeUnit](../../src/core/tactical/unit/initialize.ts) 建立能力事实，再通过合法 transition 调整测试输入，不手造过时 capability state。

从空构建产物验收，避免已删除模块的残留 JS 使测试假通过：

```sh
rm -rf dist
npm run build:ts
npm run check
node --test --test-isolation=none \
    test/content/tokens_devices.test.js \
    test/render/interp.test.js \
    test/sim/battle.test.js \
    test/sim/combat-program.test.js \
    test/sim/combat-work.test.js \
    test/sim/combat.test.js \
    test/sim/contributions.test.js \
    test/sim/core.test.js \
    test/sim/damage-pipeline.test.js \
    test/sim/effect-dispatch.test.js \
    test/sim/effects.test.js \
    test/sim/facing.test.js \
    test/sim/feedback1b-displacement.test.js \
    test/sim/pathing-crosscheck.test.js \
    test/sim/pathing.test.js \
    test/sim/playtest5_blocking.test.js
```

该命令只包含已接入 TypeScript 的 legacy 相关测试；统计不混入全仓库其他测试。
