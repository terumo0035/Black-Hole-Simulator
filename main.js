const canvas = document.getElementById('glcanvas');
const gl = canvas.getContext('webgl');

if (!gl) {
    alert('WebGL not supported');
}

// -----------------------------------------------------------------------------
// Shaders
// -----------------------------------------------------------------------------

const vsSource = `
    attribute vec2 a_position;
    varying vec2 v_uv;
    void main() {
        v_uv = a_position * 0.5 + 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
    }
`;

const fsSource = `
    precision highp float;

    uniform vec2 u_resolution;
    uniform vec3 u_camPos;
    uniform vec3 u_camForward;
    uniform vec3 u_camRight;
    uniform vec3 u_camUp;
    uniform float u_time;
    uniform vec3 u_velocity;

    varying vec2 v_uv;

    const int MAX_STEPS = 700;
    const float RS = 1.0;
    const float M = 0.5 * RS;
    const float SPIN_ASTAR = 0.72;
    const float A = SPIN_ASTAR * M;
    const float DISK_OUTER = 18.0;
    const float DISK_HALF_THICKNESS = 0.01;

    float hash(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }

    float noise(vec3 x) {
        vec3 p = floor(x);
        vec3 f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
            mix(mix(hash(p + vec3(0.0, 0.0, 0.0)), hash(p + vec3(1.0, 0.0, 0.0)), f.x),
                mix(hash(p + vec3(0.0, 1.0, 0.0)), hash(p + vec3(1.0, 1.0, 0.0)), f.x), f.y),
            mix(mix(hash(p + vec3(0.0, 0.0, 1.0)), hash(p + vec3(1.0, 0.0, 1.0)), f.x),
                mix(hash(p + vec3(0.0, 1.0, 1.0)), hash(p + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
    }

    vec3 starfield(vec3 dir) {
        vec3 galPlaneNormal = normalize(vec3(0.0, 1.0, 0.18));

        float plane = 1.0 - abs(dot(dir, galPlaneNormal));
        float band = pow(clamp(plane, 0.0, 1.0), 5.0);

        float dustField = noise(dir * 46.0 + vec3(0.0, 0.0, u_time * 0.004));
        float dustLanes = smoothstep(0.42, 0.88, dustField) * band;
        vec3 dust = vec3(0.19, 0.13, 0.09) * band * (0.3 + 0.7 * noise(dir * 14.0));
        dust *= (1.0 - 0.8 * dustLanes);

        float denseStars = pow(noise(dir * 320.0), 48.0) * 7.5;
        float starClusters = pow(noise(dir * 120.0), 28.0) * 2.2;
        vec3 stars = vec3(denseStars + starClusters);

        vec3 baseline = vec3(0.012, 0.013, 0.02);

        return stars + dust + baseline;
    }

    vec3 dopplerTint(vec3 c, float shift) {
        vec3 red = vec3(c.r + 0.2 * c.g, c.g * 0.6, c.b * 0.45);
        vec3 blue = vec3(c.r * 0.6, c.g + 0.25 * c.b, c.b + 0.4 * c.g);
        float tBlue = smoothstep(1.0, 1.8, shift);
        float tRed = smoothstep(1.0, 0.45, shift);
        vec3 tinted = mix(c, blue, tBlue);
        tinted = mix(tinted, red, tRed);
        return tinted;
    }

    float kerrHorizon() {
        return M + sqrt(max(0.0, M * M - A * A));
    }

    float kerrIscoprograde() {
        float z1 = 1.0 + pow(1.0 - SPIN_ASTAR * SPIN_ASTAR, 1.0 / 3.0)
            * (pow(1.0 + SPIN_ASTAR, 1.0 / 3.0) + pow(1.0 - SPIN_ASTAR, 1.0 / 3.0));
        float z2 = sqrt(3.0 * SPIN_ASTAR * SPIN_ASTAR + z1 * z1);
        float riscoM = 3.0 + z2 - sqrt((3.0 - z1) * (3.0 + z1 + 2.0 * z2));
        return max(kerrHorizon() * 1.05, 0.5 * riscoM);
    }

    float frameDragOmega(float r) {
        return (2.0 * A * M) / max(0.0002, r * r * r + A * A * r);
    }

    void main() {
        vec2 uv = (v_uv - 0.5) * 2.0;
        uv.x *= u_resolution.x / u_resolution.y;

        vec3 ro = u_camPos;
        vec3 rd = normalize(u_camForward + uv.x * u_camRight + uv.y * u_camUp);

        float speed = length(u_velocity);
        if (speed > 0.0005) {
            vec3 beta = u_velocity / speed;
            float gamma = 1.0 / sqrt(max(0.0004, 1.0 - speed * speed));
            float rdPar = dot(rd, beta);
            vec3 par = rdPar * beta;
            vec3 perp = rd - par;
            rd = normalize((par + beta * speed) + perp / gamma);
        }

        vec3 pos = ro;
        vec3 dir = rd;

        vec3 diskAccum = vec3(0.0);
        float diskAlpha = 0.0;
        vec3 outColor = starfield(dir);
        bool hitHorizon = false;
        bool escaped = false;
        float diskInner = kerrIscoprograde();

        for (int i = 0; i < MAX_STEPS; i++) {
            float r2 = dot(pos, pos);
            float r = sqrt(r2);
            float horizonR = kerrHorizon() * 1.0002;
            if (r <= horizonR) {
                outColor = diskAccum;
                hitHorizon = true;
                break;
            }

            vec3 L = cross(pos, dir);
            float L2 = dot(L, L);
            vec3 accel = -1.5 * RS * L2 * pos / max(0.0001, (r2 * r2 * r));
            vec3 azimuth = cross(vec3(0.0, 1.0, 0.0), pos);
            float azLen = length(azimuth);
            if (azLen > 0.0001) {
                azimuth /= azLen;
            } else {
                azimuth = vec3(1.0, 0.0, 0.0);
            }
            float omegaFd = frameDragOmega(r);
            vec3 dragAccel = azimuth * omegaFd * (0.35 + 0.65 * abs(dot(dir, azimuth)));
            accel += dragAccel * 0.55;

            float stepScale = clamp(0.010 * r + 0.0045, 0.0025, 0.095);
            if (r < DISK_OUTER * 1.25 && abs(pos.y) < DISK_HALF_THICKNESS * 3.0) {
                stepScale *= 0.6;
            }
            dir = normalize(dir + accel * stepScale);
            vec3 nextPos = pos + dir * stepScale;

            vec3 seg = nextPos - pos;
            float aSeg = dot(seg, seg);
            float bSeg = 2.0 * dot(pos, seg);
            float cSeg = dot(pos, pos) - horizonR * horizonR;
            float hDisc = bSeg * bSeg - 4.0 * aSeg * cSeg;
            bool horizonCrossed = false;
            float tHorizon = 2.0;
            if (hDisc >= 0.0) {
                float sqrtDisc = sqrt(hDisc);
                float inv2a = 0.5 / max(aSeg, 0.000001);
                float t0 = (-bSeg - sqrtDisc) * inv2a;
                float t1 = (-bSeg + sqrtDisc) * inv2a;
                if (t0 >= 0.0 && t0 <= 1.0) {
                    tHorizon = t0;
                    horizonCrossed = true;
                } else if (t1 >= 0.0 && t1 <= 1.0) {
                    tHorizon = t1;
                    horizonCrossed = true;
                }
            }

            bool entersUpper = (pos.y - DISK_HALF_THICKNESS) * (nextPos.y - DISK_HALF_THICKNESS) <= 0.0;
            bool entersLower = (pos.y + DISK_HALF_THICKNESS) * (nextPos.y + DISK_HALF_THICKNESS) <= 0.0;
            bool segmentInsideSlab = abs(pos.y) <= DISK_HALF_THICKNESS || abs(nextPos.y) <= DISK_HALF_THICKNESS;
            if (entersUpper || entersLower || segmentInsideSlab) {
                bool nearDiskForSupersample = (r < DISK_OUTER * 1.1);
                for (int j = 0; j < 2; j++) {
                    if (j == 1 && !nearDiskForSupersample) break;
                    float tSample = (j == 0) ? 0.4 : 0.75;
                    if (horizonCrossed && tSample >= tHorizon) continue;
                    vec3 hitPos = mix(pos, nextPos, tSample);
                    if (abs(hitPos.y) > DISK_HALF_THICKNESS) continue;

                    float diskR = length(hitPos.xz);
                    if (diskR > diskInner && diskR < DISK_OUTER) {
                        float vkBase = sqrt(M / max(0.0005, diskR));
                        float spinBoost = 1.0 + 0.45 * SPIN_ASTAR / pow(max(1.0, diskR), 1.5);
                        float vk = clamp(vkBase * spinBoost, 0.0, 0.82);
                        vec3 diskVel = normalize(vec3(-hitPos.z, 0.0, hitPos.x)) * vk;

                        float gammaDisk = 1.0 / sqrt(max(0.0004, 1.0 - vk * vk));
                        float D = 1.0 / (gammaDisk * (1.0 - dot(diskVel, -dir)));
                        float grav = sqrt(max(0.001, 1.0 - RS / diskR + (A * A) / (diskR * diskR)));
                        float shift = D * grav;

                        float turbulence = noise(vec3(hitPos.xz * 3.2, 0.0));
                        float relR = clamp((diskR - diskInner) / (DISK_OUTER - diskInner), 0.0, 1.0);

                        float thinProfile = exp(-pow((relR - 0.24) / 0.25, 2.0));
                        float outerFade = 1.0 - smoothstep(0.78, 1.0, relR);
                        float density = thinProfile * outerFade * (0.85 + 0.3 * turbulence);
                        float ring = exp(-pow((diskR - (diskInner + 0.2)) / 0.13, 2.0));

                        float heat = clamp(1.0 - relR, 0.0, 1.0);
                        vec3 base = mix(vec3(1.0, 0.7, 0.38), vec3(1.0, 0.98, 0.9), pow(heat, 1.8));
                        vec3 emission = base * density * 1.55 + vec3(1.35, 1.18, 1.0) * ring * 4.0;
                        vec3 shifted = dopplerTint(emission * pow(shift, 3.35), shift);

                        float alpha = clamp((density * 0.62 + ring * 0.72) * 0.55, 0.0, 0.995);
                        diskAccum += (1.0 - diskAlpha) * shifted * alpha;
                        diskAlpha += (1.0 - diskAlpha) * alpha;
                    }
                }
            }

            if (horizonCrossed) {
                outColor = diskAccum;
                hitHorizon = true;
                break;
            }

            pos = nextPos;

            if (r > max(140.0, length(u_camPos) + 65.0)) {
                vec3 bg = starfield(dir);
                float observerShift = 1.0;
                if (speed > 0.0005) {
                    float gammaObs = 1.0 / sqrt(max(0.0004, 1.0 - speed * speed));
                    observerShift = 1.0 / (gammaObs * (1.0 - dot(dir, u_velocity)));
                }

                vec3 lensed = dopplerTint(bg, observerShift) * pow(observerShift, 1.6);
                outColor = diskAccum + (1.0 - diskAlpha) * lensed;
                escaped = true;
                break;
            }
        }

        // If integration ended by max steps, use the final bent ray direction for background.
        if (!hitHorizon && !escaped) {
            float observerShift = 1.0;
            if (speed > 0.0005) {
                float gammaObs = 1.0 / sqrt(max(0.0004, 1.0 - speed * speed));
                observerShift = 1.0 / (gammaObs * (1.0 - dot(dir, u_velocity)));
            }
            vec3 bg = starfield(dir);
            vec3 lensed = dopplerTint(bg, observerShift) * pow(observerShift, 1.6);
            outColor = diskAccum + (1.0 - diskAlpha) * lensed;
        }

        vec2 vignetteUv = (v_uv - 0.5) * 2.0;
        float edge = length(vignetteUv);
        float vignette = mix(1.0, 0.82, smoothstep(0.75, 1.45, edge));
        outColor *= vignette;
        gl_FragColor = vec4(outColor, 1.0);
    }
`;

