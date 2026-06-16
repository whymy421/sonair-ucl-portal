# UCL Robotics — SONAIR Sub-Portal

Evidence dashboard for the **UCL–Nottingham UR5e teleoperation experiment**, built as the UCL campus node of the **SONAIR** federated robotics network.

🔗 **Live site:** https://whymy421.github.io/sonair-ucl-portal/

## Overview

This portal presents an interactive, evidence-based view of a remote-teleoperation study on a Universal Robots **UR5e** arm, quantifying the gap between simulation and reality under real network conditions. It serves as UCL's node in the SONAIR cross-institutional benchmarking effort, and is open to collaboration on federated robotics benchmarking and dataset sharing.

## Features

- **Interactive motion playback** — replay recorded UR5e trajectories with up to 16× playback speed.
- **Sim2Real gap metrics** — Temporal Fidelity Index (TFI), Tracking Accuracy and target-vs-actual tracking fidelity.
- **Network analysis** — round-trip-time (RTT) time series and command-latency profiling.
- **Five-step evidence story** — guided pipeline walking through the experimental findings.
- **Collapsible interpretation cards** — inline explanations alongside each chart.
- **UCL brand styling** — official UCL typography (DM Sans), colour palette and logo.

## Tech stack

- Static **HTML / CSS / JavaScript** (no build step)
- [Chart.js 4](https://www.chartjs.org/) + `chartjs-plugin-annotation` for visualisations
- Data served from local `*.js` data modules (`data.js`, `motion_data.js`, `tracking_error_data.js`, …)
- `generate_tracking_fidelity.py` for offline metric generation

## Project structure

| File | Purpose |
|------|---------|
| `index.html` | Main dashboard page and styling |
| `data.js`, `motion_data.js`, `tracking_error_data.js` | Experiment datasets |
| `motion_player.js` | UR5e motion-playback logic |
| `tracking_fidelity.js` | Tracking-fidelity chart rendering |
| `generate_tracking_fidelity.py` | Offline tracking-fidelity metric generation |
| `federation.json` | SONAIR federation node metadata |
| `theme.config.json` | Institution branding configuration |

## Running locally

It's a static site — serve the folder with any HTTP server:

```bash
python -m http.server 8000
# then open http://localhost:8000
```

## Contact

University College London — Robotics
📧 yutong.song.25@ucl.ac.uk
