# Black Hole Flight Simulator

A browser-based Kerr black hole flight simulator with live mass and spin control:
- Kerr horizon radius from `a*` (`r+ = M + sqrt(M^2 - a^2)`)
- frame-dragging term coupled into both camera motion and light-bending integration
- thin equatorial accretion disk with ISCO inner edge, turbulence, Doppler beaming, and gravitational shifts
- relativistic aberration + Doppler shift + gravitational shift
- time dilation telemetry via local lapse and Lorentz factor (`dτ/dt = α/γ`)
- mass can be adjusted in real time (`1e6` to `1e7` solar masses)

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
- `W / R`: forward / backward thrust
- `A / S`: strafe left / right
- `Q / F`: up / down thrust
- Mouse move: look around
- Use the `Mass (M☉)` slider or numeric input to change mass in real time.
- Use the `Kerr spin a*` slider or numeric input to freely change spin in real time.
- `Jump from horizon (R_S)` inserts you into a fixed-radius prograde orbit lock.

### 5) What to verify
- As you approach the hole, the warning banner appears.
- Near the hole, `dτ/dt` decreases and `dt/dτ` increases.
- Fast motion changes scene color/intensity due to relativistic Doppler shift.
- Looking near the black hole edge shows strong lensing distortion.

## Notes
- This project is static HTML/CSS/JS and requires no build step.
- If pointer lock is unavailable in your browser, hold left mouse button and drag to look (fallback mode).
- Mass is clamped to `[1e6, 1e7]` solar masses.
- `a*` is clamped to `[-0.999, 0.999]`.
- Jump targets at or inside prograde ISCO are blocked.
- User thrust is modeled as rocket proper acceleration in a local ZAMO-like frame.