// -----------------------------------------------------------------------------
// WebGL setup
// -----------------------------------------------------------------------------

function compileShader(glCtx, source, type) {
    const shader = glCtx.createShader(type);
    glCtx.shaderSource(shader, source);
    glCtx.compileShader(shader);
    if (!glCtx.getShaderParameter(shader, glCtx.COMPILE_STATUS)) {
        console.error('Shader compile error: ' + glCtx.getShaderInfoLog(shader));
        glCtx.deleteShader(shader);
        return null;
    }
    return shader;
}

const vertexShader = compileShader(gl, vsSource, gl.VERTEX_SHADER);
const fragmentShader = compileShader(gl, fsSource, gl.FRAGMENT_SHADER);
if (!vertexShader || !fragmentShader) {
    throw new Error('Shader compilation failed; see console for details.');
}

const program = gl.createProgram();
gl.attachShader(program, vertexShader);
gl.attachShader(program, fragmentShader);
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Program link error: ' + gl.getProgramInfoLog(program));
    throw new Error('WebGL program link failed; see console for details.');
}

const positionAttributeLocation = gl.getAttribLocation(program, 'a_position');
const positionBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,
    1, -1,
    -1, 1,
    -1, 1,
    1, -1,
    1, 1,
]), gl.STATIC_DRAW);

