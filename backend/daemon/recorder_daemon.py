#!/usr/bin/env python3
import asyncio
import collections
import json
import logging
import math
import os
import time
import aiohttp

logging.basicConfig(level=logging.INFO, format='%(asctime)s [rmm-recorder] %(message)s')
log = logging.getLogger('rmm-recorder')

STORAGE_PATH = '/config/.storage/rmm_movement_history.jsonl'
WWW_JSON_PATH = '/config/www/rmm-replay/history_24h.json'
RMM_STORE_PATH = '/config/.storage/radar_map_manager'

RETENTION_SECONDS = 48 * 3600
MIN_SAMPLE_INTERVAL = 0.45
MOVE_THRESHOLD_PCT = 0.16
RAW_THRESHOLD_PCT = 0.35
HEARTBEAT_OCCUPIED = 15.0
HEARTBEAT_EMPTY = 60.0

RADAR_SHORT = {
    'club_apollo_r_pro_1_ld2450': 'apollo',
    'ld2450_tracker': 't1',
    'ld2450_tracker_2': 't2',
}

RADAR_LABELS = {
    'apollo': 'Apollo R-PRO-1 (Lounge/Kitchen)',
    't1': 'LD2450 Tracker 1 (Bedroom/Bath)',
    't2': 'LD2450 Tracker 2 (Office/Entry)',
}


def short_src(src_str: str) -> str:
    if ':' in src_str:
        rname, tid = src_str.split(':', 1)
        return f'{RADAR_SHORT.get(rname.lower(), rname)}:{tid}'
    return src_str


def point_in_poly(x: float, y: float, poly: list) -> bool:
    n = len(poly)
    if n < 3:
        return False
    inside = False
    p1x, p1y = poly[0]
    for i in range(n + 1):
        p2x, p2y = poly[i % n]
        if y > min(p1y, p2y):
            if y <= max(p1y, p2y):
                if x <= max(p1x, p2x):
                    if p1y != p2y:
                        xinters = (y - p1y) * (p2x - p1x) / (p2y - p1y) + p1x
                    if p1x == p2x or x <= xinters:
                        inside = not inside
        p1x, p1y = p2x, p2y
    return inside


def project_raw_point(layout: dict, pt: dict):
    try:
        x_val = float(pt.get('x', 0))
        y_val = float(pt.get('y', 0))
        if not pt.get('is_1d') and abs(x_val) < 100 and abs(y_val) < 100:
            return None
        xm = x_val / 1000.0
        ym = y_val / 1000.0
        if layout.get('mirror_x', False):
            xm = -xm
        ox = float(layout.get('origin_x', 50))
        oy = float(layout.get('origin_y', 50))
        sx = float(layout.get('scale_x', 5))
        sy = float(layout.get('scale_y', 5))
        rot = float(layout.get('rotation', 0))
        base_rad = (rot - 90.0) * math.pi / 180.0
        y_vec_x = math.cos(base_rad)
        y_vec_y = math.sin(base_rad)
        x_vec_x = math.cos(base_rad + (math.pi / 2.0))
        x_vec_y = math.sin(base_rad + (math.pi / 2.0))
        fx = ox + (xm * sx * x_vec_x) + (ym * sy * y_vec_x)
        fy = oy + (xm * sx * x_vec_y) + (ym * sy * y_vec_y)
        return (round(fx, 2), round(fy, 2))
    except Exception:
        return None


