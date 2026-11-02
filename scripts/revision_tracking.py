#!/usr/bin/env python3
"""Live, revision-scoped record of visible modeling interactions (stdlib only)."""
import argparse
import base64
import contextlib
import datetime as dt
import fcntl
import hashlib
import html
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import uuid
from urllib.parse import quote


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def dump(value):
    return json.dumps(value, ensure_ascii=False, indent=2)


def atomic(path, content):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=".tracking-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def latest_context(path):
    """Read backwards; retain ONLY allowlisted metadata, never conversation text."""
    path = Path(path).expanduser().resolve()
    buffer = b""
    with path.open("rb") as stream:
        stream.seek(0, 2)
        position = stream.tell()
        while position:
            count = min(position, 65536)
            position -= count
            stream.seek(position)
            buffer = stream.read(count) + buffer
            lines = buffer.split(b"\n")
            buffer = lines.pop(0)
            for line in reversed(lines):
                if b'"turn_context"' not in line[:256]:
                    continue
                record = json.loads(line)
                if record.get("type") == "turn_context":
                    payload = record.get("payload", {})
                    if not isinstance(payload.get("model"), str) or not payload["model"]:
                        raise ValueError("Latest turn_context has no model; do not guess it")
                    return {"model": payload["model"], "turn_id": payload.get("turn_id"),
                            "source_timestamp": record.get("timestamp"),
                            "source": "runtime.turn_context", "source_path": str(path),
                            "evidence_status": "runtime_reported"}
            # Very large image lines do not need to stay in memory.
            if len(buffer) > 1024 * 1024:
                buffer = buffer[:256]
        if buffer:
            record = json.loads(buffer)
            if record.get("type") == "turn_context":
                payload = record.get("payload", {})
                if payload.get("model"):
                    return {"model": payload["model"], "turn_id": payload.get("turn_id"),
                            "source_timestamp": record.get("timestamp"),
                            "source": "runtime.turn_context", "source_path": str(path),
                            "evidence_status": "runtime_reported"}
    raise ValueError("No runtime turn_context found")


