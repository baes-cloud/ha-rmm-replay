#!/usr/bin/env python3
"""Generate examples/mock_history.json: a made-up but natural 30 minutes for demos.

Story: working at the office desk, a walk out to the lounge sofa, a drink run
to the kitchen fridge and back, then up and around the coffee table, past the
kitchen and out the front door.
Paths are smooth Catmull-Rom curves walked at a steady ~1.1 m/s with gentle
easing at stops, plus small slow drift (people don't move in straight lines)
and noisier raw radar points, like the real thing.
"""
import json
import math
import os
import random
import time

random.seed(7)

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mock_history.json")
WINDOW = 1800.0
UNITS_PER_M = 5.0           # map units per metre (matches the radars' scale)
WALK_SPEED = 1.1 * UNITS_PER_M

RADARS = {
    "apollo": {"name": "club_apollo_r_pro_1_ld2450", "label": "Apollo R-PRO-1", "color": "#5CE1E6",
               "layout": {"origin_x": 57.35, "origin_y": 8.17, "rotation": 180, "scale_x": 5.0, "scale_y": 5.0}},
    "t1": {"name": "ld2450_tracker", "label": "Tracker 1 (Bed/Bath)", "color": "#FF8A80",
           "layout": {"origin_x": 28.71, "origin_y": 49.09, "rotation": 180, "scale_x": 5.0, "scale_y": 5.0}},
    "t2": {"name": "ld2450_tracker_2", "label": "Tracker 2 (Office)", "color": "#FFD166",
           "layout": {"origin_x": 94.41, "origin_y": 62.37, "rotation": 245, "scale_x": 5.0, "scale_y": 5.0}},
}

ZONES = {
    "include_zones": [
        {"name": "Lounge", "points": [[18.0, 12.0], [52.0, 12.0], [52.0, 48.0], [18.0, 48.0]]},
        {"name": "Sofa", "points": [[22.0, 30.0], [38.0, 30.0], [38.0, 41.0], [22.0, 41.0]]},
        {"name": "Kitchen", "points": [[52.0, 12.0], [82.0, 12.0], [82.0, 44.0], [52.0, 44.0]]},
        {"name": "Office", "points": [[78.0, 58.0], [97.0, 58.0], [97.0, 95.0], [78.0, 95.0]]},
        {"name": "Bedroom", "points": [[3.0, 52.0], [42.0, 52.0], [42.0, 95.0], [3.0, 95.0]]},
        {"name": "Bathroom", "points": [[42.0, 60.0], [60.0, 60.0], [60.0, 95.0], [42.0, 95.0]]},
    ],
    "stationary_zones": [
        {"name": "Sofa", "points": [[22.0, 30.0], [38.0, 30.0], [38.0, 41.0], [22.0, 41.0]]},
    ],
    "exclude_zones": [],
}

DESK = (88.0, 77.0)
SOFA = (33.5, 35.0)
DOOR = (91.5, 52.5)
FRIDGE = (79.5, 31.0)

# (start_s, kind, data): "hold" at a point until the next segment, "walk" along waypoints.
TIMELINE = [
    (0, "hold", DESK),
    (540, "walk", [DESK, (86.5, 68.0), (88.0, 58.5), (84.0, 50.5), (72.0, 47.0),
                   (60.0, 46.0), (50.0, 44.5), (41.0, 40.0), SOFA]),
    (None, "hold", SOFA),
    (1010, "walk", [SOFA, (42.0, 39.5), (54.0, 46.0), (66.0, 47.5), (77.0, 45.0), (80.5, 38.0), FRIDGE]),
    (None, "hold", FRIDGE),
    (1085, "walk", [FRIDGE, (80.0, 39.0), (75.0, 46.0), (63.0, 47.0), (52.0, 45.0), (42.0, 40.0), SOFA]),
    (None, "hold", SOFA),
    (1560, "walk", [SOFA, (38.5, 27.5), (43.5, 18.5), (49.5, 15.0), (56.5, 18.0),
                    (60.5, 25.5), (62.5, 34.0), (65.5, 42.5), (71.0, 45.5),
                    (82.0, 46.5), (89.0, 48.5), DOOR]),
    (None, "hold", DOOR),
    (None, "gone", None),
]
DOOR_LINGER = 18.0


def catmull_rom(pts, steps=40):
    pts = [pts[0]] + list(pts) + [pts[-1]]
    out = []
    for i in range(1, len(pts) - 2):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[i + 1], pts[i + 2]
        for s in range(steps):
            t = s / steps
            t2, t3 = t * t, t * t * t
            out.append(tuple(0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t
                                    + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2
                                    + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3) for k in (0, 1)))
    out.append(tuple(pts[-2]))
    return out


