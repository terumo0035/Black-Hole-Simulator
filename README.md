# Black Hole Simulator

A browser-based black hole flight simulator with a GR-inspired rendering model:
- Schwarzschild-like light bending
- accretion disk Doppler/gravitational shifting
- relativistic aberration and time-dilation telemetry

## How to test locally

### 1) Start a local web server
From this folder:

```bash
python3 -m http.server 4173
```

### 2) Open the simulator
In your browser, open:

- `http://localhost:4173`

### 3) Enter flight mode
- Click the canvas to lock the mouse pointer (cockpit free-look).
- Press `Esc` to release the pointer.

### 4) Fly around the black hole
- `W / S`: forward / backward thrust
- `A / D`: strafe left / right
- `Q / E`: up / down thrust
- Mouse move: look around

### 5) What to verify
- As you approach the hole, the warning banner appears.
- Near the hole, `dτ/dt` decreases and `dt/dτ` increases.
- Fast motion changes scene color/intensity due to Doppler-like shifts.
- Looking near the black hole edge shows strong lensing distortion.

## Notes
- This project is static HTML/CSS/JS and requires no build step.
- If pointer lock is unavailable in your browser, hold left mouse button and drag to look (fallback mode).
