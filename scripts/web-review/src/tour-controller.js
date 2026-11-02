import {
  normalizeTour,
  compileTour,
  DEFAULT_SETTINGS,
  exportLimitMessage,
} from "../lib/tour/core.mjs";
import { renderTourJob } from "../lib/tour/render-job.mjs";

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const uuid = () => crypto.randomUUID();
const request = async (url, method = "GET", body) => {
  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function createTourController({ adapter, state, hostBusy }) {
  let route = null,
    id = null,
    sha = null,
    compiled = null,
    compileError = null,
    selected = -1,
    planProject = null,
    playing = false,
    playStart = 0,
    playOffset = 0,
    time = 0,
    busy = false,
    active = false,
    abort = null,
    currentJob = null,
    catalog = null,
    saveTimer = null,
    saveQueue = Promise.resolve(),
    generation = 0;
  const message = (text, error = false) => {
    $("tour-status").textContent = text;
    $("tour-status").classList.toggle("error", error);
  };
  const blank = () => ({
    schema_version: 1,
    name: "路线 1",
    alignment_id: state().manifest.alignment_id,
    coordinate_frame: "project",
    world_up: "+Z",
    settings: { ...DEFAULT_SETTINGS },
    points: [],
  });
  function unlock() {
    adapter.freeze(false);
  }
  function pause() {
    playing = false;
    $("tour-play").textContent = "播放预览";
  }
  function updateButtons() {
    $("tour-add").disabled = busy || !adapter.ready();
    $("tour-play").disabled = busy || !compiled;
    const previewReason = busy
      ? "正在生成视频，完成或取消后可预览"
      : compileError || (!compiled ? "至少添加两个不同位置或朝向的机位" : "");
    $("tour-play").title = previewReason || "播放当前路线";
    $("tour-preview-status").textContent =
      previewReason || "轨迹已就绪，可以播放预览";
    $("tour-preview-status").classList.toggle("error", !!compileError);
    const exportReason = compiled ? exportLimitMessage(compiled) : null;
    $("tour-export-note").textContent = exportReason || "";
    $("tour-export-note").classList.toggle("hidden", !exportReason);
    $("tour-export").disabled =
      busy || !compiled || !!exportReason || !catalog?.encoder.ready;
    $("tour-export").title =
      exportReason || previewReason || "生成选定版本的视频";
    $("tour-cancel").classList.toggle("hidden", !busy);
    $("tour-back").disabled = busy;
    $("tour-editor").inert = busy;
    $("tour-settings").inert = busy;
    $("tour-output").disabled = busy;
    $("tour-open").disabled = busy;
    for (const e of document.querySelectorAll("[data-tour-mutates]"))
      e.disabled = busy;
  }
  function compile() {
    compiled = null;
    compileError = null;
    if (route.points.length >= 2)
      try {
        compiled = compileTour(route);
        $("tour-summary").textContent =
          `${route.points.length} 个机位 · ${compiled.path_length.toFixed(1)} 场景单位 · ${compiled.duration.toFixed(2)} 秒 · ${compiled.frame_count} 帧 / 25fps`;
        const m = compiled.metrics;
        $("tour-limits").textContent =
          `计算峰值：速度 ${m.max_speed.toFixed(2)} · 加速度 ${m.max_acceleration.toFixed(2)} · 转头 ${m.max_turn_rate.toFixed(1)}°/秒`;
        $("tour-time").max = compiled.motion_duration;
        time = Math.min(time, compiled.motion_duration);
      } catch (error) {
        compileError = error.message;
        $("tour-limits").textContent = error.message;
        message(error.message, true);
        $("tour-summary").textContent = "路线需要调整";
      }
    else {
      $("tour-summary").textContent = "自由漫游后添加至少两个机位";
      $("tour-limits").textContent = "每个机位默认保留朝向；可设为只约束位置。";
    }
    drawPlan();
    updateButtons();
  }
  function drawPlan() {
    planProject = null;
    const svg = $("tour-plan"),
      points =
        compiled?.preview_nodes.map((n) => n.position) ||
        route.points.map((p) => p.position);
    if (!points.length) {
      svg.innerHTML =
        '<text x="20" y="60" fill="#6e8276" font-size="13">添加机位后显示俯视路线</text>';
      svg.setAttribute("viewBox", "0 0 500 130");
      return;
    }
    const xs = points.map((p) => p[0]),
      ys = points.map((p) => p[1]),
      minX = Math.min(...xs),
      minY = Math.min(...ys),
      dx = Math.max(1, Math.max(...xs) - minX),
      dy = Math.max(1, Math.max(...ys) - minY);
    const scale = Math.min(450 / dx, 105 / dy),
      xy = (p) => [25 + (p[0] - minX) * scale, 125 - (p[1] - minY) * scale];
    svg.setAttribute("viewBox", "0 0 500 150");
    svg.innerHTML =
      `<polyline points="${points.map((p) => xy(p).join(",")).join(" ")}" fill="none" stroke="#268b70" stroke-width="2"/>` +
      route.points
        .map((p, i) => {
          const [x, y] = xy(p.position);
          const q = p.quaternion,
            fx = -2 * (q[0] * q[2] + q[1] * q[3]),
            fy = 2 * (q[0] * q[3] - q[1] * q[2]);
          return `<g><line x1="${x}" y1="${y}" x2="${x + fx * 14}" y2="${y - fy * 14}" stroke="#7e8d83"/><circle cx="${x}" cy="${y}" r="${selected === i ? 6 : 4}" fill="${selected === i ? "#dd873c" : "#246b57"}"/><text x="${x + 7}" y="${y - 6}" font-size="10" fill="#3f5348">${i + 1}</text></g>`;
        })
        .join("");
    if (compiled) {
      planProject = xy;
      const [x, y] = xy(compiled.sample(time).position);
      svg.innerHTML += `<circle id="tour-plan-cursor" cx="${x}" cy="${y}" r="3" fill="#ef633e" stroke="white"/>`;
    }
  }
  function renderPoints() {
    $("tour-points").innerHTML =
      route.points
        .map(
          (
            p,
            i,
          ) => `<div class="tour-point ${selected === i ? "selected" : ""}">
      <button class="tour-point-go" data-go="${i}" title="返回此机位">${p.thumbnail ? `<img src="${p.thumbnail}" alt="机位 ${i + 1}"/>` : `<span>${i + 1}</span>`}</button>
      <div class="tour-point-fields"><label class="sr-only" for="point-name-${i}">机位 ${i + 1} 名称</label><input id="point-name-${i}" data-name="${i}" value="${esc(p.name)}"/><small>${p.position.map((x) => x.toFixed(1)).join(" / ")}</small>
      <div class="tour-point-options"><label><input type="checkbox" data-lock="${i}" ${p.lock_orientation ? "checked" : ""}/>保留朝向</label><label>停留 <input type="number" data-hold="${i}" min="0" max="60" step="0.5" value="${p.hold}" aria-label="机位 ${i + 1} 停留秒数"/> 秒</label></div></div>
      <div class="tour-point-actions"><button data-update="${i}" title="用当前视角替换">替换</button><button data-insert="${i}" title="在后面插入当前视角">插入</button><button data-up="${i}" ${i === 0 ? "disabled" : ""} aria-label="上移机位 ${i + 1}">↑</button><button data-down="${i}" ${i === route.points.length - 1 ? "disabled" : ""} aria-label="下移机位 ${i + 1}">↓</button><button data-remove="${i}" aria-label="删除机位 ${i + 1}">移除</button></div></div>`,
        )
        .join("") ||
      '<p class="empty">用左视图漫游，点击“添加轨迹点”，保存位置和当前视线。</p>';
    for (const [attr, fn] of Object.entries({
      go: (i) => {
        pause();
        selected = i;
        time =
          compiled?.key_times.find((k) => k.point_id === route.points[i].id)
            ?.time || 0;
        adapter.setPose({ ...route.points[i], fov: route.settings.fov });
        unlock();
        renderPoints();
        timeline();
      },
      update: (i) => {
        const p = recordPoint();
        route.points[i] = {
          ...route.points[i],
          position: p.position,
          quaternion: p.quaternion,
          thumbnail: p.thumbnail,
        };
        changed();
      },
      insert: (i) => {
        if (route.points.length >= 100) throw new Error("最多 100 个机位");
        route.points.splice(i + 1, 0, recordPoint());
        selected = i + 1;
        changed();
      },
      up: (i) => {
        [route.points[i - 1], route.points[i]] = [
          route.points[i],
          route.points[i - 1],
        ];
        selected = i - 1;
        changed();
      },
      down: (i) => {
        [route.points[i + 1], route.points[i]] = [
          route.points[i],
          route.points[i + 1],
        ];
        selected = i + 1;
        changed();
      },
      remove: (i) => {
        route.points.splice(i, 1);
        selected = Math.min(i, route.points.length - 1);
        changed();
      },
    }))
      for (const button of $("tour-points").querySelectorAll(`[data-${attr}]`))
        button.onclick = () => {
          if (!busy)
            try {
              fn(Number(button.dataset[attr]));
            } catch (e) {
              message(e.message, true);
            }
        };
    for (const input of $("tour-points").querySelectorAll("[data-name]"))
      input.onchange = () => {
        route.points[Number(input.dataset.name)].name = input.value;
        changed(false);
      };
    for (const input of $("tour-points").querySelectorAll("[data-lock]"))
      input.onchange = () => {
        route.points[Number(input.dataset.lock)].lock_orientation =
          input.checked;
        changed();
      };
    for (const input of $("tour-points").querySelectorAll("[data-hold]"))
      input.onchange = () => {
        route.points[Number(input.dataset.hold)].hold = Number(input.value);
        changed();
      };
    drawPlan();
  }
  function recordPoint() {
    return {
      id: `P_${uuid()}`,
      name: `机位 ${route.points.length + 1}`,
      ...adapter.snapshot(),
      lock_orientation: true,
      hold: 0,
      thumbnail: adapter.thumbnail(),
    };
  }
  function changed(render = true) {
    pause();
    sha = null;
    generation++;
    try {
      route = normalizeTour(route);
      compile();
      if (render) renderPoints();
      message(compileError || "路线已修改，自动保存中…", !!compileError);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(
        () => save().catch((e) => message(e.message, true)),
        450,
      );
    } catch (e) {
      compiled = null;
      compileError = e.message;
      updateButtons();
      message(e.message, true);
    }
  }
  async function save() {
    clearTimeout(saveTimer);
    const value = structuredClone(route),
      routeId = id,
      version = generation;
    const task = saveQueue.then(() =>
      request(`/api/tours/${routeId}`, "PUT", value),
    );
    saveQueue = task.catch(() => {});
    const result = await task;
    if (id === routeId && generation === version) {
      sha = result.sha256;
      message(compileError || "路线已保存", !!compileError);
      const option = [...$("tour-library").options].find((o) => o.value === id);
      if (option)
        option.textContent = `${route.name} · ${route.points.length} 点`;
    }
    return result;
  }
  function populateSettings() {
    for (const key of [
      "speed",
      "acceleration",
      "turnRate",
      "smoothness",
      "duration",
      "fov",
    ])
      $(`tour-${key}`).value = route.settings[key] ?? "";
    $("tour-name").value = route.name;
    adapter.setPose({ ...adapter.snapshot(), fov: route.settings.fov });
  }
  function timeline() {
    $("tour-time").value = time;
    $("tour-time-label").textContent =
      `${time.toFixed(2)} / ${(compiled?.motion_duration || 0).toFixed(2)} 秒`;
    // Keep the route SVG static during playback; only move its cursor.
    const cursor = $("tour-plan-cursor");
    if (compiled && planProject && cursor) {
      const [x, y] = planProject(compiled.sample(time).position);
      cursor.setAttribute("cx", x);
      cursor.setAttribute("cy", y);
    }
  }
  async function refreshLibrary() {
    catalog = await request("/api/tours");
    const select = $("tour-library");
    select.innerHTML =
      '<option value="">选择已保存路线…</option>' +
      catalog.routes
        .map(
          (r) =>
            `<option value="${esc(r.id)}">${esc(r.name)} · ${r.points} 点</option>`,
        )
        .join("");
    select.value = catalog.routes.some((r) => r.id === id) ? id : "";
    const chosen = [...document.querySelectorAll("[data-track]:checked")].map(
      (e) => e.value,
    );
    $("tour-tracks").innerHTML = catalog.tracks
      .map(
        (t) =>
          `<label><input type="checkbox" data-track value="${esc(t.id)}" ${!chosen.length || chosen.includes(t.id) ? "checked" : ""}/> ${esc(t.label)}${t.kind === "gaussian" ? " · SH0" : ""}</label>`,
      )
      .join("");
    $("tour-encoder").textContent = catalog.encoder.ready
      ? "本机编码器就绪 · H.264 / MP4 · 25fps"
      : `编码器未就绪：${catalog.encoder.error}`;
    renderJobs(catalog.jobs);
    updateButtons();
  }
  function renderJobs(jobs) {
    $("tour-jobs").innerHTML =
      jobs
        .slice(0, 8)
        .map(
          (j) =>
            `<div class="tour-job"><strong>${esc(j.name)}</strong><span>${esc({ complete: "已完成", capturing: "采集中", encoding: "编码中", cancelled: "已取消", failed: "失败" }[j.status] || j.status)} · ${j.frame_count} 帧 · ${j.width}×${j.height}/视图</span>${j.error ? `<p class="error">${esc(j.error)}</p>` : ""}${j.status === "complete" ? `<div class="tour-downloads">${j.outputs.map((o) => `<a href="/tour-file/${j.id}/${o.file}" target="_blank" rel="noopener">${esc(o.label)} ↗</a>`).join("")}<a href="/tour-file/${j.id}/frames.json" download>逐帧相机</a><a href="/tour-file/${j.id}/job.json" download>生成记录</a></div>` : ["capturing", "encoding"].includes(j.status) ? `<button data-cancel-job="${j.id}">取消未完成任务</button>${j.interrupted ? "<p>上次任务已中断，画面保留；请重新生成。</p>" : ""}` : ["cancelled", "failed"].includes(j.status) ? `<button data-resume-job="${j.id}">继续生成（保留已有帧）</button>` : ""}</div>`,
        )
        .join("") || '<p class="empty">视频生成后在这里下载。</p>';
    for (const button of $("tour-jobs").querySelectorAll("[data-cancel-job]"))
      button.onclick = async () => {
        try {
          await request(
            `/api/tour-jobs/${button.dataset.cancelJob}/cancel`,
            "POST",
            {},
          );
          await refreshLibrary();
        } catch (e) {
          message(e.message, true);
        }
      };
    for (const button of $("tour-jobs").querySelectorAll("[data-resume-job]"))
      button.onclick = () => executeExport(button.dataset.resumeJob);
  }
  async function newRoute(value = null) {
    pause();
    clearTimeout(saveTimer);
    if (route && route.points.length) await save();
    route = normalizeTour(value || blank(), {
      alignmentId: state().manifest.alignment_id,
    });
    id = `T_${uuid()}`;
    sha = null;
    generation++;
    selected = -1;
    time = 0;
    populateSettings();
    renderPoints();
    compile();
    timeline();
    await save();
    await refreshLibrary();
    unlock();
  }
  async function open() {
    if (hostBusy()) return;
    active = true;
    $("tour-panel").classList.remove("hidden");
    $("review-sidebar").classList.add("hidden");
    $("review-toolbar").classList.add("hidden");
    $("review-top-actions").classList.add("hidden");
    adapter.aspect(16 / 9);
    try {
      await refreshLibrary();
      if (!route) {
        if (catalog.routes.length) {
          const record = await request(`/api/tours/${catalog.routes[0].id}`);
          route = normalizeTour(record.tour, {
            alignmentId: state().manifest.alignment_id,
          });
          id = record.id;
          sha = record.sha256;
          $("tour-library").value = id;
          populateSettings();
          renderPoints();
          compile();
          timeline();
        } else await newRoute();
      }
      message(
        compileError || "漫游打点；手动操作速度不会进入成片。",
        !!compileError,
      );
    } catch (e) {
      message(e.message, true);
    }
    updateButtons();
  }
  function close() {
    if (busy) return;
    pause();
    unlock();
    active = false;
    $("tour-panel").classList.add("hidden");
    $("review-sidebar").classList.remove("hidden");
    $("review-toolbar").classList.remove("hidden");
    $("review-top-actions").classList.remove("hidden");
    adapter.aspect(null);
  }
  $("tour-nav-speed").oninput = (e) =>
    adapter.navigationSpeed(Number(e.target.value));
  $("tour-open").onclick = open;
  $("tour-back").onclick = close;
  $("tour-add").onclick = () => {
    try {
      pause();
      unlock();
      if (route.points.length >= 100) throw new Error("最多 100 个机位");
      route.points.push(recordPoint());
      selected = route.points.length - 1;
      changed();
    } catch (e) {
      message(e.message, true);
    }
  };
  $("tour-new").onclick = () =>
    newRoute().catch((e) => message(e.message, true));
  $("tour-name").onchange = (e) => {
    route.name = e.target.value;
    changed(false);
  };
  for (const key of [
    "speed",
    "acceleration",
    "turnRate",
    "smoothness",
    "duration",
    "fov",
  ])
    $(`tour-${key}`).onchange = (e) => {
      route.settings[key] =
        key === "duration" && e.target.value === ""
          ? null
          : Number(e.target.value);
      changed(false);
      if (
        key === "fov" &&
        route.settings.fov >= 15 &&
        route.settings.fov <= 110
      )
        adapter.setPose({ ...adapter.snapshot(), fov: route.settings.fov });
    };
  $("tour-library").onchange = async (e) => {
    if (!e.target.value) return;
    try {
      const next = e.target.value;
      await save();
      pause();
      const record = await request(`/api/tours/${next}`);
      route = normalizeTour(record.tour, {
        alignmentId: state().manifest.alignment_id,
      });
      id = next;
      sha = record.sha256;
      generation++;
      selected = -1;
      time = 0;
      populateSettings();
      renderPoints();
      compile();
      timeline();
      unlock();
      message("已加载路线");
    } catch (e) {
      message(e.message, true);
    }
  };
  $("tour-save").onclick = () =>
    save()
      .then(refreshLibrary)
      .catch((e) => message(e.message, true));
  $("tour-download-route").onclick = async () => {
    try {
      const record = await save();
      const blob = new Blob([JSON.stringify(record.tour, null, 2)], {
          type: "application/json",
        }),
        url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = `${id}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      message(e.message, true);
    }
  };
  $("tour-import-file").onchange = async (e) => {
    try {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) throw new Error("路线文件过大");
      await newRoute(JSON.parse(await file.text()));
      message("已导入为独立路线");
    } catch (e) {
      message(e.message, true);
    } finally {
      e.target.value = "";
    }
  };
  $("tour-play").onclick = () => {
    if (!compiled || busy) return;
    if (playing) {
      pause();
      unlock();
      return;
    }
    if (time >= compiled.motion_duration) time = 0;
    playing = true;
    adapter.freeze(true);
    playOffset = time;
    playStart = performance.now();
    $("tour-play").textContent = "暂停预览";
  };
  $("tour-time").oninput = (e) => {
    pause();
    time = Number(e.target.value);
    if (compiled) {
      adapter.setPose(compiled.sample(time));
      unlock();
      timeline();
    }
  };
  $("tour-free").onclick = () => {
    pause();
    unlock();
    message("已恢复自由漫游，可继续添加或替换机位。");
  };
  async function executeExport(resumeId = null) {
    if (busy || (!compiled && !resumeId)) return;
    pause();
    busy = true;
    abort = new AbortController();
    updateButtons();
    try {
      if (resumeId) {
        currentJob = await request(`/api/tour-jobs/${resumeId}/resume`, "POST", {});
      } else {
      const saved = await save(),
        trackIds = [...document.querySelectorAll("[data-track]:checked")].map(
          (e) => e.value,
        );
      const resolution = $("tour-resolution").value.split("x").map(Number);
      currentJob = await request("/api/tour-jobs", "POST", {
        route_id: id,
        route_sha256: saved.sha256,
        track_ids: trackIds,
        resolution,
      });
      }
      const frames = await request(`/api/tour-jobs/${currentJob.id}/frames`);
      await renderTourJob({
        job: currentJob,
        frames,
        adapter,
        signal: abort.signal,
        onProgress: ({ track, index, total }) => {
          message(`正在生成 ${track.label} · 第 ${index + 1} / ${total} 帧`);
          $("tour-progress").value =
            (currentJob.tracks.findIndex((t) => t.id === track.id) +
              (index + 1) / total) /
            (currentJob.tracks.length + 1);
        },
        upload: async (track, i, blob, meta) => {
          const response = await fetch(
            `/api/tour-jobs/${currentJob.id}/frames/${track.id}/${i}`,
            {
              method: "PUT",
              headers: {
                "Content-Type": "image/png",
                "X-Frame-Meta": JSON.stringify(meta),
              },
              body: blob,
              signal: abort.signal,
            },
          );
          if (!response.ok) throw new Error((await response.json()).error);
        },
        finish: () =>
          request(`/api/tour-jobs/${currentJob.id}/finish`, "POST", {}),
      });
      while (true) {
        if (abort.signal.aborted) throw new Error("已取消");
        const job = await request(`/api/tour-jobs/${currentJob.id}`);
        renderJobs([job, ...catalog.jobs.filter((j) => j.id !== job.id)]);
        message(job.message || "编码中…");
        if (job.status === "complete") {
          $("tour-progress").value = 1;
          message(
            `已生成 ${job.outputs.length} 个视频；25fps、帧数与时长校验通过。`,
          );
          break;
        }
        if (["failed", "cancelled"].includes(job.status))
          throw new Error(job.error || job.message);
        await delay(700);
      }
    } catch (e) {
      if (currentJob)
        await request(
          `/api/tour-jobs/${currentJob.id}/cancel`,
          "POST",
          {},
        ).catch(() => {});
      message(
        abort.signal.aborted ? "已取消，已采集画面保留。" : e.message,
        !abort.signal.aborted,
      );
    } finally {
      busy = false;
      currentJob = null;
      abort = null;
      await refreshLibrary().catch(() => {});
      updateButtons();
    }
  }
  $("tour-export").onclick = () => executeExport();
  $("tour-cancel").onclick = () => {
    abort?.abort();
    if (currentJob)
      request(`/api/tour-jobs/${currentJob.id}/cancel`, "POST", {}).catch(
        () => {},
      );
    message("正在取消任务…");
  };
  window.addEventListener("beforeunload", (e) => {
    if (busy) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  return {
    open,
    isBusy: () => busy,
    tick: (clock) => {
      if (!active || !playing || !compiled) return;
      time = Math.min(
        compiled.motion_duration,
        playOffset + (clock - playStart) / 1000,
      );
      adapter.setPose(compiled.sample(time));
      timeline();
      if (time >= compiled.motion_duration) {
        pause();
        unlock();
      }
    },
    pause: () => {
      pause();
      unlock();
    },
  };
}
