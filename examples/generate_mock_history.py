#!/usr/bin/env python3
import json
import math
import time

def generate_mock_history():
    end_ts = time.time()
    start_ts = end_ts - 1800.0  # 30 minute window up to current moment

    radars = {
        "apollo": {
            "name": "Apollo R-PRO-1 (Lounge/Kitchen)",
            "layout": {
                "origin_x": 57.35,
                "origin_y": 8.17,
                "rotation": 180,
                "scale_x": 5.0,
                "scale_y": 5.0
            }
        },
        "t1": {
            "name": "LD2450 Tracker 1 (Bedroom/Bath)",
            "layout": {
                "origin_x": 28.71,
                "origin_y": 49.09,
                "rotation": 180,
                "scale_x": 5.0,
                "scale_y": 5.0
            }
        },
        "t2": {
            "name": "LD2450 Tracker 2 (Office/Entry)",
            "layout": {
                "origin_x": 94.41,
                "origin_y": 62.37,
                "rotation": 245,
                "scale_x": 5.0,
                "scale_y": 5.0
            }
        }
    }

    zones = {
        "include_zones": [
            {"name": "Lounge", "points": [[20.0, 15.0], [55.0, 15.0], [55.0, 48.0], [20.0, 48.0]]},
            {"name": "Sofa", "points": [[23.0, 31.0], [33.0, 31.0], [33.0, 41.0], [23.0, 41.0]]},
            {"name": "Kitchen", "points": [[55.0, 20.0], [75.0, 20.0], [75.0, 50.0], [55.0, 50.0]]},
            {"name": "Office", "points": [[78.0, 60.0], [96.0, 60.0], [96.0, 92.0], [78.0, 92.0]]},
            {"name": "Bedroom", "points": [[18.0, 58.0], [42.0, 58.0], [42.0, 92.0], [18.0, 92.0]]},
            {"name": "Bathroom", "points": [[48.0, 60.0], [68.0, 60.0], [68.0, 92.0], [48.0, 92.0]]}
        ],
        "stationary_zones": [
            {"name": "Sofa", "points": [[23.0, 31.0], [33.0, 31.0], [33.0, 41.0], [23.0, 41.0]]}
        ],
        "exclude_zones": []
    }

    # Waypoints for smooth trajectory (time_offset, x, y, zone, state)
    waypoints = [
        # 14:30 -> 14:41: Sitting on sofa
        (0, 26.8, 35.2, "Lounge · sofa", "hold"),
        (660, 26.8, 35.2, "Lounge · sofa", "hold"),
        # 14:41 -> 14:43: Getting up, walking around coffee table
        (690, 29.5, 33.8, "Lounge", "active"),
        (720, 34.0, 32.5, "Lounge", "active"),
        (760, 42.0, 35.0, "Lounge", "active"),
        (800, 49.0, 39.5, "Floorplan", "active"),
        # 14:43 -> 14:51: Walking to kitchen & preparing coffee
        (840, 56.5, 43.5, "Kitchen", "active"),
        (880, 58.2, 44.5, "Kitchen", "hold"),
        (1100, 58.2, 44.5, "Kitchen", "hold"),
        (1140, 57.0, 43.0, "Kitchen", "active"),
        # 14:51 -> 14:53: Walking across hall into Office
        (1200, 53.0, 41.0, "Floorplan", "active"),
        (1250, 62.0, 48.0, "Floorplan", "active"),
        (1300, 74.0, 58.0, "Floorplan", "active"),
        (1350, 83.0, 67.0, "Office", "active"),
        (1400, 87.5, 76.5, "Office", "hold"),
        # 14:53 -> 15:00: Sitting at office desk
        (1800, 87.5, 76.5, "Office", "hold"),
    ]

    frames = []
    t = 0.0
    while t <= 1800.0:
        p0 = waypoints[0]
        p1 = waypoints[-1]
        for i in range(len(waypoints) - 1):
            if waypoints[i][0] <= t <= waypoints[i+1][0]:
                p0 = waypoints[i]
                p1 = waypoints[i+1]
                break

        dur = max(1, p1[0] - p0[0])
        alpha = (t - p0[0]) / dur
        # Smooth cosine interpolation
        ease = 0.5 - 0.5 * math.cos(alpha * math.pi)
        cur_x = p0[1] + (p1[1] - p0[1]) * ease
        cur_y = p0[2] + (p1[2] - p0[2]) * ease
        state = p1[4] if alpha > 0.8 else p0[4] if alpha < 0.2 else "active"
        zone = p1[3] if alpha > 0.5 else p0[3]

        # Jitter
        jx = math.sin(t * 1.5) * 0.12
        jy = math.cos(t * 1.2) * 0.12
        fx = round(cur_x + jx, 2)
        fy = round(cur_y + jy, 2)
        ts = round(start_ts + t, 1)

        # Active radar selection
        if fx > 75 and fy > 55:
            src = "t2:1"
            rcode = "t2"
        else:
            src = "apollo:1"
            rcode = "apollo"

        f_targets = [{
            "id": "target_1",
            "x": fx,
            "y": fy,
            "s": state,
            "src": [src],
            "z": zone
        }]

        # Raw detection
        r_targets = [
            [rcode, 1, round(fx + 0.25 * math.sin(t), 2), round(fy + 0.25 * math.cos(t), 2)]
        ]

        frames.append({
            "t": ts,
            "f": f_targets,
            "r": r_targets
        })

        if state == "hold":
            t += 12.0
        else:
            t += 2.0

    payload = {
        "status": "ok",
        "retention_hours": 48,
        "radars": radars,
        "zones": zones,
        "frames": frames,
        "stats": {
            "total_frames": 14200,
            "storage_kb": 224,
            "retention_hours": 48,
            "oldest_ts": start_ts,
            "newest_ts": end_ts
        }
    }

    with open("/home/bae/ha-rmm-replay/examples/mock_history.json", "w") as f:
        json.dump(payload, f, indent=2)

    print(f"Generated {len(frames)} mock frames successfully in examples/mock_history.json")

if __name__ == "__main__":
    generate_mock_history()