def walk_track(waypoints):
    """Return (duration_s, position_at(t)) for walking the curve with eased start/stop."""
    curve = catmull_rom(waypoints)
    cum = [0.0]
    for a, b in zip(curve, curve[1:]):
        cum.append(cum[-1] + math.dist(a, b))
    length = cum[-1]
    ramp = 1.2  # seconds to get up to speed / slow down
    duration = length / WALK_SPEED + ramp

    def dist_at(t):
        # trapezoidal speed profile
        v = WALK_SPEED
        if t <= 0:
            return 0.0
        if t >= duration:
            return length
        if t < ramp:
            return 0.5 * v / ramp * t * t
        if t > duration - ramp:
            r = duration - t
            return length - 0.5 * v / ramp * r * r
        return 0.5 * v * ramp + v * (t - ramp)

    def pos(t):
        d = dist_at(t)
        i = max(0, min(len(cum) - 2, next((j for j in range(len(cum) - 1) if cum[j + 1] >= d), len(cum) - 2)))
        seg = cum[i + 1] - cum[i] or 1.0
        a = (d - cum[i]) / seg
        (x0, y0), (x1, y1) = curve[i], curve[i + 1]
        return x0 + (x1 - x0) * a, y0 + (y1 - y0) * a

    return duration, pos


def drift(t, amp, seeds):
    return sum(amp * w * math.sin(t * f + p) for w, f, p in seeds)


DRIFT_X = [(0.6, 0.31, 1.1), (0.4, 0.77, 2.3)]
DRIFT_Y = [(0.6, 0.27, 0.4), (0.4, 0.69, 3.0)]


def in_poly(x, y, poly):
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def zone_label(x, y):
    names = [z["name"] for z in ZONES["include_zones"] if in_poly(x, y, z["points"])]
    if "Sofa" in names:
        return "Lounge · sofa"
    names = [n for n in names if n != "Sofa"]
    return names[0] if names else "Floorplan"


def radar_for(x, y):
    if x > 77 and y > 47:
        return "t2"
    if y > 52 and x < 42:
        return "t1"
    return "apollo"


def build():
    # Resolve the timeline into concrete segments.
    segs = []
    t = 0.0
    for idx, (start, kind, data) in enumerate(TIMELINE):
        if start is not None:
            t = float(start)
        if kind == "walk":
            dur, pos = walk_track(data)
            segs.append((t, t + dur, "walk", pos))
            t += dur
        else:
            nxt = next((s for s, *_ in TIMELINE[idx + 1:] if s is not None), None)
            if kind == "hold" and data == DOOR:
                end = t + DOOR_LINGER
            else:
                end = float(nxt) if nxt is not None else WINDOW
            segs.append((t, end, kind, data))
            t = end

    end_ts = time.time()
    start_ts = end_ts - WINDOW
    frames = []
    t = 0.0
    last_hb = -999.0
    while t <= WINDOW:
        seg = next((s for s in segs if s[0] <= t < s[1]), segs[-1])
        _, _, kind, data = seg
        if kind == "gone":
            if t - last_hb >= 60:
                frames.append({"t": round(start_ts + t, 1), "f": [], "r": []})
                last_hb = t
            t += 5.0
            continue
        if kind == "walk":
            x, y = data(t - seg[0])
            x += drift(t, 0.35, DRIFT_X)
            y += drift(t, 0.35, DRIFT_Y)
            state, step = "active", 0.5
        else:
            x = data[0] + drift(t, 0.12, DRIFT_X)
            y = data[1] + drift(t, 0.12, DRIFT_Y)
            state, step = "hold", 15.0
        rc = radar_for(x, y)
        frames.append({
            "t": round(start_ts + t, 1),
            "f": [{"id": "target_1", "x": round(x, 2), "y": round(y, 2), "s": state,
                   "src": [f"{rc}:1"], "z": zone_label(x, y)}],
            "r": [[rc, 1, round(x + random.gauss(0, 0.45), 2), round(y + random.gauss(0, 0.45), 2)]],
        })
        # land exactly on segment boundaries so holds start where walks end
        nt = t + step
        boundary = next((s[0] for s in segs if t < s[0] < nt), None)
        t = boundary if boundary is not None else nt

    return {
        "now": round(end_ts, 1),
        "start_ts": round(start_ts, 1),
        "end_ts": round(end_ts, 1),
        "radars": RADARS,
        "zones": ZONES,
        "frames": frames,
        "stats": {
            "total_frames": 14200,
            "returned_frames": len(frames),
            "storage_kb": 224,
            "earliest_ts": round(start_ts, 1),
            "latest_ts": round(end_ts, 1),
            "exact_start_ts": round(start_ts, 1),
            "retention_hours": 48,
        },
    }


if __name__ == "__main__":
    payload = build()
    with open(OUT, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    walk = [s for s in payload["frames"] if s["f"] and s["f"][0]["s"] == "active"]
    print(f"{len(payload['frames'])} frames ({len(walk)} walking) -> {OUT}")