const uniformLocs = {
    resolution: gl.getUniformLocation(program, 'u_resolution'),
    camPos: gl.getUniformLocation(program, 'u_camPos'),
    camForward: gl.getUniformLocation(program, 'u_camForward'),
    camRight: gl.getUniformLocation(program, 'u_camRight'),
    camUp: gl.getUniformLocation(program, 'u_camUp'),
    time: gl.getUniformLocation(program, 'u_time'),
    velocity: gl.getUniformLocation(program, 'u_velocity'),
};

// -----------------------------------------------------------------------------
// Physics and free-flight controls
// -----------------------------------------------------------------------------

const RS = 1.0;
const C = 1.0;
const M_SIM = 0.5 * RS;
const BH_SPIN_ASTAR = 0.72;
const KERR_A_SIM = BH_SPIN_ASTAR * M_SIM;
const HORIZON_RS = M_SIM + Math.sqrt(Math.max(0, M_SIM * M_SIM - KERR_A_SIM * KERR_A_SIM));
const GM = M_SIM;
const SGR_A_MASS_SOLAR = 4.154e6;
const SOLAR_MASS_KG = 1.98847e30;
const G_SI = 6.67430e-11;
const C_SI = 299792458;
const AU_METERS = 149597870700;
const sgrAMassKg = SGR_A_MASS_SOLAR * SOLAR_MASS_KG;
const sgrARSmeters = (2 * G_SI * sgrAMassKg) / (C_SI * C_SI);
const kerrASiMeters = 0.5 * BH_SPIN_ASTAR * sgrARSmeters;

