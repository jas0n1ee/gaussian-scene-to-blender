# 人工 Review 协议

用于 Agent 准备人工审阅、读取人工反馈、交付修订对照；也是本机网页审阅工具的数据契约。旧 Blender add-on 方案已归档。现有 R33 包的路径和字段含义必须兼容。

## 交互与职责

用户在浏览器左侧看 Spark 显示的完整扫描 G，右侧看 Three.js 显示的模型 B；两侧共用项目坐标中的相机。B 的 GLB 从对应累计 `.blend` 导出，G 的流式 LoD 文件从完整原始扫描生成。两者都是只读显示派生物；`.blend` 和原始扫描仍是源文件。固定空间裁剪不能冒充完整漫游。

W/S 前后、A/D 左右、Q/E 下上，方向键调 pitch/yaw。默认锁定 roll，但保存完整相机姿态。两侧统一投影、FOV、画幅和成像区域。冻结截图记录分辨率、裁剪、渲染模式、LoD/分页状态、曝光、色彩管理和可见性；缺页或任一截图失败时保留草稿及原因，不提交完整 Issue。

用户可在 G 或 B 图上画二维框、写意见，不要求选择物体或提供 object_id，GLB 也不必输出对象 ID 映射。同一 view_id 可有多个 Issue。支持查看、编辑、软删除、定位回机位；已提交记录保留修改历史，删除不重编号。前端负责交互和问题统计，本机轻量服务负责文件读写、原子提交及大文件服务。首版不需要数据库、MCP 或 Electron。

## 坐标约定

`alignment.json` 记录 schema_version、alignment_id、坐标系/轴向/单位、尺度校准状态、原始 G 到项目坐标的 4×4 矩阵、原生 B 到项目坐标的矩阵，以及是否已烘焙。资产分别记录路径和哈希。多层共用水平旋转与全局垂直基准；楼层局部坐标另记可逆变换。

矩阵按行存储，作用于齐次列向量，并注明方向。相机 `camera_to_world` 保存在项目坐标中，约定 Blender 相机局部 -Z 前、+Y 上。glTF/GLB 导出可能转换坐标轴，因此派生资产另记 GLB 加载后到项目坐标的变换；浏览器对 B 与 G 各应用其应有变换一次。B 已在项目坐标时，不能再次施加 G 的旋转或 Z 偏移。

一个已开始的 Review 包中，原始资产、alignment 和原机位冻结。发现注册错误时生成新的 alignment_id 与修订版本，记录旧到新迁移；旧截图和原标注不变，依赖旧对齐的未决 Issue 标记为需要重新核对。

## 目录与编号

默认 `PROJECT_ROOT/reviews/R33/`；按楼层文件审阅时为 `reviews/F02_R33/`。R33 是被审阅的基础累计模型版本。已有同名目录时恢复而非清空。

```text
reviews/F02_R33/
  manifest.json
  alignment.json
  display/B_R33.glb
  display/G_R33.rad
  views/V0001/camera.json
  views/V0001/G.png
  views/V0001/B_before.png
  issues/F02_R33_I1.json
  results/R34/B_R34.glb
  results/R34/views/V0001/B_after.png
  results/R34/responses.json
```

单层无前缀时用 `R33_I1`。Issue 在 R34 修好后仍保留原 ID，另记录结果版本。I 在基础版本/楼层包中递增，不因删除或换机位复用。

`manifest.json` 保留现有 `schema_version: 1` 与 `project_root`、`assets.B/G`、alignment、views/issues/results 索引的含义。`assets.B/G` 仍指 `.blend` 和原始扫描；可选 `display_assets` 追加 GLB/RAD 相对路径、哈希、源哈希、生成参数及显示资产到项目坐标的变换。旧包缺少网页显示资产时报告未就绪，不把局部 C1 参考当完整 G，不重定义原字段。路径基准要明确；大文件无需每次导航重新算哈希。

`camera.json` 记录 view_id、alignment_id、项目坐标中的 `camera_to_world`、相机轴、透视/正交及内参、分辨率/像素比例、camera shift、裁剪和 G/B 实际渲染设置。不能只记 XYZ 和 yaw。旧 Blender/KIRI 截图继续作为当时的证据，不覆盖或改写其范围记录。

Issue 记录 issue_id、base_revision、view_id、文字、状态和 annotations。每个框绑定 `source_image`（G 或 B_before）与左上原点的归一化 `xywh`。二维框不是三维空间范围，Agent 不得直接当作世界坐标。Agent 内部可推断涉及对象，但不要求 Human 提供。原始 PNG 和 JSON 同时保留；反色框作为展示叠加，不烧写到干净原图。

## Agent 在人工 Review 前的准备

1. 核对实际累计 `.blend` 与 checkpoint，保留用户修改；确认完整 G 来源、版本、哈希及坐标变换。建立或恢复审阅包，写 manifest 和 alignment。用户未反馈时不虚构 Issue 或无目的机位。
2. 在独立副本验证 B 的完整 GLB 导出：只含应审阅的原生模型，不含嵌入扫描和隐藏诊断代理；记录源/派生哈希、导出范围、坐标映射和警告。随 Skill 提供的工具入口、默认集合与坐标前提见 [web-review-runtime.md](web-review-runtime.md)。项目另有 GLB 交接规范时也应核对。
3. 从完整原始 G 生成流式 LoD 资产并记录源/派生关系。用诊断机位及远离局部样板的机位验证网页双侧投影、坐标、可见性和全场覆盖。失败时记录未就绪，不以旧图或空白图宣称完成。
4. Agent 启动网页服务，确认健康检查和双资产就绪，把实际本机 URL 发给 Human；不要让 Human 双击版本专用脚本或手工启动后端。Human 漫游、记录问题时才按需增加 views 与 issues；准备审阅不等于获得自动改模授权。Human 明确说本轮完成后，Agent 才结束审阅并读取已提交意见；页面当前没有自动唤醒 Agent 的按钮。

## Agent 处理与返回

读取已提交且未删除的 Issue，查看保存的 G/B_before、框和相机。需要补证据时另存，不覆盖原始截图。基于对应基础 `.blend` 保存新的累计版本；如已有后续或人工修改，先协调差异，不回滚覆盖。

导出与修订 `.blend` 对应的新 GLB，在受影响 view_id 的同相机和可比网页渲染设置下输出 B_after。记录修改说明、实际涉及对象（Agent 内部识别）、结果版本和未解决原因。状态设为待 Human 复核，不能代替 Human Accept。没有有效 B_after 时不可 Accept。

网页按 Issue 展示 G、带反色标注的 B_before、干净 B_after 三列；G 上的原标注也显示在 G。B_before 的对应框仅表示同投影审阅区域，不宣称匹配三维对象。B_after 可切换框线。网页提供定位回机位及 Human Accept/Return；可另导出 HTML 汇总。失败、缺图和不同渲染器造成的外观差异应明确展示。
