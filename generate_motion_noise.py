"""Generate FFT-based motion noise evidence for the static portal."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd


SAMPLE_RATE_HZ = 4.0
HIGH_FREQUENCY_HZ = 0.75
POSITION_COLUMNS = ["x", "y", "z"]
ROTATION_COLUMNS = ["rx", "ry", "rz"]


def resample_motion(path: Path) -> tuple[np.ndarray, pd.DataFrame]:
    motion = pd.read_csv(path)
    timestamp = pd.to_datetime(motion["ts"], utc=True)
    elapsed = (timestamp - timestamp.iloc[0]).dt.total_seconds().to_numpy()
    uniform_time = np.arange(0, elapsed[-1] + 1 / SAMPLE_RATE_HZ, 1 / SAMPLE_RATE_HZ)
    values = {
        column: np.interp(uniform_time, elapsed, motion[column].to_numpy(float))
        for column in POSITION_COLUMNS + ROTATION_COLUMNS
    }
    return uniform_time, pd.DataFrame(values)


def axis_spectrum(values: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    sample_index = np.arange(len(values), dtype=float)
    trend = np.polyval(np.polyfit(sample_index, values, 1), sample_index)
    windowed = (values - trend) * np.hanning(len(values))
    power = np.abs(np.fft.rfft(windowed)) ** 2
    frequencies = np.fft.rfftfreq(len(values), 1 / SAMPLE_RATE_HZ)
    non_dc = frequencies > 0
    high_frequency = frequencies >= HIGH_FREQUENCY_HZ
    ratio = float(power[high_frequency].sum() / power[non_dc].sum())
    return frequencies, power, ratio


def group_spectrum(frame: pd.DataFrame, columns: list[str]) -> dict:
    spectra = []
    ratios = []
    frequencies = None
    for column in columns:
        frequencies, power, ratio = axis_spectrum(frame[column].to_numpy())
        spectra.append(power)
        ratios.append(ratio)
    mean_power = np.mean(spectra, axis=0)
    mean_power /= mean_power.max() or 1
    return {
        "frequencies": frequencies,
        "power": mean_power,
        "axis_ratios": ratios,
        "mean_ratio": float(np.mean(ratios)),
    }


def rolling_fidelity(time_s: np.ndarray, frame: pd.DataFrame) -> list[dict]:
    window_size = 128
    step_size = 16
    timeline = []
    for start in range(0, len(frame) - window_size + 1, step_size):
        stop = start + window_size
        window = frame.iloc[start:stop]
        position_ratio = group_spectrum(window, POSITION_COLUMNS)["mean_ratio"]
        rotation_ratio = group_spectrum(window, ROTATION_COLUMNS)["mean_ratio"]
        fidelity = (1 - position_ratio) * (1 - rotation_ratio)
        timeline.append(
            {
                "t": round(float(time_s[start + window_size // 2]), 2),
                "value": round(float(fidelity), 4),
            }
        )
    return timeline


def build_analysis(path: Path) -> dict:
    time_s, frame = resample_motion(path)
    position = group_spectrum(frame, POSITION_COLUMNS)
    rotation = group_spectrum(frame, ROTATION_COLUMNS)
    position_ratio = position["mean_ratio"]
    rotation_ratio = rotation["mean_ratio"]
    fidelity = (1 - position_ratio) * (1 - rotation_ratio)

    frequency_mask = (
        (position["frequencies"] > 0)
        & (position["frequencies"] <= SAMPLE_RATE_HZ / 2)
    )
    frequency_indices = np.flatnonzero(frequency_mask)
    chart_indices = frequency_indices[:: max(1, len(frequency_indices) // 120)]

    return {
        "meta": {
            "sample_rate_hz": SAMPLE_RATE_HZ,
            "high_frequency_hz": HIGH_FREQUENCY_HZ,
            "resampled_points": int(len(frame)),
            "duration_s": float(time_s[-1]),
        },
        "summary": {
            "position_high_frequency_ratio": position_ratio,
            "rotation_high_frequency_ratio": rotation_ratio,
            "motion_spectral_fidelity": fidelity,
            "position_axis_ratios": dict(
                zip(POSITION_COLUMNS, position["axis_ratios"], strict=True)
            ),
            "rotation_axis_ratios": dict(
                zip(ROTATION_COLUMNS, rotation["axis_ratios"], strict=True)
            ),
        },
        "spectrum": [
            {
                "frequency": round(float(position["frequencies"][index]), 4),
                "position_power": round(float(position["power"][index]), 6),
                "rotation_power": round(float(rotation["power"][index]), 6),
            }
            for index in chart_indices
        ],
        "timeline": rolling_fidelity(time_s, frame),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).with_name("motion_noise.js"),
    )
    args = parser.parse_args()
    analysis = build_analysis(args.input)
    payload = json.dumps(analysis, separators=(",", ":"), allow_nan=False)
    args.output.write_text(f"const MOTION_NOISE = {payload};\n", encoding="utf-8")
    print(
        "Wrote",
        args.output,
        "MSF",
        f"{analysis['summary']['motion_spectral_fidelity']:.3f}",
    )


if __name__ == "__main__":
    main()