let camPos = glMatrix.vec3.fromValues(0.0, 1.5, 14.0);
let camForward = glMatrix.vec3.fromValues(0.0, -0.1, -1.0);
let camUp = glMatrix.vec3.fromValues(0.0, 1.0, 0.0);
let camRight = glMatrix.vec3.create();
glMatrix.vec3.cross(camRight, camForward, camUp);
glMatrix.vec3.normalize(camForward, camForward);
glMatrix.vec3.normalize(camRight, camRight);

let velocity = glMatrix.vec3.create();
const keys = Object.create(null);

let pointerLocked = false;
let dragging = false;
let lastMouseX = 0;
let lastMouseY = 0;

function rebuildBasis() {
    glMatrix.vec3.normalize(camForward, camForward);
    glMatrix.vec3.cross(camRight, camForward, camUp);
    glMatrix.vec3.normalize(camRight, camRight);
    glMatrix.vec3.cross(camUp, camRight, camForward);
    glMatrix.vec3.normalize(camUp, camUp);
}

function rotateCamera(dx, dy) {
    const sensitivity = 0.0018;

    const yaw = glMatrix.mat4.create();
    glMatrix.mat4.rotate(yaw, yaw, -dx * sensitivity, camUp);
    glMatrix.vec3.transformMat4(camForward, camForward, yaw);

    glMatrix.vec3.cross(camRight, camForward, camUp);
    glMatrix.vec3.normalize(camRight, camRight);

    const pitch = glMatrix.mat4.create();
    glMatrix.mat4.rotate(pitch, pitch, -dy * sensitivity, camRight);
    const nextForward = glMatrix.vec3.create();
    glMatrix.vec3.transformMat4(nextForward, camForward, pitch);

    const verticalDot = Math.abs(glMatrix.vec3.dot(nextForward, camUp));
    if (verticalDot < 0.995) {
        glMatrix.vec3.copy(camForward, nextForward);
    }

    rebuildBasis();
}

