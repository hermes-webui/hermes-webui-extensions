#!/usr/bin/env python3
"""
Docker & Tunnel Manager — Sidecar
Provides a local REST API for Docker operations and Cloudflare tunnel status.
Binds to 127.0.0.1:17900 (no network exposure).
Requires: python3, docker-py, cloudflared CLI, docker group membership.
"""

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

SIDECAR_PORT = int(os.environ.get("DTM_SIDECAR_PORT", "17900"))
CLOUDFLARED_CONFIG = os.path.expanduser("~/.cloudflared/config.yml")
TUNNEL_NAME = "codeovertcp"


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
            self._json({"error": "not found"}, 404)
        except Exception as e:
            self._err(e)

    # ── Docker helpers ──────────────────────────────────────────────

    def _docker(self):
        return docker.from_env()

    # ── Handlers ────────────────────────────────────────────────────

    def _handle_health(self):
        self._json({"status": "ok", "version": "0.1.0"})

    def _handle_containers(self):
        dc = self._docker()
        result = []
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
                try:
                    s = c.stats(stream=False)
                    cd = s["cpu_stats"]["cpu_usage"]["total_usage"] - s["precpu_stats"]["cpu_usage"]["total_usage"]
                    sd = s["cpu_stats"]["system_cpu_usage"] - s["precpu_stats"]["system_cpu_usage"]
                    nc = s["cpu_stats"]["online_cpus"] or 1
                    info["cpu_pct"] = round((cd / sd) * nc * 100, 1) if sd > 0 else 0
                    mu = s["memory_stats"].get("usage", 0)
                    ml = s["memory_stats"].get("limit", 1)
                    info["mem_human"] = fmt_size(mu)
                    info["mem_pct"] = round(mu / ml * 100, 1) if ml else 0
                except Exception:
                    info["cpu_pct"] = None
                    info["mem_pct"] = None
                    info["mem_human"] = ""
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

    def _handle_tunnels(self):
        result = {"tunnels": []}
        if not os.path.exists(CLOUDFLARED_CONFIG):
            self._json({"tunnels": [], "error": "config not found"})
            return
        # Parse ingress
        ingress = []
        with open(CLOUDFLARED_CONFIG) as f:
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
        # Get tunnel info
        try:
            r = subprocess.run(["cloudflared", "tunnel", "info", TUNNEL_NAME],
                               capture_output=True, text=True, timeout=10)
            info = {"name": TUNNEL_NAME, "id": "", "connectors": [], "ingress": ingress}
            for line in r.stdout.splitlines():
                line = line.strip()
                if "ID:" in line and "CONNECTOR" not in line:
                    info["id"] = line.split("ID:")[-1].strip()
                elif line.startswith(" ") and len(line) > 40:
                    parts = line.split()
                    if len(parts) >= 6:
                        info["connectors"].append({"id": parts[0], "age": parts[2], "origin": parts[-2]})
            # Try to get connector count from tunnel list
            try:
                r2 = subprocess.run(["cloudflared", "tunnel", "list"],
                                    capture_output=True, text=True, timeout=10)
                m = re.search(r'(\d+)\s+connector', r2.stdout)
                info["connector_count"] = int(m.group(1)) if m else len(info["connectors"])
            except Exception:
                info["connector_count"] = len(info["connectors"])
            result["tunnels"].append(info)
        except Exception as e:
            result["error"] = f"cloudflared failed: {e}"
        self._json(result)

    def _get_tunnel_info(self):
        """Return parsed tunnel info dict (no HTTP)."""
        result = {"tunnels": []}
        if not os.path.exists(CLOUDFLARED_CONFIG):
            return result
        ingress = []
        with open(CLOUDFLARED_CONFIG) as f:
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
        try:
            r = subprocess.run(["cloudflared", "tunnel", "info", TUNNEL_NAME],
                               capture_output=True, text=True, timeout=10)
            info = {"name": TUNNEL_NAME, "id": "", "connectors": [], "ingress": ingress}
            for line in r.stdout.splitlines():
                line = line.strip()
                if "ID:" in line and "CONNECTOR" not in line:
                    info["id"] = line.split("ID:")[-1].strip()
                elif line.startswith(" ") and len(line) > 40:
                    parts = line.split()
                    if len(parts) >= 6:
                        info["connectors"].append({"id": parts[0], "age": parts[2], "origin": parts[-2]})
            result["tunnels"].append(info)
        except Exception:
            pass
        return result

    def _handle_tunnel_health(self):
        tun_info = self._get_tunnel_info()
        routes = []
        for tun in tun_info.get("tunnels", []):
            for ing in tun.get("ingress", []):
                hostname = ing.get("hostname", "")
                url = f"https://{hostname}/"
                start = time.time()
                try:
                    r = subprocess.run(
                        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                         "--connect-timeout", "5", "--max-time", "10", url],
                        capture_output=True, text=True, timeout=12
                    )
                    latency = round(time.time() - start, 2)
                    code = r.stdout.strip()
                    status = "ok"
                    if code in ("401", "403"):
                        status = "authed"
                    elif code in ("502", "503", "000", ""):
                        status = "error"
                    elif code in ("301", "302", "307", "308"):
                        status = "redirect"
                    routes.append({"hostname": hostname, "service": ing.get("service", ""),
                                   "status": status, "http_code": code, "latency": latency})
                except subprocess.TimeoutExpired:
                    routes.append({"hostname": hostname, "service": ing.get("service", ""),
                                   "status": "timeout", "http_code": "", "latency": 10.0})
                except Exception:
                    routes.append({"hostname": hostname, "service": ing.get("service", ""),
                                   "status": "error", "http_code": "", "latency": 0})
        self._json({"routes": routes, "checked_at": time.strftime("%H:%M:%S")})

    def _handle_tunnel_logs(self, lines=50):
        try:
            r = subprocess.run(
                ["journalctl", "--user", "-u", "gto-wizard-tunnel.service",
                 "--no-pager", "-n", str(lines)],
                capture_output=True, text=True, timeout=10
            )
            self._json({"logs": r.stdout, "lines": len(r.stdout.splitlines())})
        except Exception as e:
            self._err(f"journalctl failed: {e}")

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
