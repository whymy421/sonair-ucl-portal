"""Generate browser-ready latency and UR5e motion evidence."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd


def vector_derivative(values: np.ndarray, time_s: np.ndarray) -> np.ndarray:
    return np.column_stack(
        [np.gradient(values[:, index], time_s) for index in range(values.shape[1])]
    )


def build_analysis(rtt_path: Path, tcp_path: Path, joint_path: Path | None) -> dict:
    rtt = (
        pd.read_csv(rtt_path, usecols=["ts", "rtt_ms"])
        .dropna()
        .sort_values("ts")
        .rename(columns={"ts": "rtt_time_s"})
    )
    motion = pd.read_csv(tcp_path)
    required = {"ts", "x", "y", "z"}
    if not required.issubset(motion.columns):
        missing = ", ".join(sorted(required - set(motion.columns)))
        raise ValueError(f"TCP motion CSV is missing columns: {missing}")

    motion["timestamp"] = pd.to_datetime(motion["ts"], utc=True)
    motion["elapsed_s"] = (
        motion["timestamp"] - motion["timestamp"].iloc[0]
    ).dt.total_seconds()
    time_s = motion["elapsed_s"].to_numpy(dtype=float)
    position = motion[["x", "y", "z"]].to_numpy(dtype=float)
    velocity = vector_derivative(position, time_s)
    motion["speed_m_s"] = np.linalg.norm(velocity, axis=1)
    motion["acceleration_m_s2"] = np.gradient(
        motion["speed_m_s"].to_numpy(), time_s
    )
    motion["abs_jerk_m_s3"] = np.abs(
        np.gradient(motion["acceleration_m_s2"].to_numpy(), time_s)
    )

    joint_summary = None
    if joint_path and joint_path.exists():
        joints = pd.read_csv(joint_path)
        joint_columns = [
            column
            for column in joints.columns
            if column.startswith("q") and not column.endswith("_deg")
        ]
        if joint_columns:
            joints["timestamp"] = pd.to_datetime(joints["ts"], utc=True)
            joints["elapsed_s"] = (
                joints["timestamp"] - motion["timestamp"].iloc[0]
            ).dt.total_seconds()
            joint_time_s = joints["elapsed_s"].to_numpy(dtype=float)
            joint_position = joints[joint_columns].to_numpy(dtype=float)
            joint_velocity = vector_derivative(joint_position, joint_time_s)
            joint_acceleration = vector_derivative(joint_velocity, joint_time_s)
            joints["joint_speed_rad_s"] = np.linalg.norm(joint_velocity, axis=1)
            joints["joint_acceleration_rad_s2"] = np.linalg.norm(
                joint_acceleration, axis=1
            )
            joint_summary = {
                "columns": joint_columns,
                "mean_speed_rad_s": float(joints["joint_speed_rad_s"].mean()),
                "p95_speed_rad_s": float(
                    joints["joint_speed_rad_s"].quantile(0.95)
                ),
                "mean_acceleration_rad_s2": float(
                    joints["joint_acceleration_rad_s2"].mean()
                ),
                "p95_acceleration_rad_s2": float(
                    joints["joint_acceleration_rad_s2"].quantile(0.95)
                ),
            }

    # RTT is session-relative; motion is normalized to the first motion sample.
    aligned = pd.merge_asof(
        motion.sort_values("elapsed_s"),
        rtt,
        left_on="elapsed_s",
        right_on="rtt_time_s",
        direction="nearest",
        tolerance=0.5,
    ).dropna(subset=["rtt_ms"])

    normal = aligned["rtt_ms"] < 60
    high = aligned["rtt_ms"] > 100
    normal_jerk = aligned.loc[normal, "abs_jerk_m_s3"]
    high_jerk = aligned.loc[high, "abs_jerk_m_s3"]
    jerk_p95 = float(aligned["abs_jerk_m_s3"].quantile(0.95))
    rtt_p95 = float(aligned["rtt_ms"].quantile(0.95))
    aligned["degradation_score"] = 100 * (
        0.5 * np.clip(aligned["rtt_ms"] / rtt_p95, 0, 1)
        + 0.5 * np.clip(aligned["abs_jerk_m_s3"] / jerk_p95, 0, 1)
    )
    aligned["degradation_score"] = (
        aligned["degradation_score"].rolling(9, center=True, min_periods=1).mean()
    )
    chart_rows = aligned.iloc[:: max(1, len(aligned) // 360)]

    return {
        "meta": {
            "alignment": "nearest RTT within 0.5 s after elapsed-time normalization",
            "motion_samples": int(len(motion)),
            "aligned_samples": int(len(aligned)),
            "duration_s": float(motion["elapsed_s"].max()),
        },
        "summary": {
            "mean_speed_m_s": float(aligned["speed_m_s"].mean()),
            "p95_speed_m_s": float(aligned["speed_m_s"].quantile(0.95)),
            "mean_abs_jerk_m_s3": float(aligned["abs_jerk_m_s3"].mean()),
            "normal_mean_jerk_m_s3": float(normal_jerk.mean()),
            "high_mean_jerk_m_s3": float(high_jerk.mean()),
            "normal_median_jerk_m_s3": float(normal_jerk.median()),
            "high_median_jerk_m_s3": float(high_jerk.median()),
            "normal_samples": int(normal.sum()),
            "high_samples": int(high.sum()),
            "high_to_normal_mean_jerk_ratio": float(
                high_jerk.mean() / normal_jerk.mean()
            ),
            "pearson_rtt_jerk": float(
                aligned[["rtt_ms", "abs_jerk_m_s3"]].corr().iloc[0, 1]
            ),
            "spearman_rtt_jerk": float(
                aligned[["rtt_ms", "abs_jerk_m_s3"]]
                .corr(method="spearman")
                .iloc[0, 1]
            ),
            "joint_motion": joint_summary,
        },
        "scatter": [
            {"x": round(float(row.rtt_ms), 3), "y": round(float(row.abs_jerk_m_s3), 6)}
            for row in chart_rows.itertuples()
        ],
        "comparison": {
            "labels": ["Normal (<60 ms)", "High (>100 ms)"],
            "mean_jerk": [
                round(float(normal_jerk.mean()), 6),
                round(float(high_jerk.mean()), 6),
            ],
            "median_jerk": [
                round(float(normal_jerk.median()), 6),
                round(float(high_jerk.median()), 6),
            ],
        },
        "timeline": [
            {
                "t": round(float(row.elapsed_s), 3),
                "score": round(float(row.degradation_score), 2),
            }
            for row in chart_rows.itertuples()
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rtt", type=Path, required=True)
    parser.add_argument("--tcp", type=Path, required=True)
    parser.add_argument("--joints", type=Path)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).with_name("motion_analysis.js"),
    )
    args = parser.parse_args()
    analysis = build_analysis(args.rtt, args.tcp, args.joints)
    payload = json.dumps(analysis, separators=(",", ":"), allow_nan=False)
    args.output.write_text(f"const MOTION_ANALYSIS = {payload};\n", encoding="utf-8")
    print(f"Wrote {args.output} with {analysis['meta']['aligned_samples']} samples")


if __name__ == "__main__":
    main()
