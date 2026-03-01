# Black Hole Flight Simulator

A browser-based Kerr black hole flight simulator (static HTML/CSS/JS) with real-time flight controls, relativistic rendering, and educational end-scene messaging.

## Current highlights

- Kerr geometry-inspired motion and light-bending visuals
- Frame dragging contribution in camera dynamics and ray integration
- Accretion disc with:
  - spin-direction-dependent rotation
  - cloud-wave texture flow
  - Doppler/beaming/gravitational color shifts
  - runtime controls for intensity, temperature tint, thickness, and density
- Real-time telemetry:
  - distance to center (`R_S`)
  - distance to horizon (`R_S`)
  - velocity (`%c`)
  - `dτ/dt`, `dt/dτ`
  - proper-time and coordinate-time clock
- Configurable key bindings (with local persistence)
- Ending scene when:
  - event horizon is reached
  - or distance to horizon is below `0.1 R_S`

## Startup defaults

- Mass: `7,000,000 M☉`
- Starting radius: `20 R_S`
- Starting position: slightly above disc plane
- Disc defaults:
  - thickness: `0.220`
  - density: `1.00`

## Run locally

From project root:

```bash
python3 -m http.server 4173
```

Open:

- `http://localhost:4173`

## Controls

### Mouse look

- Hold left mouse button: lock pointer and freelook
- Release left mouse button: unlock pointer

### Flight controls (default bindings)

- `W / S`: forward / backward
- `A / D`: strafe left / right
- `Q / E`: lift / dive

### In-app binding configuration

- Open `KEY BINDINGS` in the flight panel
- Click an action button, then press a key to rebind
- `Esc` cancels a pending rebind
- `RESET BINDINGS` restores defaults
- Bindings are saved to `localStorage` (`bhsim_key_bindings_v1`)

## UI panels

- **Flight controls panel**:
  - FIX mode toggle
  - BRAKE
  - mass + spin controls
  - jump from horizon (`R_S`)
  - expandable key-binding settings
- **Accretion disc panel**:
  - enable/disable
  - intensity
  - temperature tint
  - thickness
  - density

## Notes

- Mass range: `[1e6, 1e7] M☉`
- Spin range: `[-0.999, 0.999]`
- Disc thickness range: `[0.005, 0.500] R_S`
- Disc density range: `[0.10, 3.00]`
- Jump targets at/inside prograde ISCO are blocked
- No build step required (pure static frontend)
