# Camera Tour 0.3

可移植的打点路线、平滑时间参数化、同轨逐帧渲染和视频编码模块。代码已接入网页 Review，但不修改 Skill 的建模流程，也不把视频任务作为 Review 完成或通过信号。

## 复用边界

| 模块 | 运行环境 / 责任 |
| --- | --- |
| `core.mjs` | 无第三方依赖，Node / 浏览器；格式校验、路径、朝向、速度、固定 25Hz 相机表 |
| `render-job.mjs` | 无 DOM 和渲染引擎依赖；通过 adapter 调用 begin / render / end，所有版本共用帧表 |
| `store.mjs` | Node；注入目录、alignmentId、版本解析器、编码器路径；路线及任务落盘、严格验帧、取消 |
| `encoder.mjs` | Node + FFmpeg/libx264 + FFprobe；独立 MP4、左右对比 MP4、逐文件帧率/时长/帧数验证 |
| `review-adapter.mjs` | Review 主机专属的资产目录解析；不属于可独立拷贝的核心包 |
| `../../src/tour-render-adapter.js` | Three.js / Spark 2.2.0 主机适配器，负责固定相机、分页/LoD/排序屏障和画面读取 |
| `../../src/tour-controller.js` | 网页表单、预览、时间轴、自动保存和任务进度 |

`package.json` 已定义模块 exports，可作为私有 file dependency 引入，也可直接 import `core.mjs`。未来 Skill 或其他主机复用包和适配器，不复制一次性的项目脚本，不依赖 0929A 路径。

## 路线契约

```js
import { compileTour, quaternionFromAngles } from './core.mjs';
const tour = {
  schema_version: 1,
  name: '入口到庭院',
  alignment_id: 'project-registration-v1',
  coordinate_frame: 'project', world_up: '+Z',
  settings: { speed: 3, acceleration: 1.5, turnRate: 35,
    smoothness: .65, duration: null, fov: 60 },
  points: [
    { id: 'P1', position: [0, 0, 1.6], quaternion: quaternionFromAngles(0, 0), lock_orientation: true, hold: 0 },
    { id: 'P2', position: [0, 20, 1.6], quaternion: quaternionFromAngles(.5, 0), lock_orientation: true, hold: 1 },
  ],
};
const compiled = compileTour(tour);
const pose = compiled.sample(1.2);
const frames = compiled.frames();
```

位置采用项目坐标；世界 +Z 向上，相机 -Z 朝前、+Y 朝上；四元数顺序 xyzw。默认锁定水平，以 yaw / pitch 重建相机姿态，不保留相机 roll。视角为垂直 FOV；像素长宽比为 1。未知尺度显示 scene units，不能借 RTK 原点自动宣称米制速度校准。

机位默认约束位置与朝向，`lock_orientation:false` 时只约束位置；至少一个朝向锚点，全部取消时沿用首点朝向。Yaw 展开后采用保形三次插值，经过 ±180° 时沿短角度转动。位置使用受限切向的插值样条，`smoothness:0` 形成直线路段；打点不等于自动避障，需预览检查转弯是否切入建筑。允许同位置不同朝向、首尾停留和中间停留；重复且无朝向变化的全静止路线拒绝生成。

路径密采样后，结合位移与角位移建立固定距离参数，以共享切线的 C1 三次曲线连续插值；使用一阶/二阶导数的 Bezier 控制界限逐段限制速度、转头速度和加速度，再做前后向速度规划，局部转弯只影响相应路段。100Hz 数值审计复核最终时间参数化，不再把离散折线接点当成真实冲击并整体拖慢路线。峰值记录于 metrics；这不是连续时间最优控制或碰撞保证。参数中的速度是上限，短段和急弯未必达到。`duration` 是成片目标秒数，量化为最近的整帧，过短则拒绝，留空自动计算。最后一个机位精确采样，末帧显示 1/25 秒。

固定输出 `fps=25`、第 n 帧 `timestamp_us=n*40000`。帧表同时包含位置、四元数、FOV、`camera_to_world`；模型版本不能分别重新拟合轨迹。

## 渲染适配器契约

```js
await renderTourJob({
  job, frames, signal,
  adapter: {
    async begin(job) {},
    async render(track, frame, { signal }) { return { blob, meta }; },
    async end() {}, // 成功、取消、失败均调用，恢复主机状态
  },
  async upload(track, index, blob, meta) {},
  async finish() {}, onProgress(event) {},
});
```

Web 适配器进入导出时停止实时相机时钟和自动 Spark 更新，以固定输出分辨率驱动每个机位的异步页、LoD 选择、映射与深度排序。等待当前页全部到达、LoD Worker 空闲、排序完成且映射一致，再取 PNG；90 秒超时即失败，禁止缺页截图。相关内部字段仅封装在 Spark 2.2.0 适配器中，升级版本须重新验证，不散落进核心库。

当前显示资产为完整扫描派生的分页 RAD，遵循现有 SH0 档位；SH3 原始输入与显示档位分别记录。不是每帧加载全部原始 splat，也不宣称原始 SH3 全量渲染。相机和渲染参数一致可验证几何对齐，模型灯光不等于现场光照还原。