class Tracker:
    def __init__(self, project, revision):
        if not re.fullmatch(r"(?:F\d+_)?R\d+", revision):
            raise ValueError("Revision must be R<number> or F<number>_R<number>")
        self.project = Path(project).expanduser().resolve()
        self.root = self.project / "tracking"
        self.folder = self.root / revision
        self.revision = revision

    @contextlib.contextmanager
    def lock(self):
        self.root.mkdir(parents=True, exist_ok=True)
        with (self.root / ".lock").open("a") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            yield

    def events(self):
        path = self.folder / "events.jsonl"
        if not path.exists():
            return []
        records = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                records.append(json.loads(line))
        return records

    def snapshot(self, path, copy=True):
        path = Path(path).expanduser().resolve()
        if not path.is_file():
            raise ValueError(f"Not a file: {path}")
        size = path.stat().st_size
        suffix = path.suffix.lower()
        suffix = suffix if re.fullmatch(r"\.[a-z0-9]{1,12}", suffix) else ".bin"
        # Hash the same bytes that get copied, so a source edit cannot mismatch them.
        if copy:
            self.folder.mkdir(parents=True, exist_ok=True)
            (self.folder / "files").mkdir(exist_ok=True)
            fd, temp = tempfile.mkstemp(dir=self.folder / "files", prefix=".capture-")
            h = hashlib.sha256()
            try:
                with path.open("rb") as source, os.fdopen(fd, "wb") as target:
                    for block in iter(lambda: source.read(1024 * 1024), b""):
                        h.update(block)
                        target.write(block)
                sha = h.hexdigest()
                dest = self.folder / "files" / (sha + suffix)
                os.replace(temp, dest)
            finally:
                if os.path.exists(temp):
                    os.unlink(temp)
            stored = str(dest.relative_to(self.folder))
            size = dest.stat().st_size
        else:
            sha, stored = digest(path), None
        return {"name": path.name, "source_path": str(path), "sha256": sha,
                "bytes": size, "snapshot": stored}

    def raw_path(self, ref):
        return self.folder / ref["snapshot"] if ref.get("snapshot") else Path(ref["source_path"])

    def text(self, ref):
        return self.raw_path(ref).read_text(encoding="utf-8", errors="replace")

    def append(self, kind, data):
        return self.append_many([(kind, data)])[0]

    def append_many(self, entries):
        with self.lock():
            if not (self.folder / "manifest.json").exists():
                raise ValueError("Start this revision first")
            records = self.events()
            ids = []
            for kind, data in entries:
                event_id = f"E{len(records) + 1:06d}"
                record = {"event_id": event_id, "recorded_at": now(), "kind": kind,
                          "revision": self.revision, "data": data}
                self.validate_links(record, records)
                with (self.folder / "events.jsonl").open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps(record, ensure_ascii=False) + "\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                records.append(record)
                ids.append(event_id)
            self.render(records)
            return ids

    @staticmethod
    def validate_links(record, records):
        data = record["data"]
        by_id = {e["event_id"]: e for e in records}
        for field, expected in (("call_id", "tool_call"), ("artifact_id", "artifact"),
                                ("context_id", "context")):
            if data.get(field) and by_id.get(data[field], {}).get("kind") != expected:
                raise ValueError(f"Unknown {field}: {data[field]}")
        if record["kind"] == "tool_result":
            if any(e["kind"] == "tool_result" and e["data"]["call_id"] == data["call_id"] for e in records):
                raise ValueError("Call already has a result; retries need a new call")
        if record["kind"] == "image" and data.get("call_id"):
            if not any(e["kind"] == "tool_result" and e["data"]["call_id"] == data["call_id"] for e in records):
                raise ValueError("Record the actual tool result before its delivered images")

    def context(self):
        return next((e["event_id"] for e in reversed(self.events()) if e["kind"] == "context"), None)

    def call(self, tool, request, codes=()):
        return self.append("tool_call", {"tool": tool, "request": request,
                           "context_id": self.context(),
                           "code": [self.snapshot(p) for p in codes], "started_at": now()})

    def result(self, call_id, status, files=(), **extra):
        return self.append("tool_result", {"call_id": call_id, "status": status,
                           "finished_at": now(), "files": [self.snapshot(p) for p in files], **extra})

    def checks(self, records):
        problems = []
        contexts = {e["event_id"]: e["data"] for e in records if e["kind"] == "context"}
        if not contexts:
            problems.append("Missing runtime model context")
        calls = {e["event_id"]: e for e in records if e["kind"] == "tool_call"}
        results = {e["data"]["call_id"]: e for e in records if e["kind"] == "tool_result"}
        for call_id, call in calls.items():
            if call_id not in results:
                problems.append(f"Pending tool call: {call_id}")
            model = contexts.get(call["data"].get("context_id"), {})
            if model.get("evidence_status") != "runtime_reported":
                problems.append(f"Unconfirmed actual model: {call_id}")
        if not any(e["kind"] == "prompt" for e in records):
            problems.append("Missing visible task prompt")
        artifacts = [e for e in records if e["kind"] == "artifact"]
        if not artifacts:
            problems.append("Missing revision deliverable")
        validations = {}
        for event in records:
            if event["kind"] == "verification":
                validations[event["data"]["artifact_id"]] = event["data"]["outcome"]
        if not validations:
            problems.append("Missing verification linked to a deliverable")
        for artifact_id, outcome in validations.items():
            if outcome != "pass":
                problems.append(f"Unresolved verification: {artifact_id} ({outcome})")
        for event in records:
            if event["kind"] == "gap":
                problems.append(f"Declared recording gap: {event['data']['text']}")
            self.validate_links(event, records[:int(event["event_id"][1:]) - 1])
            for ref in file_refs(event["data"]):
                path = self.raw_path(ref)
                if not path.is_file() or digest(path) != ref["sha256"]:
                    problems.append(f"Missing/changed recorded file: {ref['name']} ({event['event_id']})")
        return list(dict.fromkeys(problems))

    def render(self, records=None):
        records = self.events() if records is None else records
        manifest = json.loads((self.folder / "manifest.json").read_text())
        closed = records[-1] if records and records[-1]["kind"] == "finish" else None
        state = closed["data"]["trace_status"] if closed else "recording"
        export = {**manifest, "trace_status": state, "updated_at": now(), "events": records}
        atomic(self.folder / "interaction.json", dump(export) + "\n")
        sections, transcript = [], []
        for event in records:
            data = event["data"]
            title = f"{event['event_id']} · {event['recorded_at']} · {event['kind']}"
            body = "<pre>" + html.escape(dump(data)) + "</pre>"
            transcript.extend([title, dump(data)])
            for ref in file_refs(data):
                path = self.raw_path(ref)
                href = quote(ref["snapshot"]) if ref.get("snapshot") else path.as_uri()
                label = html.escape(ref["name"])
                body += f'<p><a href="{href}">{label}</a> · SHA256 <small>{ref["sha256"]}</small></p>'
                if event["kind"] == "image":
                    body += f'<a href="{href}"><img loading="lazy" src="{href}" alt="{label}"></a>'
                elif ref.get("snapshot") and path.suffix in (".txt", ".json", ".py", ".js", ".mjs", ".sh", ".md", ".log"):
                    text = self.text(ref)
                    transcript.append(text)
                    preview = text if len(text) <= 200000 else text[:200000] + "\n[页面预览截断；上方链接保留完整原文]"
                    body += f'<details><summary>{label} 原文</summary><pre>{html.escape(preview)}</pre></details>'
            sections.append(f'<section id="{event["event_id"]}"><h2>{html.escape(title)}</h2>{body}</section>')
        models = sorted({e["data"]["model"] for e in records if e["kind"] == "context" and e["data"].get("model")})
        heading = f'{self.revision} · {state} · {", ".join(models) or "实际模型未确认"}'
        intro = ('<p>按执行顺序持续写入的可见交互。时间为 UTC（ISO 8601）。'
                 'tool_call.context_id 关联实际模型；tool_result.call_id 关联调用；'
                 'verification.artifact_id 关联产物。source 图片不等同于模型实际收到的 payload。'
                 '记录完整性不代表 LOD 验收或 Human Accept。</p>'
                 '<p><a href="../index.html">所有 R 版本</a> · <a href="interaction.json">JSON</a> · '
                 '<a href="interaction.txt">完整文本</a> · <a href="events.jsonl">追加日志</a></p>')
        atomic(self.folder / "interaction.txt", heading + "\n\n" + "\n\n".join(transcript) + "\n")
        atomic(self.folder / "index.html", page(heading, intro + "".join(sections)))
        rows = []
        for file in sorted(self.root.glob("*/interaction.json"), key=lambda p: revision_key(p.parent.name)):
            item = json.loads(file.read_text())
            rows.append(f'<li><a href="{quote(file.parent.name)}/index.html">{html.escape(file.parent.name)}</a> · '
                        f'{html.escape(item["trace_status"])} · {html.escape(item["updated_at"])}</li>')
        atomic(self.root / "index.html", page("建模交互 · R 版本索引", "<ul>" + "".join(rows) + "</ul>"))


