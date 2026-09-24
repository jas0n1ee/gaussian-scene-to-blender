# Agent 管理网页 Review

本文件只在准备、启动、结束或回填网页人工 Review 时读取。代码在本 Skill 的 `scripts/web-review/`，审阅数据仍留在项目的 `reviews/<基础版本>/`。前端与本机服务共用一个审阅包；所有 CLI 命令都由 Agent 执行，Human 收到 URL 后直接在浏览器审阅。

## 输入与准备

先确认当前累计 `.blend`、完整原始 3DGS、checkpoint、`manifest.json` 和 `alignment.json`。已有 Review 包恢复使用，不清空、不改写既有截图与 Issue。新包的 `assets.B/G` 指向源文件并有哈希，`display_assets.B/G` 指向同版本派生 GLB/RAD。GLB 是只读显示文件，`.blend` 才是修订源；RAD 必须由完整扫描生成。

运行目录为本文件相邻的 `../scripts/web-review`，以下用 `RUNTIME` 代指其绝对路径，用 `MANIFEST` 代指项目审阅包的绝对 `manifest.json` 路径。Agent 在命令中替换这两个值；不要让 Human 输入命令。

若 `display_assets` 尚未就绪，先在独立副本验证导出与完整场景的双视图，再为目标审阅包准备：

```bash
cd "$RUNTIME"
npm ci
./tools/setup-spark-builder.sh                 # 首次需要完整 G 转换器时
node tools/prepare-display.mjs --manifest "$MANIFEST"
```

`prepare-display` 默认使用 macOS `/Applications/Blender.app/Contents/MacOS/Blender`，可用 `--blender` 指定路径；LoD builder 可用 `--builder` 指定。它核对源哈希，导出完整 B，转换完整 G，然后登记显示资产。当前 `export_glb.py` 的默认模型集合为 `MODEL_NATIVE`、优先使用 `MODEL` View Layer，排除不在该集合的嵌入扫描，并按 Blender +Z 项目坐标报告 glTF Y-up 到项目坐标的矩阵。不同集合、坐标或可见性约定先在副本适配并同机位检查，不能把空白、局部模型或旧版文件当作已就绪。首次准备完整扫描可能耗时并占用额外磁盘空间。

## 有限状态与命令

`review-session.json` 位于审阅包内，是 Agent 管理服务生命周期的持久状态；`review-service.log` 保留启动和运行输出。不要手工编辑状态文件。CLI 绑定 `127.0.0.1`，自动构建网页，默认选空闲端口，并在返回 URL 前检查服务、B 和 G。重复 `start` 会复用同一健康会话；进程意外退出后可重启。Agent 每次启动都应把**本次返回的 URL**发给 Human，不能沿用旧端口。

```bash
cd "$RUNTIME"
node tools/review-session.mjs start  --manifest "$MANIFEST"
node tools/review-session.mjs status --manifest "$MANIFEST"
```

状态流为：

| 当前状态 | Agent 动作 | 下一状态 |
| --- | --- | --- |
| 尚未启动、paused、result_ready | `start`，核对健康状态并发 URL | reviewing |
| reviewing | Human 在网页点击“完成 Review”，服务记录当前版本意见并停止 | feedback_submitted |
| reviewing | Human 已在对话中明确完成但未点击按钮时，Agent 执行 `finish` | feedback_submitted |
| reviewing | 需要临时停服时执行 `pause` | paused |
| feedback_submitted | 修订版结果已登记且同机位结果图齐备后执行 `publish-result` | result_ready |

旧审阅包（例如已经由 Human 明确完成的 R33）没有 `review-session.json` 时，Agent 可一次性执行 `adopt-feedback --manifest "$MANIFEST"` 登记现有反馈，直接进入 `feedback_submitted`；它不启动服务，也不改写 Issue。只有确实收到 Human 完成信号时才用，已有状态的包不能重复接入。

网页“完成 Review”只汇总当前审阅版本，保留过往版本的 Issue 与机位但在本轮侧栏隐藏；它写入 `review-session.json` 并停止本机服务。`finish` 是 Human 已在对话中明确完成、但未点击按钮时的 Agent 入口，同样会停止服务并记录当前版本的提交、草稿、通过、退回数量。**不因页面空闲、浏览器关闭或 Agent 看到若干 Issue 就推断 Human 已审完。** 按钮目前不会自动唤醒 Codex Agent；Agent 恢复工作时检查状态文件。若 Human 说本轮没有问题，Agent 可结束该轮，不必虚构结果版本。

```bash
node tools/review-session.mjs finish --manifest "$MANIFEST"
```

Agent 只读取本轮完成版本中已提交且未删除的 Issue、机位和截图，在独立 `.blend` 副本修订；旧轮次 Issue 保留追溯，不再带入本轮结果。如果项目已有更晚累计版本或人工修改，先协调差异。准备逐 Issue 的 `responses.json` 后回填结果：

```bash
node tools/prepare-result.mjs --manifest "$MANIFEST" --revision R34 \
  --blend /绝对路径/累计_R34.blend --responses /绝对路径/responses.json
node tools/review-session.mjs publish-result --manifest "$MANIFEST" --revision R34
node tools/review-session.mjs start --manifest "$MANIFEST"
```

`prepare-result` 会校验源文件变化、导出结果 GLB、渲染相关机位的 `B_after` 并登记版本；可用 `--blender` 和 `--chrome` 指定本机程序。若目录里有旧流程的安全占位文件，它会按既有兼容规则复用，已有真实结果拒绝覆盖。`publish-result` 再核对每条待复核 Issue 的回复和结果图。Agent 发新的 URL，请 Human 在网页中 Accept/Return；Agent 不代替 Human 决定通过。Human 完成本轮复核后再次 `finish`，若仍有返回意见，可制作下一累计版本并继续 `publish-result → start`。新的基础模型需要新 Review 包，旧包保留追溯。

本机服务仅在同一台机器的 `127.0.0.1` 可访问；如果 Human 不在这台机器上，不能把该 URL 当作可远程访问链接。不要为方便访问而直接绑定公网地址。出现中断时先运行 `status`，查看 `review-service.log`，再恢复；无须覆盖或删除源模型、扫描、既有机位和 Issue。