window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    keys[k] = true;

    if (k === ' ') {
        e.preventDefault();
    }
});

window.addEventListener('keyup', (e) => {
    keys[e.key.toLowerCase()] = false;
});

canvas.addEventListener('click', () => {
    if (canvas.requestPointerLock) {
        canvas.requestPointerLock();
    }
});

document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === canvas;
});

canvas.addEventListener('mousedown', (e) => {
    dragging = true;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
});

window.addEventListener('mouseup', () => {
    dragging = false;
});

window.addEventListener('mousemove', (e) => {
    if (pointerLocked) {
        rotateCamera(e.movementX, e.movementY);
        return;
    }

    if (!dragging) return;
    const dx = e.clientX - lastMouseX;
    const dy = e.clientY - lastMouseY;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    rotateCamera(dx, dy);
});

// -----------------------------------------------------------------------------
// UI
// -----------------------------------------------------------------------------

const uiDist = document.getElementById('dist-val');
const uiDistHorizon = document.getElementById('dist-horizon-val');
const uiMass = document.getElementById('mass-val');
const uiSpin = document.getElementById('spin-val');
const uiVel = document.getElementById('vel-val');
const uiTime = document.getElementById('time-val');
const uiShift = document.getElementById('shift-val');
const uiProper = document.getElementById('proper-val');
const uiCoordClock = document.getElementById('coord-clock');
const fixToggleBtn = document.getElementById('fix-toggle');
const transportRsInput = document.getElementById('transport-rs-input');
const transportBtn = document.getElementById('transport-btn');
const warningBanner = document.getElementById('warning-banner');

if (uiMass) {
    uiMass.textContent = SGR_A_MASS_SOLAR.toExponential(3);
}
if (uiSpin) {
    uiSpin.textContent = BH_SPIN_ASTAR.toFixed(2);
}

function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    gl.viewport(0, 0, canvas.width, canvas.height);
}
window.addEventListener('resize', resize);
resize();

// -----------------------------------------------------------------------------
// Main loop
// -----------------------------------------------------------------------------

let lastTime = 0;
let accumulatedProperTime = 0;
let accumulatedCoordinateTime = 0;
let isPositionFixed = false;
let fixedPosition = glMatrix.vec3.clone(camPos);
let orbitLockActive = false;
let orbitLockRadiusRs = 0;

function syncFixButton() {
    if (!fixToggleBtn) return;
    fixToggleBtn.textContent = isPositionFixed ? 'FIX: ON' : 'FIX: OFF';
    fixToggleBtn.classList.toggle('active', isPositionFixed);
}