class DaemonRecorder:
    def __init__(self):
        self.frames = collections.deque()
        self.pending_lines = []
        self.last_sample_ts = 0.0
        self.last_frame = None
        self.last_flush_ts = 0.0
        self.last_compact_ts = time.time()
        self.exact_start_ts = None
        self.latest_zones = {}
        self.latest_radars = {}
        self.load_initial()

    def load_initial(self):
        if os.path.exists(RMM_STORE_PATH):
            try:
                raw = json.load(open(RMM_STORE_PATH, 'r', encoding='utf-8')).get('data', {})
                self.update_meta(raw)
            except Exception as e:
                log.warning('Failed to read rmm store meta: %s', e)

        if not os.path.exists(STORAGE_PATH):
            return
        cutoff = time.time() - RETENTION_SECONDS
        exact_ts = None
        try:
            with open(STORAGE_PATH, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                        ts = float(obj.get('t', 0))
                        if ts >= cutoff:
                            self.frames.append(obj)
                            if not obj.get('bf') and exact_ts is None:
                                exact_ts = ts
                    except Exception:
                        continue
            self.exact_start_ts = exact_ts
            if self.frames:
                self.last_frame = self.frames[-1]
                self.last_sample_ts = float(self.last_frame.get('t', 0))
            log.info('Loaded %d history frames from disk', len(self.frames))
        except Exception as e:
            log.error('Load error: %s', e)

    def update_meta(self, data: dict):
        maps = data.get('maps') or {}
        m = maps.get('default') or {}
        if m.get('zones'):
            self.latest_zones = m['zones']
        radars = data.get('radars') or {}
        if radars:
            ro = {}
            for rname, rconf in radars.items():
                if rconf.get('map_group', 'default') == 'default':
                    rcode = RADAR_SHORT.get(rname.lower(), rname)
                    ro[rcode] = {
                        'name': rname,
                        'label': RADAR_LABELS.get(rcode, rname),
                        'layout': rconf.get('layout') or {},
                        'paused': bool(rconf.get('paused', False)),
                    }
            self.latest_radars = ro

    def extract_frame(self, data: dict, now: float) -> dict:
        self.update_meta(data)
        maps = data.get('maps') or {}
        m = maps.get('default') or {}
        zones = (m.get('zones') or {}).get('include_zones') or []
        exclude_zones = (m.get('zones') or {}).get('exclude_zones') or []

        def get_zone_label(px: float, py: float) -> str:
            matched = []
            for z in zones:
                pts = z.get('points') or []
                if point_in_poly(px, py, pts):
                    matched.append(z.get('name', ''))
            return ' · '.join(matched) if matched else ''

        fused_out = []
        for t in m.get('targets') or []:
            sources = t.get('sources') or []
            if 'hibernating' in sources or 'unverified' in sources:
                continue
            cnt = t.get('count') or 0
            if cnt <= 0 and 'hold' not in sources:
                continue
            tx = t.get('x')
            ty = t.get('y')
            if tx is None or ty is None:
                continue
            fx, fy = round(float(tx), 2), round(float(ty), 2)
            state = 'hold' if 'hold' in sources else 'active'
            short_srcs = [short_src(s) for s in sources]
            zlabel = get_zone_label(fx, fy)
            entry = {
                'id': t.get('id', 'target_1'),
                'x': fx,
                'y': fy,
                's': state,
                'src': short_srcs,
            }
            if zlabel:
                entry['z'] = zlabel
            fused_out.append(entry)

        raw_out = []
        radars = data.get('radars') or {}
        for r_name, r_conf in radars.items():
            if r_conf.get('map_group', 'default') != 'default' or r_conf.get('paused'):
                continue
            rcode = RADAR_SHORT.get(r_name.lower(), r_name)
            layout = r_conf.get('layout') or {}
            for rt in r_conf.get('targets') or []:
                proj = project_raw_point(layout, rt)
                if not proj:
                    continue
                rx, ry = proj
                if any(point_in_poly(rx, ry, ez.get('points') or []) for ez in exclude_zones):
                    continue
                raw_out.append([rcode, int(rt.get('i', 1)), rx, ry])

        return {
            't': round(now, 1),
            'f': fused_out,
            'r': raw_out,
        }

    def should_record(self, frame: dict, now: float) -> bool:
        prev = self.last_frame
        if prev is None or prev.get('bf'):
            return True
        dt = now - self.last_sample_ts
        f_curr = frame['f']
        f_prev = prev.get('f') or []
        if len(f_curr) != len(f_prev):
            return True
        if dt < MIN_SAMPLE_INTERVAL:
            return False

        prev_map = {t['id']: t for t in f_prev}
        for t in f_curr:
            pt = prev_map.get(t['id'])
            if not pt:
                return True
            if t.get('s') != pt.get('s') or t.get('src') != pt.get('src'):
                return True
            if math.hypot(t['x'] - pt['x'], t['y'] - pt['y']) >= MOVE_THRESHOLD_PCT:
                return True

        if f_curr:
            r_curr = frame.get('r') or []
            r_prev = prev.get('r') or []
            if len(r_curr) != len(r_prev):
                return True
            for rc, rp in zip(r_curr, r_prev):
                if rc[0] != rp[0] or rc[1] != rp[1]:
                    return True
                if math.hypot(rc[2] - rp[2], rc[3] - rp[3]) >= RAW_THRESHOLD_PCT:
                    return True

        heartbeat = HEARTBEAT_OCCUPIED if f_curr else HEARTBEAT_EMPTY
        return dt >= heartbeat

    def on_data(self, data: dict):
        now = time.time()
        frame = self.extract_frame(data, now)
        if self.should_record(frame, now):
            if self.exact_start_ts is None:
                self.exact_start_ts = frame['t']
            self.frames.append(frame)
            self.last_frame = frame
            self.last_sample_ts = now
            self.pending_lines.append(json.dumps(frame, separators=(',', ':')))

            cutoff = now - RETENTION_SECONDS
            while self.frames and self.frames[0].get('t', 0) < cutoff:
                self.frames.popleft()

        if self.pending_lines and (len(self.pending_lines) == 1 or now - self.last_flush_ts >= 3.0):
            self.flush(now)

    def flush(self, now: float):
        self.last_flush_ts = now
        lines = list(self.pending_lines)
        self.pending_lines.clear()
        try:
            os.makedirs(os.path.dirname(STORAGE_PATH), exist_ok=True)
            if (now - self.last_compact_ts) > 900:
                self.last_compact_ts = now
                tmp_s = STORAGE_PATH + '.tmp'
                with open(tmp_s, 'w', encoding='utf-8') as f:
                    for fr in self.frames:
                        f.write(json.dumps(fr, separators=(',', ':')) + '\n')
                os.replace(tmp_s, STORAGE_PATH)
            elif lines:
                with open(STORAGE_PATH, 'a', encoding='utf-8') as f:
                    f.write('\n'.join(lines) + '\n')

            earliest = self.frames[0]['t'] if self.frames else now
            latest = self.frames[-1]['t'] if self.frames else now
            size_kb = round(os.path.getsize(STORAGE_PATH) / 1024.0, 1) if os.path.exists(STORAGE_PATH) else 0
            payload = {
                'now': round(now, 1),
                'start_ts': earliest,
                'end_ts': round(now, 1),
                'frames': list(self.frames),
                'zones': self.latest_zones,
                'radars': self.latest_radars,
                'stats': {
                    'total_frames': len(self.frames),
                    'returned_frames': len(self.frames),
                    'earliest_ts': earliest,
                    'latest_ts': latest,
                    'exact_start_ts': self.exact_start_ts or now,
                    'retention_hours': RETENTION_SECONDS // 3600,
                    'storage_kb': size_kb,
                }
            }
            os.makedirs(os.path.dirname(WWW_JSON_PATH), exist_ok=True)
            tmp_w = WWW_JSON_PATH + '.tmp'
            with open(tmp_w, 'w', encoding='utf-8') as f:
                json.dump(payload, f, separators=(',', ':'))
            os.replace(tmp_w, WWW_JSON_PATH)
        except Exception as e:
            log.error('Flush error: %s', e)


async def run_loop():
    rec = DaemonRecorder()
    rec.flush(time.time())
    token = open('/config/.ha_recorder_token').read().strip()
    ws_url = 'http://homeassistant:8123/api/websocket'

    while True:
        try:
            async with aiohttp.ClientSession() as session:
                async with session.ws_connect(ws_url, max_msg_size=32 * 1024 * 1024, heartbeat=30) as ws:
                    await ws.receive_json()  # auth_required
                    await ws.send_json({'type': 'auth', 'access_token': token})
                    auth_res = await ws.receive_json()
                    if auth_res.get('type') != 'auth_ok':
                        raise RuntimeError(f'Auth failed: {auth_res}')

                    # Check if in-Core rmm/history is already active
                    await ws.send_json({'id': 1, 'type': 'rmm/history', 'hours': 0.01})
                    chk = await ws.receive_json()
                    if chk.get('success'):
                        log.info('In-Core rmm/history is active; sleeping on standby')
                        await asyncio.sleep(120)
                        continue

                    await ws.send_json({'id': 2, 'type': 'rmm/stream'})
                    sub_res = await ws.receive_json()
                    log.info('Subscribed to rmm/stream: %s', sub_res.get('success'))

                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            data = json.loads(msg.data)
                            if data.get('type') == 'event' and data.get('id') == 2:
                                ev_data = (data.get('event') or {}).get('data') or {}
                                rec.on_data(ev_data)
                        elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            break
        except Exception as e:
            log.warning('WS connection error (%s), retrying in 5s...', e)
            await asyncio.sleep(5)


if __name__ == '__main__':
    asyncio.run(run_loop())