## 存储与 HTTP

所有数据在审阅包的 `tours/`，与原 Review 的 views / issues / 完成状态分开。

```text
tours/routes/T_uuid.json                 # 路线 + sha256 + 更新时间
tours/models.json                       # 可选额外模型目录
tours/exports/E_uuid/
  route.json, frames.json, job.json       # 固定生成输入、帧表与资产哈希
  capture.jsonl                         # 每帧相机、时间、就绪状态和 PNG 哈希
  frames/G/000000.png                    # 所有画面保留，可独立编码
  frames/B_base/000000.png
  G.mp4, B_base.mp4, compare_G_B_base.mp4
  *.mp4.probe.json, encoding.log
```

API：`GET /api/tours`；`GET/PUT /api/tours/:id`；`POST /api/tour-jobs`；`GET /api/tour-jobs/:id[/frames]`；`PUT /api/tour-jobs/:id/frames/:track/:index`（PNG + X-Frame-Meta）；`POST .../:id/finish|cancel|resume`；`GET /tour-file/:id/:name`。

创建任务固定路线哈希、帧表哈希、每个版本的资产哈希和坐标。逐帧上传验证连续帧号、分辨率、时间、完整矩阵、FOV、资产哈希；G 额外验证页/排序/LoD 就绪。所有版本帧数齐备才可编码；编码失败不会发布视频。支持主动取消，保留已采集文件；浏览器关闭导致的中断可取消后继续生成，已停止任务可用“继续生成（保留已有帧）”恢复；服务先校验冻结路线、相机表、资产/坐标及每张已采集 PNG 的哈希，再从各轨道的下一帧继续。页面关闭后先取消中断任务，再恢复；不自动重启浏览器或绕过高斯就绪检查。单机单写入者，不支持跨进程并发写同一 tours 目录。

当前限制：2–100 点；预览最长 1 小时，视频导出最多 15,000 帧（10 分钟）；超出导出预算仍可播放预览，网页在导出按钮旁解释原因。导出服务独立检查此预算。1–8 个版本，每视图 640×360 / 1280×720 / 1920×1080；对比版宽度为两倍。无音轨、无运动模糊、无自动避障。生成时保持页面打开，浏览器调度或后台限速只影响耗时，不改变视频时间。

编码器可通过 `TOUR_FFMPEG` / `TOUR_FFPROBE`，或 TourStore 的 `encoderOptions` 指定；没有编码器时禁用生成，仍可编辑和导出路线。

## CLI 和多版本

```bash
node tools/compile-tour.mjs --route /path/route.json --out /new/path/frames.json
node tools/register-tour-model.mjs --manifest /path/current/manifest.json \
  --from-manifest /path/other/manifest.json --revision R2 \
  --id R2_frozen --label 'LOD2 · R2（冻存）'
```

模型目录工具校验源扫描哈希、项目变换和 GLB 哈希，写独立 `tours/models.json`，不篡改 Review 的版本或验收状态。将另一个 GLB 跨坐标系复用前必须先注册，工具拒绝自动猜测。也可以按此目录格式集成自己的资产解析器。

## 验证

`npm test` 覆盖确定性、弧长速度、跨角度边界、朝向解锁、原地转头、停留、运动限制、坐标拒绝、共享帧表、失败恢复，以及真实 FFmpeg/FFprobe 编码。集成试验另用实际 0929A 的完整分页扫描，检查三时刻画面与 capture.jsonl。后续将此能力纳入 Skill 时，以当前 API / schema 和验证记录为依据，不把自动测试当成人工布局验收。

### Viewer 漫游加速

左视图内按住 Shift + W/A/S/D/Q/E，以基础漫游速度的 10 倍平移；Q 下降、E 上升。松开 Shift 恢复基础速度。加速只用于人工漫游，成片速度仍由路线参数决定。Shift 可先按，也可在移动中按下或松开；失焦和移出视图会清空按键，输入框编辑时不触发导航。

### 0.2 多点预览修复

回归覆盖 33 点小区环线：旧版数值接点误判使全程膨胀至约 24 分钟并被导出上限拦截；0.2 使用局部导数界限，原设置计算约 182.4 秒，所有机位的位置和朝向不变。预览按钮旁始终给出就绪或禁用原因；长路线的导出预算不再阻止预览。播放时只更新俯视游标，不逐帧重建整条路线 SVG。

### 0.3 中断任务续帧

取消或失败的任务可从原逐帧表继续；完成视频、运行中的采集及仍在编码的任务拒绝恢复。续帧不保存或重新编译当前编辑器路线，不因 Human 后来编辑路线而替换原任务的冻结输入。冻结输入、坐标、显示资产、帧日志或 PNG 改变时拒绝恢复；原帧保留。新增测试覆盖部分轨道跳帧、损坏 PNG、资产漂移、相机表漂移和 HTTP 恢复。恢复后仍逐帧执行分页、LoD 与排序屏障。