function setFixedMode(enabled) {
    isPositionFixed = enabled;
    if (isPositionFixed) {
        glMatrix.vec3.copy(fixedPosition, camPos);
        glMatrix.vec3.set(velocity, 0, 0, 0);
        orbitLockActive = false;
    }
    syncFixButton();
}

function transportFromHorizonOffsetRs(offsetRs) {
    const parsed = Number(offsetRs);
    if (!Number.isFinite(parsed)) return false;

    const offset = Math.max(0, parsed);
    const targetRadiusRs = HORIZON_RS + offset;

    const radialDir = glMatrix.vec3.clone(camPos);
    if (glMatrix.vec3.length(radialDir) < 0.00001) {
        glMatrix.vec3.set(radialDir, 0, 0, 1);
    } else {
        glMatrix.vec3.normalize(radialDir, radialDir);
    }

    glMatrix.vec3.scale(camPos, radialDir, targetRadiusRs);

    // Set an immediate prograde tangential velocity so the ship starts orbiting.
    const azimuthDir = glMatrix.vec3.fromValues(-camPos[2], 0, camPos[0]);
    if (glMatrix.vec3.length(azimuthDir) < 0.00001) {
        glMatrix.vec3.set(azimuthDir, 1, 0, 0);
    } else {
        glMatrix.vec3.normalize(azimuthDir, azimuthDir);
    }

    const vNewton = Math.sqrt(Math.max(0.0001, GM / targetRadiusRs));
    const spinBoost = 1 + (0.35 * BH_SPIN_ASTAR) / Math.pow(Math.max(1.0, targetRadiusRs), 1.5);
    const orbitSpeed = Math.min(0.88, vNewton * spinBoost);
    glMatrix.vec3.scale(velocity, azimuthDir, orbitSpeed);

    orbitLockRadiusRs = targetRadiusRs;
    orbitLockActive = true;
    setFixedMode(false);
    return true;
}

if (fixToggleBtn) {
    fixToggleBtn.addEventListener('click', () => {
        setFixedMode(!isPositionFixed);
    });
    syncFixButton();
}

if (transportBtn && transportRsInput) {
    const runTransport = () => {
        const ok = transportFromHorizonOffsetRs(transportRsInput.value);
        if (!ok) return;
        transportRsInput.value = '';
    };

    transportBtn.addEventListener('click', runTransport);
    transportRsInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            runTransport();
        }
    });
}

