"""Generate target-versus-actual tracking evidence from the AURSAD subset."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd


POSITION_REFERENCE_MM = 1.0
ORIENTATION_REFERENCE_DEG = 0.5
JOINT_REFERENCE_DEG = 0.5
LAG_REFERENCE_MS = 50.0
EXAMPLE_OPERATION_ID = 23


def rotation_vector_quaternion(values: np.ndarray) -> np.ndarray:
    angle = np.linalg.norm(values, axis=1)
    half_angle = angle / 2
    scale = np.divide(
        np.sin(half_angle),
        angle,
        out=np.full_like(angle, 0.5),
        where=angle > 1e-12,
    )
    return np.column_stack([np.cos(half_angle), values * scale[:, None]])


def orientation_error_deg(target: np.ndarray, actual: np.ndarray) -> np.ndarray:
    target_quaternion = rotation_vector_quaternion(target)
    actual_quaternion = rotation_vector_quaternion(actual)
    dot = np.abs(np.sum(target_quaternion * actual_quaternion, axis=1))
    return 2 * np.arccos(np.clip(dot, -1, 1)) * 180 / np.pi


def estimate_operation_lag(group: pd.DataFrame) -> float:
    time_delta = group["timestamp"].diff()
    segment_id = (time_delta.le(0) | time_delta.gt(0.1)).cumsum()
    lags = []
    weights = []
    target_columns = [f"target_TCP_speed_{index}" for index in range(3)]
    actual_columns = [f"actual_TCP_speed_{index}" for index in range(3)]

    for _, segment in group.groupby(segment_id):
        if len(segment) < 200:
            continue
        target = np.linalg.norm(segment[target_columns].to_numpy(), axis=1)
        actual = np.linalg.norm(segment[actual_columns].to_numpy(), axis=1)
        if np.std(target) < 1e-5 or np.std(actual) < 1e-5:
            continue
        target = (target - target.mean()) / target.std()
        actual = (actual - actual.mean()) / actual.std()
        scores = []
        max_lag_samples = 50
        for lag in range(-max_lag_samples, max_lag_samples + 1):
            if lag >= 0:
                target_slice = target[: -lag or None]
                actual_slice = actual[lag:]
            else:
                target_slice = target[-lag:]
                actual_slice = actual[:lag]
            scores.append(float(np.mean(target_slice * actual_slice)))
        best_lag = int(np.argmax(scores)) - max_lag_samples
        lags.append(best_lag * 10.0)
        weights.append(len(segment))

    return float(np.average(lags, weights=weights)) if lags else 0.0


def fidelity_score(
    position_rmse_mm: float,
    orientation_rmse_deg: float,
    joint_rmse_deg: float,
    lag_ms: float,
) -> tuple[float, dict[str, float]]:
    components = {
        "position": min(position_rmse_mm / POSITION_REFERENCE_MM, 1),
        "orientation": min(
            orientation_rmse_deg / ORIENTATION_REFERENCE_DEG, 1
        ),
        "joint": min(joint_rmse_deg / JOINT_REFERENCE_DEG, 1),
        "lag": min(abs(lag_ms) / LAG_REFERENCE_MS, 1),
    }
    return 1 - float(np.mean(list(components.values()))), components


def build_analysis(path: Path) -> dict:
    identity_columns = [
        "operation_id",
        "outcome_label",
        "outcome_name",
        "phase",
        "timestamp",
    ]
    joint_columns = [
        f"{kind}_q_{index}"
        for kind in ("target", "actual")
        for index in range(6)
    ]
    pose_columns = [
        f"{kind}_TCP_pose_{index}"
        for kind in ("target", "actual")
        for index in range(6)
    ]
    speed_columns = [
        f"{kind}_TCP_speed_{index}"
        for kind in ("target", "actual")
        for index in range(3)
    ]
    data = pd.read_csv(
        path,
        usecols=identity_columns + joint_columns + pose_columns + speed_columns,
    )

    target_pose = data[
        [f"target_TCP_pose_{index}" for index in range(6)]
    ].to_numpy()
    actual_pose = data[
        [f"actual_TCP_pose_{index}" for index in range(6)]
    ].to_numpy()
    target_joint = data[[f"target_q_{index}" for index in range(6)]].to_numpy()
    actual_joint = data[[f"actual_q_{index}" for index in range(6)]].to_numpy()

    data["position_error_mm"] = (
        np.linalg.norm(actual_pose[:, :3] - target_pose[:, :3], axis=1) * 1000
    )
    data["orientation_error_deg"] = orientation_error_deg(
        target_pose[:, 3:], actual_pose[:, 3:]
    )
    data["joint_error_deg"] = (
        np.sqrt(np.mean((actual_joint - target_joint) ** 2, axis=1))
        * 180
        / np.pi
    )

    operation_rows = []
    for operation_id, group in data.groupby("operation_id", sort=True):
        position_rmse = float(np.sqrt(np.mean(group["position_error_mm"] ** 2)))
        orientation_rmse = float(
            np.sqrt(np.mean(group["orientation_error_deg"] ** 2))
        )
        joint_rmse = float(np.sqrt(np.mean(group["joint_error_deg"] ** 2)))
        lag_ms = estimate_operation_lag(group)
        score, _ = fidelity_score(
            position_rmse, orientation_rmse, joint_rmse, lag_ms
        )
        operation_rows.append(
            {
                "operation_id": int(operation_id),
                "outcome": group["outcome_name"].iloc[0],
                "position_rmse_mm": position_rmse,
                "orientation_rmse_deg": orientation_rmse,
                "joint_rmse_deg": joint_rmse,
                "lag_ms": lag_ms,
                "score": score,
            }
        )

    operations = pd.DataFrame(operation_rows)
    position_rmse = float(np.sqrt(np.mean(data["position_error_mm"] ** 2)))
    orientation_rmse = float(
        np.sqrt(np.mean(data["orientation_error_deg"] ** 2))
    )
    joint_rmse = float(np.sqrt(np.mean(data["joint_error_deg"] ** 2)))
    lag_ms = float(operations["lag_ms"].median())
    score, normalized = fidelity_score(
        position_rmse, orientation_rmse, joint_rmse, lag_ms
    )

    example = data[data["operation_id"] == EXAMPLE_OPERATION_ID].copy()
    example["elapsed_s"] = example["timestamp"] - example["timestamp"].iloc[0]
    example_step = max(1, len(example) // 180)
    example = example.iloc[::example_step]

    return {
        "meta": {
            "source": "AURSAD_target_actual_subset.csv",
            "rows": int(len(data)),
            "operations": int(data["operation_id"].nunique()),
            "sample_interval_ms": 10,
            "example_operation_id": EXAMPLE_OPERATION_ID,
            "example_outcome": "normal_operation",
        },
        "references": {
            "position_mm": POSITION_REFERENCE_MM,
            "orientation_deg": ORIENTATION_REFERENCE_DEG,
            "joint_deg": JOINT_REFERENCE_DEG,
            "lag_ms": LAG_REFERENCE_MS,
        },
        "summary": {
            "position_rmse_mm": position_rmse,
            "orientation_rmse_deg": orientation_rmse,
            "joint_rmse_deg": joint_rmse,
            "median_lag_ms": lag_ms,
            "tracking_fidelity": score,
            "normalized_components": normalized,
            "position_median_mm": float(data["position_error_mm"].median()),
            "position_p95_mm": float(data["position_error_mm"].quantile(0.95)),
            "orientation_median_deg": float(
                data["orientation_error_deg"].median()
            ),
            "orientation_p95_deg": float(
                data["orientation_error_deg"].quantile(0.95)
            ),
        },
        "example_trajectory": [
            {
                "t": round(float(row.elapsed_s), 3),
                "target_x": round(float(row.target_TCP_pose_0) * 1000, 3),
                "target_y": round(float(row.target_TCP_pose_1) * 1000, 3),
                "actual_x": round(float(row.actual_TCP_pose_0) * 1000, 3),
                "actual_y": round(float(row.actual_TCP_pose_1) * 1000, 3),
            }
            for row in example.itertuples()
        ],
        "operations": [
            {
                "id": int(row.operation_id),
                "outcome": row.outcome,
                "score": round(float(row.score), 4),
            }
            for row in operations.itertuples()
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).with_name("tracking_fidelity.js"),
    )
    args = parser.parse_args()
    analysis = build_analysis(args.input)
    payload = json.dumps(analysis, separators=(",", ":"), allow_nan=False)
    args.output.write_text(
        f"const TRACKING_FIDELITY = {payload};\n",
        encoding="utf-8",
    )
    print(
        "Wrote",
        args.output,
        "TAF",
        f"{analysis['summary']['tracking_fidelity']:.3f}",
    )


if __name__ == "__main__":
    main()