def revision_key(name):
    return tuple(int(n) for n in re.findall(r"\d+", name))


def file_refs(value):
    if isinstance(value, dict):
        if "sha256" in value and "source_path" in value and "snapshot" in value:
            yield value
        else:
            for child in value.values():
                yield from file_refs(child)
    elif isinstance(value, list):
        for child in value:
            yield from file_refs(child)


def page(title, body):
    return ('<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{html.escape(title)}</title><style>'
            'body{max-width:1150px;margin:40px auto;padding:0 24px;font:15px/1.65 system-ui;color:#182434;background:#f5f7fa}'
            'h1{font-size:25px}h2{font-size:17px}section{margin:24px 0;padding:20px;background:white;border:1px solid #dce2e9;border-radius:12px}'
            'pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:14px;background:#f1f4f8;font:13px/1.6 monospace}'
            'img{max-width:100%;max-height:700px;object-fit:contain}small{overflow-wrap:anywhere}a{color:#195fad}'
            f'</style><h1>{html.escape(title)}</h1>{body}</html>')


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--project", required=True)
    p.add_argument("--revision", required=True)
    sub = p.add_subparsers(dest="action", required=True)
    start = sub.add_parser("start")
    start.add_argument("--prompt-file", required=True)
    start.add_argument("--base-revision")
    start.add_argument("--session-log")
    start.add_argument("--turn-id")
    context = sub.add_parser("context")
    context.add_argument("--session-log", required=True)
    context.add_argument("--turn-id")
    prompt = sub.add_parser("prompt")
    prompt.add_argument("--file", required=True)
    prompt.add_argument("--kind", choices=["user", "goal", "review", "continuation"], default="user")
    message = sub.add_parser("message")
    message.add_argument("--file", required=True)
    message.add_argument("--phase", choices=["commentary", "final"], default="commentary")
    image = sub.add_parser("image")
    image.add_argument("--file", required=True)
    image.add_argument("--batch", required=True)
    image.add_argument("--call-id", required=True)
    image.add_argument("--representation", required=True, choices=["payload", "source"])
    image.add_argument("--prompt-id")
    call = sub.add_parser("call")
    call.add_argument("--tool", required=True)
    call.add_argument("--request-file", required=True, help="JSON object containing actual tool arguments")
    call.add_argument("--code", action="append", default=[])
    result = sub.add_parser("result")
    result.add_argument("--call-id", required=True)
    result.add_argument("--status", required=True, choices=["success", "error", "interrupted"])
    result.add_argument("--file", action="append", default=[])
    result.add_argument("--response-json", help="Actual MCP response: snapshot and extract image payloads")
    result.add_argument("--batch")
    run = sub.add_parser("run")
    run.add_argument("--cwd")
    run.add_argument("--code", action="append", default=[])
    run.add_argument("--timeout", type=float)
    run.add_argument("argv", nargs=argparse.REMAINDER)
    artifact = sub.add_parser("artifact")
    artifact.add_argument("--file", required=True)
    artifact.add_argument("--kind", required=True)
    artifact.add_argument("--call-id", required=True)
    artifact.add_argument("--snapshot", action="store_true", help="Also copy large deliverables; small files always copied")
    verification = sub.add_parser("verification")
    verification.add_argument("--file", required=True)
    verification.add_argument("--artifact-id", required=True)
    verification.add_argument("--call-id", required=True)
    verification.add_argument("--outcome", required=True, choices=["pass", "fail", "inconclusive"])
    gap = sub.add_parser("gap")
    gap.add_argument("--text", required=True)
    finish = sub.add_parser("finish")
    finish.add_argument("--summary-file", required=True)
    for name in ("check", "render"):
        sub.add_parser(name)
    return p


