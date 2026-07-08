#!/usr/bin/env python3
"""
Docker & Tunnel Manager — Sidecar
Provides a local REST API for Docker operations and Cloudflare tunnel status.
Binds to 127.0.0.1:17900 (no network exposure).
Requires: python3, docker-py, cloudflared CLI, docker group membership.
"""

import io
import json
import os
import re
import subprocess
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs

try:
    import docker
except ImportError:
    print("ERROR: docker-py not installed. Run: pip3 install docker")
    sys.exit(1)

import concurrent.futures

# ── CloudflareAdapter (inlined — was tunnel_adapter.py) ───────────────

class CloudflareAdapter:
    """Wraps the cloudflared CLI for tunnel list/health/logs."""

    def __init__(self, config_path="~/.cloudflared/config.yml",
                 tunnel_name="codeovertcp",
                 log_service="gto-wizard-tunnel.service"):
        self.config_path = os.path.expanduser(config_path)
        self.tunnel_name = tunnel_name
        self.log_service = log_service

    def _parse_ingress(self):
        ingress = []
        if not os.path.exists(self.config_path):
            return ingress
        with open(self.config_path) as f:
            in_ing = False
            for line in f:
                s = line.strip()
                if s == "ingress:":
                    in_ing = True
                    continue
                if in_ing:
                    if s.startswith("- hostname:"):
                        ingress.append({"hostname": s.split(":", 1)[-1].strip(), "service": "?"})
                    elif s.startswith("service:") and ingress:
                        ingress[-1]["service"] = s.split(":", 1)[-1].strip()
                    elif not s.startswith("- ") and not s.startswith("  "):
                        break
        return ingress

    def _run_tunnel_info(self):
        try:
            r = subprocess.run(
                ["cloudflared", "tunnel", "info", self.tunnel_name],
                capture_output=True, text=True, timeout=10,
            )
        except Exception:
            return None
        info = {"name": self.tunnel_name, "id": "", "connectors": [],
                "ingress": self._parse_ingress()}
        for line in r.stdout.splitlines():
            line = line.strip()
            if "ID:" in line and "CONNECTOR" not in line:
                info["id"] = line.split("ID:")[-1].strip()
            elif line.startswith(" ") and len(line) > 40:
                parts = line.split()
                if len(parts) >= 6:
                    info["connectors"].append({
                        "id": parts[0], "age": parts[2],
                        "origin": parts[-2],
                    })
        return info

    def _get_connector_count(self):
        try:
            r = subprocess.run(
                ["cloudflared", "tunnel", "list"],
                capture_output=True, text=True, timeout=10,
            )
            m = re.search(r'(\\d+)\\s+connector', r.stdout)
            if m:
                return int(m.group(1))
        except Exception:
            pass
        return None

    def list_tunnels(self):
        if not os.path.exists(self.config_path):
            return []
        info = self._run_tunnel_info()
        if info is None:
            return []
        cc = self._get_connector_count()
        info["connector_count"] = cc if cc is not None else len(info.get("connectors", []))
        return [info]

    def tunnel_health(self, tunnel_name):
        info = self._run_tunnel_info()
        if info is None:
            return []
        ingress = info.get("ingress", [])

        def check(ing):
            hostname = ing.get("hostname", "")
            url = f"https://{hostname}/"
            start = time.time()
            try:
                r = subprocess.run(
                    ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                     "--connect-timeout", "3", "--max-time", "6", url],
                    capture_output=True, text=True, timeout=8,
                )
                latency = round(time.time() - start, 2)
                code = r.stdout.strip()
                if code in ("401", "403"):
                    status = "authed"
                elif code in ("502", "503", "000", ""):
                    status = "error"
                elif code in ("301", "302", "307", "308"):
                    status = "redirect"
                else:
                    status = "ok"
                return {"hostname": hostname, "service": ing.get("service", ""),
                        "status": status, "http_code": code, "latency": latency}
            except subprocess.TimeoutExpired:
                return {"hostname": hostname, "service": ing.get("service", ""),
                        "status": "timeout", "http_code": "", "latency": 6.0}
            except Exception:
                return {"hostname": hostname, "service": ing.get("service", ""),
                        "status": "error", "http_code": "", "latency": 0}

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
            return list(ex.map(check, ingress))

    def tunnel_logs(self, tunnel_name, lines=50):
        try:
            r = subprocess.run(
                ["journalctl", "--user", "-u", self.log_service,
                 "--no-pager", "-n", str(lines)],
                capture_output=True, text=True, timeout=10,
            )
            return r.stdout
        except Exception as e:
            return f"journalctl failed: {e}"


