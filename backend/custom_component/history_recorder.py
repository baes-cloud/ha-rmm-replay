import collections
import json
import logging
import math
import os
import time
import voluptuous as vol

from homeassistant.core import HomeAssistant, callback
from homeassistant.components import websocket_api
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.event import async_track_time_interval
from datetime import timedelta
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

RETENTION_SECONDS = 48 * 3600  # 48 hours rolling history
MIN_SAMPLE_INTERVAL = 0.45     # Max ~2 Hz sampling during active movement
MOVE_THRESHOLD_PCT = 0.16      # ~1.3 cm on floorplan
RAW_THRESHOLD_PCT = 0.35       # Raw LD2450 target movement threshold
HEARTBEAT_OCCUPIED = 15.0      # Keyframe every 15s when occupied & still
HEARTBEAT_EMPTY = 60.0         # Keyframe every 60s when empty

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


def _short_src(src_str: str) -> str:
    if ':' in src_str:
        rname, tid = src_str.split(':', 1)
        return f'{RADAR_SHORT.get(rname.lower(), rname)}:{tid}'
    return src_str


def _point_in_poly(x: float, y: float, poly: list) -> bool:
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


def _project_raw_point(layout: dict, pt: dict) -> tuple[float, float] | None:
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


class RMMHistoryRecorder:
    def __init__(self, hass: HomeAssistant):
        self.hass = hass
        self.storage_path = hass.config.path('.storage', 'rmm_movement_history.jsonl')
        self.www_json_path = hass.config.path('www', 'rmm-replay', 'history_24h.json')
        self.frames: collections.deque = collections.deque()
        self._pending_lines: list[str] = []
        self._unsub_stream = None
        self._unsub_timer = None
        self._last_sample_ts = 0.0
        self._last_frame = None
        self._last_compact_ts = time.time()
        self._exact_start_ts = None
        self._flushing = False

    async def async_start(self):
        await self.hass.async_add_executor_job(self._load_from_disk)
        self._unsub_stream = async_dispatcher_connect(
            self.hass, 'rmm_stream_update', self._on_stream_update
        )
        self._unsub_timer = async_track_time_interval(
            self.hass, self._async_periodic_flush, timedelta(seconds=5)
        )
        _LOGGER.warning(
            'RMM History Recorder started (%d frames loaded, retention=%dh)',
            len(self.frames),
            RETENTION_SECONDS // 3600,
        )

    def stop(self):
        if self._unsub_stream:
            self._unsub_stream()
            self._unsub_stream = None
        if self._unsub_timer:
            self._unsub_timer()
            self._unsub_timer = None
        if self._pending_lines:
            self.hass.async_add_executor_job(self._flush_to_disk, list(self._pending_lines), False)
            self._pending_lines.clear()

    def _load_from_disk(self):
        if not os.path.exists(self.storage_path):
            return
        cutoff = time.time() - RETENTION_SECONDS
        loaded = collections.deque()
        exact_ts = None
        try:
            with open(self.storage_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                        ts = float(obj.get('t', 0))
                        if ts >= cutoff:
                            loaded.append(obj)
                            if not obj.get('bf') and exact_ts is None:
                                exact_ts = ts
                    except Exception:
                        continue
            self.frames = loaded
            self._exact_start_ts = exact_ts
            if self.frames:
                self._last_frame = self.frames[-1]
                self._last_sample_ts = float(self._last_frame.get('t', 0))
        except Exception as e:
            _LOGGER.error('RMM History Recorder load error: %s', e)

    def _extract_frame(self, data: dict, now: float) -> dict:
        maps = data.get('maps') or {}
        m = maps.get('default') or {}
        zones = (m.get('zones') or {}).get('include_zones') or []
        exclude_zones = (m.get('zones') or {}).get('exclude_zones') or []

        def get_zone_label(px: float, py: float) -> str:
            matched = []
            for z in zones:
                pts = z.get('points') or []
                if _point_in_poly(px, py, pts):
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
            short_srcs = [_short_src(s) for s in sources]
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
                proj = _project_raw_point(layout, rt)
                if not proj:
                    continue
                rx, ry = proj
                if any(_point_in_poly(rx, ry, ez.get('points') or []) for ez in exclude_zones):
                    continue
                raw_out.append([rcode, int(rt.get('i', 1)), rx, ry])

        return {
            't': round(now, 1),
            'f': fused_out,
            'r': raw_out,
        }

    def _should_record(self, frame: dict, now: float) -> bool:
        prev = self._last_frame
        if prev is None or prev.get('bf'):
            return True
        dt = now - self._last_sample_ts
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

    @callback
    def _on_stream_update(self, data: dict):
        now = time.time()
        try:
            frame = self._extract_frame(data, now)
            if not self._should_record(frame, now):
                return
            if self._exact_start_ts is None:
                self._exact_start_ts = frame['t']
            self.frames.append(frame)
            self._last_frame = frame
            self._last_sample_ts = now
            self._pending_lines.append(json.dumps(frame, separators=(',', ':')))

            cutoff = now - RETENTION_SECONDS
            while self.frames and self.frames[0].get('t', 0) < cutoff:
                self.frames.popleft()
        except Exception as e:
            _LOGGER.debug('RMM History Recorder sample error: %s', e)

    def _build_payload(self, hours: float = 48.0, start_ts: float | None = None, end_ts: float | None = None, max_points: int = 30000) -> dict:
        now = time.time()
        end_t = float(end_ts or now)
        start_t = float(start_ts or (end_t - hours * 3600.0))
        selected = [fr for fr in self.frames if start_t <= fr.get('t', 0) <= end_t]
        if len(selected) > max_points and max_points > 100:
            step = max(1, len(selected) // max_points)
            filtered = []
            for idx, fr in enumerate(selected):
                if idx == 0 or idx == len(selected) - 1 or idx % step == 0:
                    filtered.append(fr)
                elif len(fr.get('f', [])) != len(selected[idx - 1].get('f', [])):
                    filtered.append(fr)
            selected = filtered

        coord = self.hass.data.get(DOMAIN, {}).get('coordinator')
        cdata = (coord.data if coord and coord.data else {})
        map_data = (cdata.get('maps') or {}).get('default') or {}
        zones = map_data.get('zones') or {}
        radars_out = {}
        for rname, rconf in (cdata.get('radars') or {}).items():
            if rconf.get('map_group', 'default') == 'default':
                rcode = RADAR_SHORT.get(rname.lower(), rname)
                radars_out[rcode] = {
                    'name': rname,
                    'label': RADAR_LABELS.get(rcode, rname),
                    'layout': rconf.get('layout') or {},
                    'paused': bool(rconf.get('paused', False)),
                }

        earliest = self.frames[0]['t'] if self.frames else now
        latest = self.frames[-1]['t'] if self.frames else now
        return {
            'now': round(now, 1),
            'start_ts': round(start_t, 1),
            'end_ts': round(end_t, 1),
            'frames': selected,
            'zones': zones,
            'radars': radars_out,
            'stats': {
                'total_frames': len(self.frames),
                'returned_frames': len(selected),
                'earliest_ts': earliest,
                'latest_ts': latest,
                'exact_start_ts': self._exact_start_ts or now,
                'retention_hours': RETENTION_SECONDS // 3600,
            }
        }

    async def _async_periodic_flush(self, _now=None):
        if self._flushing or not self._pending_lines:
            return
        self._flushing = True
        try:
            lines = list(self._pending_lines)
            self._pending_lines.clear()
            now = time.time()
            need_compact = (now - self._last_compact_ts) > 900
            payload = self._build_payload(hours=48.0)
            if need_compact:
                self._last_compact_ts = now
                all_frames = list(self.frames)
                await self.hass.async_add_executor_job(self._compact_and_export, all_frames, payload)
            else:
                await self.hass.async_add_executor_job(self._flush_and_export, lines, payload)
        finally:
            self._flushing = False

    def _flush_to_disk(self, lines: list[str], overwrite: bool = False):
        try:
            os.makedirs(os.path.dirname(self.storage_path), exist_ok=True)
            mode = 'w' if overwrite else 'a'
            with open(self.storage_path, mode, encoding='utf-8') as f:
                f.write('\n'.join(lines) + '\n')
        except Exception as e:
            _LOGGER.error('RMM History Recorder disk write error: %s', e)

    def _export_www(self, payload: dict):
        try:
            os.makedirs(os.path.dirname(self.www_json_path), exist_ok=True)
            tmp = self.www_json_path + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(payload, f, separators=(',', ':'))
            os.replace(tmp, self.www_json_path)
        except Exception as e:
            _LOGGER.error('RMM History Recorder www export error: %s', e)

    def _flush_and_export(self, lines: list[str], payload: dict):
        self._flush_to_disk(lines, False)
        self._export_www(payload)

    def _compact_and_export(self, all_frames: list[dict], payload: dict):
        try:
            tmp_path = self.storage_path + '.tmp'
            with open(tmp_path, 'w', encoding='utf-8') as f:
                for fr in all_frames:
                    f.write(json.dumps(fr, separators=(',', ':')) + '\n')
            os.replace(tmp_path, self.storage_path)
        except Exception as e:
            _LOGGER.error('RMM History Recorder compact error: %s', e)
        self._export_www(payload)

    @callback
    def handle_ws_history(self, connection: websocket_api.ActiveConnection, msg: dict):
        hours = float(msg.get('hours', 24.0))
        start_ts = msg.get('start_ts')
        end_ts = msg.get('end_ts')
        max_points = int(msg.get('max_points', 30000))
        connection.send_result(
            msg['id'],
            self._build_payload(hours=hours, start_ts=start_ts, end_ts=end_ts, max_points=max_points)
        )


@callback
@websocket_api.websocket_command({
    vol.Required('type'): 'rmm/history',
    vol.Optional('hours', default=24.0): vol.Coerce(float),
    vol.Optional('start_ts'): vol.Coerce(float),
    vol.Optional('end_ts'): vol.Coerce(float),
    vol.Optional('max_points', default=30000): vol.Coerce(int),
})
def websocket_rmm_history(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict):
    rec = hass.data.get('rmm_history_recorder')
    if not rec:
        connection.send_error(msg['id'], 'not_ready', 'RMM History Recorder is not running')
        return
    rec.handle_ws_history(connection, msg)


async def async_setup_recorder(hass: HomeAssistant):
    old = hass.data.get('rmm_history_recorder')
    if old:
        try:
            old.stop()
        except Exception:
            pass
    rec = RMMHistoryRecorder(hass)
    hass.data['rmm_history_recorder'] = rec
    await rec.async_start()
    try:
        websocket_api.async_register_command(hass, websocket_rmm_history)
    except Exception:
        pass
    return rec