def run_command(tracker, args):
    argv = args.argv[1:] if args.argv[:1] == ["--"] else args.argv
    if not argv:
        raise ValueError("run requires -- followed by a command argument array")
    cwd = str(Path(args.cwd or tracker.project).expanduser().resolve())
    call_id = tracker.call("subprocess", {"argv": argv, "cwd": cwd, "timeout": args.timeout}, args.code)
    live = tracker.folder / "running" / call_id
    live.mkdir(parents=True)
    stdout, stderr = live / "stdout.txt", live / "stderr.txt"
    status, returncode, error = "success", None, None
    process = None
    with stdout.open("wb") as out, stderr.open("wb") as err:
        try:
            process = subprocess.Popen(argv, cwd=cwd, stdout=out, stderr=err, start_new_session=True)
            returncode = process.wait(timeout=args.timeout)
            status = "success" if returncode == 0 else "error"
        except (KeyboardInterrupt, subprocess.TimeoutExpired, OSError) as exc:
            status = "interrupted" if isinstance(exc, KeyboardInterrupt) else "error"
            error = str(exc) or type(exc).__name__
            if process and process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            returncode = process.returncode if process else 127
    tracker.result(call_id, status, [stdout, stderr], exit_code=returncode, error=error)
    print(dump({"call_id": call_id, "status": status, "exit_code": returncode,
                "stdout": str(stdout), "stderr": str(stderr), "review": str(tracker.folder / "index.html")}))
    return 0 if status == "success" else (returncode if returncode and returncode > 0 else 1)