SIDECAR_PORT = int(os.environ.get("DTM_SIDECAR_PORT", "17900"))
CLOUDFLARED_CONFIG = os.path.expanduser("~/.cloudflared/config.yml")
TUNNEL_NAME = "codeovertcp"
_tunnel_adapter = CloudflareAdapter(
    config_path=CLOUDFLARED_CONFIG,
    tunnel_name=TUNNEL_NAME,
)


def fmt_size(b):
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if b < 1024:
            return f"{b:.1f}{unit}" if unit != "B" else f"{b}B"
        b /= 1024
    return f"{b:.1f}PB"


class DockerTunnelHandler(BaseHTTPRequestHandler):

    # ── CORS ────────────────────────────────────────────────────────

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _err(self, msg, status=500):
        self._json({"error": str(msg)}, status)

    # ── Routing ─────────────────────────────────────────────────────

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        parts = path.split("/")
        qs = parse_qs(parsed.query)
        try:
            if path == "/api/health":
                return self._handle_health()
            elif path == "/api/containers":
                return self._handle_containers()
            elif path == "/api/images":
                return self._handle_images()
            elif path == "/api/system/df":
                return self._handle_system_df()
            elif path == "/api/tunnels":
                return self._handle_tunnels()
            elif path == "/api/tunnels/health":
                return self._handle_tunnel_health()
            elif path == "/api/tunnels/logs":
                return self._handle_tunnel_logs(int(qs.get("lines", ["50"])[0]))
            elif path == "/api/volumes":
                return self._handle_volumes()
            elif path == "/api/compose":
                return self._handle_compose()
            elif len(parts) >= 5 and parts[1:4] == ["api", "images"] and parts[4] == "history":
                return self._handle_image_history(parts[3])
            elif len(parts) >= 5 and parts[1:4] == ["api", "containers"] and parts[4] == "logs":
                tail = int(qs.get("tail", ["100"])[0])
                follow = qs.get("follow", ["true"])[0].lower() != "false"
                return self._handle_container_logs(parts[3], tail=tail, follow=follow)
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:
            self._err(e)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        parts = path.split("/")
        try:
            if len(parts) == 5 and parts[1:3] == ["api", "containers"]:
                if parts[4] in ("start", "stop", "restart"):
                    return self._handle_container_action(parts[3], parts[4])
            if parts[1:4] == ["api", "containers", "prune"]:
                return self._handle_prune_containers()
            if parts[1:4] == ["api", "images", "prune"]:
                return self._handle_prune_images()
            if parts[1:4] == ["api", "system", "prune"]:
                return self._handle_system_prune()
            if parts[1:4] == ["api", "volumes", "prune"]:
                return self._handle_prune_volumes()
            if len(parts) == 5 and parts[1:4] == ["api", "volumes"] and parts[4] == "delete":
                return self._handle_volume_delete(parts[3])
            self._json({"error": "not found"}, 404)
        except Exception as e:
            self._err(e)

    # ── Docker helpers ──────────────────────────────────────────────

    def _docker(self):
        return docker.from_env()

    # ── Handlers ────────────────────────────────────────────────────

    def _handle_health(self):
        self._json({"status": "ok", "version": "0.2.0"})

    def _handle_containers(self):
        dc = self._docker()
        result = []
        # Stats via docker CLI — single call instead of per-container docker-py
        stats_map = {}
        try:
            out = subprocess.check_output(
                ["docker", "stats", "--no-stream", "--format", "{{json .}}"],
                timeout=10, stderr=subprocess.DEVNULL, text=True,
            )
            for line in out.strip().split("\n"):
                if line.startswith("{"):
                    try:
                        s = json.loads(line)
                        stats_map[s.get("Container", "")] = s
                    except json.JSONDecodeError:
                        pass
        except Exception:
            pass

        for c in dc.containers.list(all=True):
            ports = []
            if c.ports:
                for cp, mappings in c.ports.items():
                    if mappings:
                        for m in mappings:
                            ports.append(f"{m.get('HostPort','?')}→{cp}")
                    else:
                        ports.append(cp)
            info = {
                "id": c.short_id,
                "name": c.name,
                "image": c.image.tags[0] if c.image.tags else c.image.id[:19],
                "status": c.status,
                "state": c.status.lower(),
                "ports": ", ".join(ports) if ports else "",
            }
            if c.status == "running":
                raw = stats_map.get(c.short_id) or stats_map.get(c.name)
                if raw:
                    try:
                        cp = raw.get("CPUPerc", "0%").replace("%", "")
                        info["cpu_pct"] = round(float(cp), 1)
                        mu = raw.get("MemUsage", "0B / 0B").split(" / ")[0].strip()
                        info["mem_human"] = mu
                        ml = raw.get("MemPerc", "0%").replace("%", "0")
                        info["mem_pct"] = round(float(ml), 1) if ml else 0
                    except (ValueError, IndexError):
                        pass
                info.setdefault("cpu_pct", None)
                info.setdefault("mem_human", "")
                info.setdefault("mem_pct", None)
            result.append(info)
        self._json({"containers": result, "count": len(result)})

    def _handle_container_action(self, cid, action):
        try:
            c = self._docker().containers.get(cid)
            getattr(c, action)()
            self._json({"success": True, "action": action, "container": cid})
        except docker.errors.NotFound:
            self._json({"error": f"container '{cid}' not found"}, 404)
        except Exception as e:
            self._err(f"{action} failed: {e}")

    def _handle_prune_containers(self):
        r = self._docker().containers.prune()
        self._json({
            "containers_pruned": len(r.get("ContainersDeleted", [])),
            "space_reclaimed": r.get("SpaceReclaimed", 0),
            "space_human": fmt_size(r.get("SpaceReclaimed", 0)),
        })

    def _handle_images(self):
        dc = self._docker()
        result = []
        all_conts = dc.containers.list(all=True)
        for img in dc.images.list(all=True):
            used = sum(1 for c in all_conts if img.id in (c.image.id or ""))
            result.append({
                "id": img.id[:19],
                "tags": img.tags or ["<none>:<none>"],
                "size_bytes": img.attrs.get("Size", 0),
                "size_human": fmt_size(img.attrs.get("Size", 0)),
                "containers": used,
            })
        total = sum(i["size_bytes"] for i in result)
        self._json({"images": result, "count": len(result), "total_size_human": fmt_size(total)})

    def _handle_prune_images(self):
        r = self._docker().images.prune()
        self._json({
            "images_pruned": len(r.get("ImagesDeleted", [])),
            "space_reclaimed": r.get("SpaceReclaimed", 0),
            "space_human": fmt_size(r.get("SpaceReclaimed", 0)),
        })

    def _handle_system_df(self):
        df = self._docker().df()
        cats = [
            ("images", "Images"),
            ("containers", "Containers"),
            ("volumes", "Volumes"),
            ("build_cache", "BuildCache"),
        ]
        result = {"layers_size": df.get("LayersSize", 0), "layers_human": fmt_size(df.get("LayersSize", 0))}
        for key, df_key in cats:
            items = df.get(df_key, [])
            size = 0
            reclaim = 0
            for item in items:
                s = item.get("Size", 0) or 0
                size += s
                if s and _is_reclaimable(key, item):
                    reclaim += s
            result[key] = {
                "count": len(items),
                "size": size,
                "size_human": fmt_size(size),
                "reclaimable": reclaim,
                "reclaimable_human": fmt_size(reclaim),
            }
        self._json(result)

    def _handle_system_prune(self):
        dc = self._docker()
        total = 0
        for p in (dc.containers.prune, dc.images.prune, dc.networks.prune):
            try:
                total += p().get("SpaceReclaimed", 0)
            except Exception:
                pass
        self._json({"success": True, "space_reclaimed": total, "space_human": fmt_size(total)})

    # ── Volume Handlers ──────────────────────────────────────────────

    def _handle_volumes(self):
        dc = self._docker()
        result = []
        # map volume name -> list of container names using it
        all_conts = dc.containers.list(all=True)
        vol_users = {}
        for c in all_conts:
            mounts = c.attrs.get("Mounts", [])
            for m in mounts:
                if m.get("Type") == "volume":
                    vname = m.get("Name", "")
                    if vname:
                        vol_users.setdefault(vname, []).append(c.name)
        for vol in dc.volumes.list():
            vname = vol.name
            usage = vol.attrs.get("UsageData", {})
            result.append({
                "name": vname,
                "driver": vol.attrs.get("Driver", "local"),
                "mountpoint": vol.attrs.get("Mountpoint", ""),
                "size_bytes": usage.get("Size", -1),
                "size_human": fmt_size(usage.get("Size", 0)) if usage.get("Size", -1) >= 0 else "N/A",
                "ref_count": usage.get("RefCount", 0),
                "container_count": len(vol_users.get(vname, [])),
                "containers": sorted(vol_users.get(vname, [])),
                "created": vol.attrs.get("CreatedAt", ""),
            })
        self._json({"volumes": result, "count": len(result)})

    def _handle_prune_volumes(self):
        r = self._docker().volumes.prune()
        self._json({
            "volumes_pruned": len(r.get("VolumesDeleted", [])),
            "space_reclaimed": r.get("SpaceReclaimed", 0),
            "space_human": fmt_size(r.get("SpaceReclaimed", 0)),
        })

    def _handle_volume_delete(self, name):
        try:
            vol = self._docker().volumes.get(name)
            vol.remove()
            self._json({"success": True, "volume": name})
        except docker.errors.NotFound:
            self._json({"error": f"volume '{name}' not found"}, 404)
        except Exception as e:
            self._err(f"delete volume '{name}' failed: {e}")

    # ── Compose Handler ─────────────────────────────────────────────

    def _handle_compose(self):
        try:
            # discover compose projects via docker ps labels
            r = subprocess.run(
                ["docker", "ps", "--format", '{{.Label "com.docker.compose.project"}}', "--all"],
                capture_output=True, text=True, timeout=10,
            )
            raw = r.stdout.strip()
            if not raw:
                return self._json({"projects": [], "count": 0})
            # deduplicate project names
            projects = list(dict.fromkeys(p for p in raw.splitlines() if p))
            dc = self._docker()
            result = []
            for proj in projects:
                conts = dc.containers.list(
                    all=True,
                    filters={"label": f"com.docker.compose.project={proj}"},
                )
                services = set()
                running = 0
                for c in conts:
                    svc = c.labels.get("com.docker.compose.service", "")
                    if svc:
                        services.add(svc)
                    if c.status == "running":
                        running += 1
                result.append({
                    "project": proj,
                    "container_count": len(conts),
                    "running_count": running,
                    "services": sorted(services),
                })
            self._json({"projects": result, "count": len(result)})
        except Exception as e:
            self._err(f"compose discovery failed: {e}")

    # ── Image History Handler ────────────────────────────────────────

    def _handle_image_history(self, image_id):
        try:
            img = self._docker().images.get(image_id)
            history = img.history()
            result = []
            for layer in history:
                created_by = layer.get("CreatedBy", "") or ""
                result.append({
                    "id": (layer.get("Id", "") or "")[:12],
                    "size_bytes": layer.get("Size", 0),
                    "size_human": fmt_size(layer.get("Size", 0)),
                    "created_by": created_by[:80],
                    "tags": layer.get("Tags", []) or [],
                })
            self._json({"history": result, "count": len(result)})
        except docker.errors.ImageNotFound:
            self._json({"error": f"image '{image_id}' not found"}, 404)
        except Exception as e:
            self._err(f"image history failed: {e}")

    # ── Container Logs (SSE) Handler ────────────────────────────────

    def _handle_container_logs(self, cid, tail=100, follow=True):
        try:
            container = self._docker().containers.get(cid)
        except docker.errors.NotFound:
            self._json({"error": f"container '{cid}' not found"}, 404)
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        # No CORS headers needed for SSE (browser EventSource handles it differently)
        self.end_headers()

        try:
            log_gen = container.logs(stream=True, follow=follow, tail=tail, timestamps=False)
            for chunk in log_gen:
                if isinstance(chunk, bytes):
                    chunk = chunk.decode("utf-8", errors="replace")
                for line in chunk.splitlines():
                    if line:
                        # escape for JSON
                        payload = json.dumps({"line": line})
                        self.wfile.write(f"data: {payload}\n\n".encode())
                        self.wfile.flush()
                if not follow:
                    continue
            # send close event
            self.wfile.write(b"event: close\ndata: {}\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # client disconnected — silent exit
            pass
        except Exception as e:
            try:
                payload = json.dumps({"error": f"log stream error: {e}"})
                self.wfile.write(f"data: {payload}\n\n".encode())
                self.wfile.flush()
            except Exception:
                pass

    # ── Tunnels ──────────────────────────────────────────────────────

    def _handle_tunnels(self):
        tunnels = _tunnel_adapter.list_tunnels()
        if not tunnels:
            if not os.path.exists(CLOUDFLARED_CONFIG):
                return self._json({"tunnels": [], "error": "config not found"})
            return self._json({"tunnels": []})
        self._json({"tunnels": tunnels})

    def _get_tunnel_info(self):
        """Return parsed tunnel info dict (no HTTP). Uses tunnel_adapter."""
        tunnels = _tunnel_adapter.list_tunnels()
        return {"tunnels": tunnels}

    def _handle_tunnel_health(self):
        routes = _tunnel_adapter.tunnel_health(TUNNEL_NAME)
        self._json({"routes": routes, "checked_at": time.strftime("%H:%M:%S")})

    def _handle_tunnel_logs(self, lines=50):
        logs = _tunnel_adapter.tunnel_logs(TUNNEL_NAME, lines=lines)
        if logs.startswith("journalctl failed:"):
            self._err(logs)
        else:
            self._json({"logs": logs, "lines": len(logs.splitlines())})

    def log_message(self, format, *args):
        pass


def _is_reclaimable(category, item):
    if category == "images":
        # 'Containers' field is an integer count of containers using this image
        return item.get("Containers", 0) == 0
    if category == "containers":
        return item.get("State") != "running"
    if category == "volumes":
        return item.get("UsageData", {}).get("RefCount", 1) == 0
    return True  # build cache is always reclaimable


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    allow_reuse_address = True


def main():
    server = ThreadedHTTPServer(("127.0.0.1", SIDECAR_PORT), DockerTunnelHandler)
    print(f"[dtm-sidecar] Listening on http://127.0.0.1:{SIDECAR_PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[dtm-sidecar] Shutting down")
        server.server_close()


if __name__ == "__main__":
    main()