function formatClock(seconds) {
    const s = Math.max(0, seconds);
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const secs = Math.floor(s % 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function updatePhysics(dt) {
    const r = glMatrix.vec3.length(camPos);
    const radialUnit = glMatrix.vec3.create();
    glMatrix.vec3.scale(radialUnit, camPos, 1 / Math.max(0.0001, r));

    if (isPositionFixed) {
        glMatrix.vec3.copy(camPos, fixedPosition);
        glMatrix.vec3.set(velocity, 0, 0, 0);
    } else {
        const gravity = glMatrix.vec3.create();
        const gMag = GM / Math.max(0.02, r * r);
        glMatrix.vec3.scale(gravity, radialUnit, -gMag);

        const frameDragAccel = glMatrix.vec3.create();
        const azimuthDir = glMatrix.vec3.fromValues(-camPos[2], 0, camPos[0]);
        if (glMatrix.vec3.length(azimuthDir) > 0.0001) {
            glMatrix.vec3.normalize(azimuthDir, azimuthDir);
            const omegaFd = (2 * KERR_A_SIM * M_SIM) / Math.max(0.02, r * r * r + KERR_A_SIM * KERR_A_SIM * r);
            const velDir = glMatrix.vec3.create();
            if (glMatrix.vec3.length(velocity) > 0.0001) {
                glMatrix.vec3.normalize(velDir, velocity);
            } else {
                glMatrix.vec3.copy(velDir, camForward);
            }
            const align = Math.abs(glMatrix.vec3.dot(velDir, azimuthDir));
            glMatrix.vec3.scale(frameDragAccel, azimuthDir, omegaFd * (0.2 + 0.8 * align));
        }

        const thrust = glMatrix.vec3.create();
        const thrustPower = 0.9;
        if (keys.w) glMatrix.vec3.scaleAndAdd(thrust, thrust, camForward, thrustPower);
        if (keys.r) glMatrix.vec3.scaleAndAdd(thrust, thrust, camForward, -thrustPower);
        if (keys.a) glMatrix.vec3.scaleAndAdd(thrust, thrust, camRight, -thrustPower);
        if (keys.s) glMatrix.vec3.scaleAndAdd(thrust, thrust, camRight, thrustPower);
        if (keys.q) glMatrix.vec3.scaleAndAdd(thrust, thrust, camUp, thrustPower);
        if (keys.e) glMatrix.vec3.scaleAndAdd(thrust, thrust, camUp, -thrustPower);

        const totalAccel = glMatrix.vec3.create();
        glMatrix.vec3.add(totalAccel, gravity, thrust);
        glMatrix.vec3.add(totalAccel, totalAccel, frameDragAccel);

        glMatrix.vec3.scaleAndAdd(velocity, velocity, totalAccel, dt);

        const speed = glMatrix.vec3.length(velocity);
        if (speed > 0.995 * C) {
            glMatrix.vec3.scale(velocity, velocity, (0.995 * C) / speed);
        }

        glMatrix.vec3.scaleAndAdd(camPos, camPos, velocity, dt);

        const newR = glMatrix.vec3.length(camPos);
        const horizonGuard = HORIZON_RS * 1.00001;
        if (newR <= horizonGuard) {
            const safeScale = horizonGuard / Math.max(0.0001, newR);
            glMatrix.vec3.scale(camPos, camPos, safeScale);

            // Keep motion along the horizon edge by canceling only inward radial velocity.
            const radialDir = glMatrix.vec3.create();
            glMatrix.vec3.normalize(radialDir, camPos);
            const inwardSpeed = glMatrix.vec3.dot(velocity, radialDir);
            if (inwardSpeed < 0.0) {
                glMatrix.vec3.scaleAndAdd(velocity, velocity, radialDir, -inwardSpeed);
            }
            // No heavy damping here; preserve lateral control near the edge.
            glMatrix.vec3.scale(velocity, velocity, 0.9995);
        }

        if (orbitLockActive) {
            const radialDirLock = glMatrix.vec3.clone(camPos);
            if (glMatrix.vec3.length(radialDirLock) > 0.000001) {
                glMatrix.vec3.normalize(radialDirLock, radialDirLock);

                // Keep exact orbital radius and remove radial drift.
                glMatrix.vec3.scale(camPos, radialDirLock, orbitLockRadiusRs);
                const vRadialLock = glMatrix.vec3.dot(velocity, radialDirLock);
                glMatrix.vec3.scaleAndAdd(velocity, velocity, radialDirLock, -vRadialLock);

                // Stabilize tangential speed around circular-orbit estimate.
                const vTarget = Math.min(0.88, Math.sqrt(Math.max(0.0001, GM / orbitLockRadiusRs)));
                const vTan = glMatrix.vec3.length(velocity);
                if (vTan < 0.0001) {
                    const azimuthDirLock = glMatrix.vec3.fromValues(-camPos[2], 0, camPos[0]);
                    if (glMatrix.vec3.length(azimuthDirLock) > 0.000001) {
                        glMatrix.vec3.normalize(azimuthDirLock, azimuthDirLock);
                        glMatrix.vec3.scale(velocity, azimuthDirLock, vTarget);
                    }
                } else {
                    glMatrix.vec3.scale(velocity, velocity, vTarget / vTan);
                }
            }
        }
    }

    const radiusSim = glMatrix.vec3.length(camPos);
    const radiusMeters = Math.max(HORIZON_RS * sgrARSmeters * 1.00001, radiusSim * sgrARSmeters);
    const speed = glMatrix.vec3.length(velocity);
    const vFrac = Math.min(0.999, speed / C);

    // Kerr-inspired proper-time flow with spin/frame-dragging corrections.
    const lapse = Math.max(
        0.0005,
        1 - (2 * G_SI * sgrAMassKg) / (radiusMeters * C_SI * C_SI) + (kerrASiMeters * kerrASiMeters) / (radiusMeters * radiusMeters),
    );
    const vRadial = glMatrix.vec3.dot(velocity, radialUnit);
    const betaRadial = vRadial / C;
    const betaRadial2 = betaRadial * betaRadial;
    const betaTangential = Math.sqrt(Math.max(0, vFrac * vFrac - betaRadial2));
    const omegaFrame = (C_SI * sgrARSmeters * kerrASiMeters) / Math.max(1.0, radiusMeters * radiusMeters * radiusMeters + kerrASiMeters * kerrASiMeters * radiusMeters);
    const betaFrame = Math.min(0.75, Math.abs(omegaFrame) * radiusMeters / C_SI);
    const angularMomentumY = camPos[0] * velocity[2] - camPos[2] * velocity[0];
    const progradeSign = angularMomentumY >= 0 ? 1 : -1;
    const betaTangentialRel = betaTangential - progradeSign * betaFrame;
    const dTauDtSq = lapse - (betaRadial2 / lapse) - betaTangentialRel * betaTangentialRel;
    const dTauDt = Math.sqrt(Math.max(0.00001, dTauDtSq));
    accumulatedProperTime += dt * dTauDt;
    const dtOverDTau = 1 / Math.max(0.001, dTauDt);
    accumulatedCoordinateTime += dt * dtOverDTau;

    const distRs = radiusMeters / sgrARSmeters;
    const distToHorizonRs = Math.max(0, distRs - HORIZON_RS);
    uiDist.textContent = distRs.toFixed(6);
    if (uiDistHorizon) {
        uiDistHorizon.textContent = distToHorizonRs.toFixed(6);
    }
    uiVel.textContent = (vFrac * 100).toFixed(2);
    uiTime.textContent = dTauDt.toFixed(4);
    uiShift.textContent = dtOverDTau.toFixed(3);
    uiProper.textContent = accumulatedProperTime.toFixed(2);
    if (uiCoordClock) {
        uiCoordClock.textContent = formatClock(accumulatedCoordinateTime);
    }

    if (glMatrix.vec3.length(camPos) < HORIZON_RS * 1.6) {
        warningBanner.classList.remove('hidden');
    } else {
        warningBanner.classList.add('hidden');
    }
}

function render(timestamp) {
    const time = timestamp * 0.001;
    const dt = Math.min(0.05, Math.max(0.0, time - lastTime));
    lastTime = time;

    updatePhysics(dt);

    gl.useProgram(program);
    gl.enableVertexAttribArray(positionAttributeLocation);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(uniformLocs.resolution, canvas.width, canvas.height);
    gl.uniform3f(uniformLocs.camPos, camPos[0], camPos[1], camPos[2]);
    gl.uniform3f(uniformLocs.camForward, camForward[0], camForward[1], camForward[2]);
    gl.uniform3f(uniformLocs.camRight, camRight[0], camRight[1], camRight[2]);
    gl.uniform3f(uniformLocs.camUp, camUp[0], camUp[1], camUp[2]);
    gl.uniform1f(uniformLocs.time, time);

    const beta = [velocity[0] / C, velocity[1] / C, velocity[2] / C];
    gl.uniform3f(uniformLocs.velocity, beta[0], beta[1], beta[2]);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    requestAnimationFrame(render);
}

requestAnimationFrame((t) => {
    lastTime = t * 0.001;
    requestAnimationFrame(render);
});