def main(argv=None):
    args = parser().parse_args(argv)
    tracker = Tracker(args.project, args.revision)
    action = args.action
    if action == "start":
        # Validate first, so a bad argument does not leave a half-initialized round.
        prompt = tracker.snapshot(args.prompt_file)
        context = latest_context(args.session_log) if args.session_log else {
            "model": None, "source": None, "evidence_status": "unconfirmed"}
        if args.turn_id and context.get("turn_id") != args.turn_id:
            raise ValueError("Runtime turn_id does not match the active turn")
        with tracker.lock():
            manifest = tracker.folder / "manifest.json"
            if manifest.exists():
                raise ValueError("Revision already exists; append context/prompt to resume, never overwrite")
            atomic(manifest, dump({"schema_version": 1, "revision": args.revision,
                                  "base_revision": args.base_revision,
                                  "project_root": str(tracker.project), "started_at": now(),
                                  "coverage": "visible interactions recorded live; not raw API requests"}) + "\n")
        ids = tracker.append_many([("context", context), ("prompt", {"prompt_kind": "user", "file": prompt})])
    elif action == "context":
        context = latest_context(args.session_log)
        if args.turn_id and context.get("turn_id") != args.turn_id:
            raise ValueError("Runtime turn_id does not match the active turn")
        ids = [tracker.append("context", context)]
    elif action in ("prompt", "message"):
        field, value = ("prompt_kind", args.kind) if action == "prompt" else ("phase", args.phase)
        ids = [tracker.append(action, {field: value, "file": tracker.snapshot(args.file)})]
    elif action == "image":
        ids = [tracker.append("image", {"file": tracker.snapshot(args.file), "batch": args.batch,
                    "call_id": args.call_id, "prompt_id": args.prompt_id,
                    "representation": args.representation})]
    elif action == "call":
        request = json.loads(Path(args.request_file).read_text(encoding="utf-8"))
        if not isinstance(request, dict):
            raise ValueError("Tool arguments must be a JSON object")
        ids = [tracker.call(args.tool, request, args.code)]
    elif action == "result":
        files = list(args.file)
        images = []
        if args.response_json:
            if not args.batch:
                raise ValueError("--response-json requires --batch (even if response has no images)")
            response = json.loads(Path(args.response_json).read_text(encoding="utf-8"))
            files.append(args.response_json)
            for content in response.get("content", []):
                if content.get("type") == "image":
                    mime = content.get("mimeType", "image/png")
                    suffix = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}.get(mime)
                    if not suffix:
                        raise ValueError(f"Unsupported image payload MIME: {mime}")
                    folder = tracker.folder / "running" / args.call_id
                    folder.mkdir(parents=True, exist_ok=True)
                    path = folder / (uuid.uuid4().hex + suffix)
                    path.write_bytes(base64.b64decode(content["data"], validate=True))
                    images.append(path)
        if not files:
            raise ValueError("Record a real response file, including for failed calls")
        ids = [tracker.result(args.call_id, args.status, files)]
        for path in images:
            ids.append(tracker.append("image", {"file": tracker.snapshot(path), "batch": args.batch,
                         "call_id": args.call_id, "representation": "payload"}))
    elif action == "run":
        return run_command(tracker, args)
    elif action == "artifact":
        file = Path(args.file)
        ids = [tracker.append("artifact", {"file": tracker.snapshot(file, args.snapshot or file.stat().st_size <= 8 * 1024 * 1024),
                    "artifact_kind": args.kind, "call_id": args.call_id})]
    elif action == "verification":
        ids = [tracker.append("verification", {"file": tracker.snapshot(args.file),
                    "artifact_id": args.artifact_id, "call_id": args.call_id, "outcome": args.outcome})]
    elif action == "gap":
        ids = [tracker.append("gap", {"text": args.text})]
    elif action == "finish":
        problems = tracker.checks(tracker.events())
        ids = [tracker.append("finish", {"summary": tracker.snapshot(args.summary_file),
                    "trace_status": "complete" if not problems else "partial", "recording_gaps": problems})]
    elif action == "check":
        problems = tracker.checks(tracker.events())
        print(dump({"ok": not problems, "problems": problems}))
        return 1 if problems else 0
    elif action == "render":
        with tracker.lock():
            tracker.render()
        ids = []
    print(dump({"event_ids": ids, "review": str(tracker.folder / "index.html")}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print(f"tracking: {exc}", file=sys.stderr)
        sys.exit(2)
