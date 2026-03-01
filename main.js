const canvas = document.getElementById('glcanvas');
const gl = canvas.getContext('webgl');

if (!gl) {
    alert('WebGL not supported');
}

// -----------------------------------------------------------------------------
// Shared simulation parameters (geometric units: c = G = 1)
// -----------------------------------------------------------------------------

const REFERENCE_MASS_SOLAR = 4.154e6;
const REFERENCE_M_SIM = 0.5; // reference geometric mass used at REFERENCE_MASS_SOLAR
const INITIAL_SPIN_ASTAR = 0.6;
const PHYSICS_MODE = 'kerr-geodesic';

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
    uniform vec3 u_velocity; // local physical beta in a ZAMO-like frame
    uniform float u_spinAstar;
    uniform float u_massM;
    uniform float u_discEnabled;
    uniform float u_discIntensity;
    uniform float u_discTemp;
    uniform float u_discThickness;
    uniform float u_discInner;
    uniform float u_discOuter;

    varying vec2 v_uv;

    const int MAX_STEPS = 700;

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
        float tRed = 1.0 - smoothstep(0.45, 1.0, shift);
        vec3 tinted = mix(c, blue, tBlue);
        tinted = mix(tinted, red, tRed);
        return tinted;
    }

    float kerrA() {
        float M = u_massM;
        return u_spinAstar * M;
    }

    float kerrHorizon() {
        float M = u_massM;
        float a = kerrA();
        return M + sqrt(max(0.0, M * M - a * a));
    }

    float kerrLapse(float r) {
        float M = u_massM;
        float rr = max(kerrHorizon() * 1.0004, r);
        float a = kerrA();
        float delta = rr * rr - 2.0 * M * rr + a * a;
        float Aterm = (rr * rr + a * a) * (rr * rr + a * a) - a * a * delta;
        return sqrt(max(1e-8, (delta * rr * rr) / max(1e-8, Aterm)));
    }

    float frameDragOmega(float r) {
        float M = u_massM;
        float rr = max(kerrHorizon() * 1.0004, r);
        float a = kerrA();
        return (2.0 * a * M) / max(1e-7, rr * rr * rr + a * a * rr);
    }

    vec3 aberrateToZamoFrame(vec3 nObs, vec3 beta) {
        float b2 = dot(beta, beta);
        if (b2 < 1e-8) {
            return nObs;
        }

        float gamma = 1.0 / sqrt(max(1e-6, 1.0 - b2));
        float bDotN = dot(beta, nObs);
        float denom = max(1e-5, 1.0 + bDotN);

        vec3 term = beta * (1.0 + (gamma / (gamma + 1.0)) * bDotN);
        vec3 nLocal = (nObs / gamma + term) / denom;
        return normalize(nLocal);
    }

    float observedShift(vec3 dirLocal, vec3 beta, float rObs) {
        float b2 = dot(beta, beta);
        float gamma = 1.0 / sqrt(max(1e-6, 1.0 - b2));

        // Incoming photon direction is -dirLocal.
        float doppler = gamma * (1.0 + dot(beta, dirLocal));

        // Source at infinity -> local observer at radius r.
        float grav = 1.0 / kerrLapse(rObs);

        return clamp(doppler * grav, 0.08, 8.0);
    }

    vec3 discSpectrum(float heat) {
        vec3 hot = vec3(1.0, 0.93, 0.82);
        vec3 warm = vec3(1.0, 0.70, 0.33);
        vec3 cool = vec3(0.95, 0.44, 0.16);
        vec3 base = mix(cool, warm, smoothstep(0.10, 0.60, heat));
        return mix(base, hot, smoothstep(0.55, 1.00, heat));
    }

    void main() {
        vec2 uv = (v_uv - 0.5) * 2.0;
        uv.x *= u_resolution.x / u_resolution.y;

        vec3 ro = u_camPos;
        vec3 rdObs = normalize(u_camForward + uv.x * u_camRight + uv.y * u_camUp);
        vec3 rd = aberrateToZamoFrame(rdObs, u_velocity);

        vec3 pos = ro;
        vec3 dir = rd;

        vec3 outColor = vec3(0.0);
        vec3 discEmission = vec3(0.0);
        float discOpacity = 0.0;
        bool hitHorizon = false;
        bool escaped = false;

        float horizonR = kerrHorizon() * 1.0002;
        float rObs = length(u_camPos);

        for (int i = 0; i < MAX_STEPS; i++) {
            float r2 = dot(pos, pos);
            float r = sqrt(r2);

            if (r <= horizonR) {
                outColor = vec3(0.0);
                hitHorizon = true;
                break;
            }

            vec3 L = cross(pos, dir);
            float L2 = dot(L, L);
            float RS = 2.0 * u_massM;
            vec3 accel = -1.5 * RS * L2 * pos / max(1e-6, r2 * r2 * r);

            vec3 azimuth = cross(vec3(0.0, 1.0, 0.0), pos);
            float azLen = length(azimuth);
            if (azLen > 1e-4) {
                azimuth /= azLen;
            } else {
                azimuth = vec3(1.0, 0.0, 0.0);
            }

            float omegaFd = frameDragOmega(r);
            float dragGain = 0.45 + 0.55 * abs(dot(dir, azimuth));
            accel += azimuth * omegaFd * dragGain * 0.85;

            float stepScale = clamp(0.002 + 0.010 * r, 0.00035, 0.085);
            float nearBh = smoothstep(6.0, 1.2, r);
            stepScale *= mix(1.0, 0.14, nearBh);

            dir = normalize(dir + accel * stepScale);
            vec3 nextPos = pos + dir * stepScale;
            vec3 seg = nextPos - pos;

            if (u_discEnabled > 0.5) {
                float signed0 = pos.y;
                float signed1 = nextPos.y;
                bool crossed = (signed0 <= 0.0 && signed1 >= 0.0) || (signed0 >= 0.0 && signed1 <= 0.0);
                bool nearPlane = min(abs(signed0), abs(signed1)) <= u_discThickness;

                if ((crossed || nearPlane) && abs(signed1 - signed0) > 1e-6) {
                    float tPlane = clamp((-signed0) / (signed1 - signed0), 0.0, 1.0);
                    vec3 hitPos = pos + seg * tPlane;
                    float rDisc = length(hitPos.xz);

                    if (rDisc > u_discInner && rDisc < u_discOuter) {
                        float radialNorm = (rDisc - u_discInner) / max(1e-5, (u_discOuter - u_discInner));
                        float innerHot = 1.0 - smoothstep(u_discInner, u_discInner + 0.55 * u_massM, rDisc);
                        float outerFade = 1.0 - smoothstep(0.65, 1.0, radialNorm);
                        float radialProfile = exp(-1.65 * radialNorm) * outerFade + 0.45 * innerHot;
                        float thicknessFade = exp(-abs(hitPos.y) / max(1e-5, u_discThickness));

                        float spinDir = (u_spinAstar >= 0.0) ? 1.0 : -1.0;
                        vec3 az = vec3(-spinDir * hitPos.z, 0.0, spinDir * hitPos.x);
                        float azLen = length(az);
                        if (azLen > 1e-6) {
                            az /= azLen;
                        } else {
                            az = vec3(spinDir, 0.0, 0.0);
                        }

                        float betaOrb = clamp(
                            sqrt(u_massM / max(1e-4, rDisc)) * (0.86 + 0.14 * abs(u_spinAstar)),
                            0.0,
                            0.72
                        );
                        float gammaOrb = 1.0 / sqrt(max(1e-5, 1.0 - betaOrb * betaOrb));
                        float mu = clamp(dot(az, -dir), -0.98, 0.98);
                        float beaming = 1.0 / max(0.06, gammaOrb * (1.0 - betaOrb * mu));

                        float gravDisc = kerrLapse(max(kerrHorizon() * 1.0005, rDisc));
                        float localShift = clamp(beaming * gravDisc, 0.20, 3.40);

                        float turbulence = noise(vec3(hitPos.x * 5.0, hitPos.z * 5.0, u_time * 0.38));
                        float shimmer = mix(0.65, 1.35, turbulence);

                        float heat = clamp(u_discTemp * (1.0 - 0.5 * radialNorm) + innerHot * 0.45, 0.0, 1.0);
                        vec3 emissive = discSpectrum(heat);
                        emissive = dopplerTint(emissive, localShift) * pow(localShift, 1.15);

                        float alphaDisc = clamp(
                            u_discIntensity * radialProfile * thicknessFade * shimmer * 0.26,
                            0.0,
                            0.95
                        );
                        discEmission += (1.0 - discOpacity) * emissive * alphaDisc * 2.9;
                        discOpacity += (1.0 - discOpacity) * alphaDisc * 0.75;
                    }
                }
            }
            float aSeg = dot(seg, seg);
            float bSeg = 2.0 * dot(pos, seg);
            float cSeg = dot(pos, pos) - horizonR * horizonR;
            float disc = bSeg * bSeg - 4.0 * aSeg * cSeg;
            if (disc >= 0.0) {
                float sqrtDisc = sqrt(disc);
                float inv2a = 0.5 / max(aSeg, 1e-6);
                float t0 = (-bSeg - sqrtDisc) * inv2a;
                float t1 = (-bSeg + sqrtDisc) * inv2a;
                if ((t0 >= 0.0 && t0 <= 1.0) || (t1 >= 0.0 && t1 <= 1.0)) {
                    outColor = vec3(0.0);
                    hitHorizon = true;
                    break;
                }
            }

            pos = nextPos;

            if (r > max(220.0, rObs + 90.0)) {
                vec3 bg = starfield(dir);
                float shift = observedShift(dir, u_velocity, rObs);
                outColor = dopplerTint(bg, shift) * pow(shift, 1.25);
                escaped = true;
                break;
            }
        }

        if (!hitHorizon && !escaped) {
            float shift = observedShift(dir, u_velocity, rObs);
            vec3 bg = starfield(dir);
            outColor = dopplerTint(bg, shift) * pow(shift, 1.25);
        }
        // Composite disc emission even for rays that later hit the horizon:
        // near-side disc intersections must stay visible in front of the shadow.
        outColor = outColor * (1.0 - clamp(discOpacity, 0.0, 0.94)) + discEmission;

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
        const info = glCtx.getShaderInfoLog(shader) || 'Unknown shader compile error';
        console.error('Shader compile error: ' + info);
        alert(`Shader compile failed:\n${info}`);
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
    const info = gl.getProgramInfoLog(program) || 'Unknown program link error';
    console.error('Program link error: ' + info);
    alert(`WebGL program link failed:\n${info}`);
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
    spinAstar: gl.getUniformLocation(program, 'u_spinAstar'),
    massM: gl.getUniformLocation(program, 'u_massM'),
    discEnabled: gl.getUniformLocation(program, 'u_discEnabled'),
    discIntensity: gl.getUniformLocation(program, 'u_discIntensity'),
    discTemp: gl.getUniformLocation(program, 'u_discTemp'),
    discThickness: gl.getUniformLocation(program, 'u_discThickness'),
    discInner: gl.getUniformLocation(program, 'u_discInner'),
    discOuter: gl.getUniformLocation(program, 'u_discOuter'),
};

// -----------------------------------------------------------------------------
// Physics and free-flight controls
// -----------------------------------------------------------------------------

const C = 1.0;
const MIN_MASS_SOLAR = 1e6;
const MAX_MASS_SOLAR = 1e7;

let massSolar = REFERENCE_MASS_SOLAR;
let massSim = REFERENCE_M_SIM;
let rsSim = 2 * massSim;
let spinAstar = INITIAL_SPIN_ASTAR;
let kerrASim = spinAstar * massSim;
let horizonRs = rsSim;
let gm = massSim;
let discEnabled = true;
let discIntensity = 1.0;
let discTemperature = 0.62;
let discThicknessRs = 0.055;

function clampSpin(v) {
    return Math.max(-0.999, Math.min(0.999, v));
}

function recomputeKerrDerived() {
    massSim = REFERENCE_M_SIM * (massSolar / REFERENCE_MASS_SOLAR);
    rsSim = 2 * massSim;
    gm = massSim;
    kerrASim = spinAstar * massSim;
    horizonRs = massSim + Math.sqrt(Math.max(0, massSim * massSim - kerrASim * kerrASim));
}

function kerrLapseAt(r) {
    const rr = Math.max(horizonRs * 1.0004, r);
    const delta = rr * rr - 2 * massSim * rr + kerrASim * kerrASim;
    const a2 = kerrASim * kerrASim;
    const Aterm = (rr * rr + a2) * (rr * rr + a2) - a2 * delta;
    return Math.sqrt(Math.max(1e-12, (delta * rr * rr) / Math.max(1e-12, Aterm)));
}

function frameDragOmegaAt(r) {
    const rr = Math.max(horizonRs * 1.0004, r);
    return (2 * kerrASim * massSim) / Math.max(1e-12, rr * rr * rr + kerrASim * kerrASim * rr);
}

function spinSign() {
    return spinAstar >= 0 ? 1 : -1;
}

recomputeKerrDerived();

let camPos = glMatrix.vec3.fromValues(0.0, 1.2, 14.0);
let camForward = glMatrix.vec3.fromValues(0.0, -0.08, -1.0);
let camUp = glMatrix.vec3.fromValues(0.0, 1.0, 0.0);
let camRight = glMatrix.vec3.create();
glMatrix.vec3.cross(camRight, camForward, camUp);
glMatrix.vec3.normalize(camForward, camForward);
glMatrix.vec3.normalize(camRight, camRight);

// Local physical velocity (fraction of c) measured by local ZAMO-like observers.
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
const uiMode = document.getElementById('mode-val');
const uiVel = document.getElementById('vel-val');
const uiTime = document.getElementById('time-val');
const uiShift = document.getElementById('shift-val');
const uiProper = document.getElementById('proper-val');
const uiCoordClock = document.getElementById('coord-clock');
const fixToggleBtn = document.getElementById('fix-toggle');
const brakeBtn = document.getElementById('brake-btn');
const transportRsInput = document.getElementById('transport-rs-input');
const transportBtn = document.getElementById('transport-btn');
const massSlider = document.getElementById('mass-slider');
const massInput = document.getElementById('mass-input');
const spinSlider = document.getElementById('spin-slider');
const spinInput = document.getElementById('spin-input');
const warningBanner = document.getElementById('warning-banner');
const horizonEducation = document.getElementById('horizon-education');
const restartBtn = document.getElementById('restart-btn');
const discEnabledInput = document.getElementById('disc-enabled');
const discIntensitySlider = document.getElementById('disc-intensity-slider');
const discIntensityInput = document.getElementById('disc-intensity-input');
const discTempSlider = document.getElementById('disc-temp-slider');
const discTempInput = document.getElementById('disc-temp-input');
const discThicknessSlider = document.getElementById('disc-thickness-slider');
const discThicknessInput = document.getElementById('disc-thickness-input');

function clampMassSolar(v) {
    return Math.max(MIN_MASS_SOLAR, Math.min(MAX_MASS_SOLAR, v));
}

function syncMassUi() {
    if (uiMass) {
        uiMass.textContent = massSolar.toExponential(3);
    }
    if (massSlider) {
        massSlider.value = String(Math.round(massSolar));
    }
    if (massInput) {
        massInput.value = String(Math.round(massSolar));
    }
}

function syncSpinUi() {
    if (uiSpin) {
        uiSpin.textContent = spinAstar.toFixed(3);
    }
    if (spinSlider) {
        spinSlider.value = spinAstar.toFixed(3);
    }
    if (spinInput) {
        spinInput.value = spinAstar.toFixed(3);
    }
}

function syncDiscUi() {
    if (discEnabledInput) {
        discEnabledInput.checked = discEnabled;
    }
    if (discIntensitySlider) {
        discIntensitySlider.value = discIntensity.toFixed(2);
    }
    if (discIntensityInput) {
        discIntensityInput.value = discIntensity.toFixed(2);
    }
    if (discTempSlider) {
        discTempSlider.value = discTemperature.toFixed(2);
    }
    if (discTempInput) {
        discTempInput.value = discTemperature.toFixed(2);
    }
    if (discThicknessSlider) {
        discThicknessSlider.value = discThicknessRs.toFixed(3);
    }
    if (discThicknessInput) {
        discThicknessInput.value = discThicknessRs.toFixed(3);
    }
}

function setSpin(nextSpin) {
    if (!Number.isFinite(nextSpin)) return;
    spinAstar = clampSpin(nextSpin);
    recomputeKerrDerived();

    // Keep camera outside updated horizon if spin changes drastically.
    const r = glMatrix.vec3.length(camPos);
    const safeR = horizonRs * 1.0005;
    if (r < safeR) {
        const radial = glMatrix.vec3.clone(camPos);
        if (glMatrix.vec3.length(radial) < 1e-8) {
            glMatrix.vec3.set(radial, 0, 0, 1);
        }
        glMatrix.vec3.normalize(radial, radial);
        glMatrix.vec3.scale(camPos, radial, safeR);
    }
    if (orbitLockActive) {
        orbitLockRadiusSim = Math.max(orbitLockRadiusSim, kerrProgradeIscoradiusSim());
    }

    syncSpinUi();
    syncMassUi();
}

function setMassSolar(nextMassSolar) {
    if (!Number.isFinite(nextMassSolar)) return;
    massSolar = clampMassSolar(nextMassSolar);
    recomputeKerrDerived();

    const r = glMatrix.vec3.length(camPos);
    const safeR = horizonRs * 1.0005;
    if (r < safeR) {
        const radial = glMatrix.vec3.clone(camPos);
        if (glMatrix.vec3.length(radial) < 1e-8) {
            glMatrix.vec3.set(radial, 0, 0, 1);
        }
        glMatrix.vec3.normalize(radial, radial);
        glMatrix.vec3.scale(camPos, radial, safeR);
    }
    if (orbitLockActive) {
        orbitLockRadiusSim = Math.max(orbitLockRadiusSim, kerrProgradeIscoradiusSim());
    }

    syncMassUi();
    syncSpinUi();
}

if (uiMode) {
    uiMode.textContent = PHYSICS_MODE;
}
syncMassUi();
syncSpinUi();
syncDiscUi();

if (massSlider) {
    massSlider.addEventListener('input', () => {
        setMassSolar(Number(massSlider.value));
    });
}
if (massInput) {
    massInput.addEventListener('change', () => {
        setMassSolar(Number(massInput.value));
    });
}

if (spinSlider) {
    spinSlider.addEventListener('input', () => {
        setSpin(Number(spinSlider.value));
    });
}
if (spinInput) {
    spinInput.addEventListener('change', () => {
        setSpin(Number(spinInput.value));
    });
}

function setDiscIntensity(nextValue) {
    if (!Number.isFinite(nextValue)) return;
    discIntensity = Math.max(0, Math.min(2.5, nextValue));
    syncDiscUi();
}

function setDiscTemperature(nextValue) {
    if (!Number.isFinite(nextValue)) return;
    discTemperature = Math.max(0, Math.min(1, nextValue));
    syncDiscUi();
}

function setDiscThicknessRs(nextValue) {
    if (!Number.isFinite(nextValue)) return;
    discThicknessRs = Math.max(0.005, Math.min(0.22, nextValue));
    syncDiscUi();
}

if (discEnabledInput) {
    discEnabledInput.addEventListener('change', () => {
        discEnabled = discEnabledInput.checked;
    });
}
if (discIntensitySlider) {
    discIntensitySlider.addEventListener('input', () => {
        setDiscIntensity(Number(discIntensitySlider.value));
    });
}
if (discIntensityInput) {
    discIntensityInput.addEventListener('change', () => {
        setDiscIntensity(Number(discIntensityInput.value));
    });
}
if (discTempSlider) {
    discTempSlider.addEventListener('input', () => {
        setDiscTemperature(Number(discTempSlider.value));
    });
}
if (discTempInput) {
    discTempInput.addEventListener('change', () => {
        setDiscTemperature(Number(discTempInput.value));
    });
}
if (discThicknessSlider) {
    discThicknessSlider.addEventListener('input', () => {
        setDiscThicknessRs(Number(discThicknessSlider.value));
    });
}
if (discThicknessInput) {
    discThicknessInput.addEventListener('change', () => {
        setDiscThicknessRs(Number(discThicknessInput.value));
    });
}

function resize() {
    const dpr = Math.min(window.devicePixelRatio || 3, 5);
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
let orbitLockActive = false;
let orbitLockRadiusSim = 0;
let orbitLockDirection = 1;
let simulationEnded = false;

function syncFixButton() {
    if (!fixToggleBtn) return;
    fixToggleBtn.textContent = isPositionFixed ? 'FIX: ON' : 'FIX: OFF';
    fixToggleBtn.classList.toggle('active', isPositionFixed);
}

function setFixedMode(enabled) {
    isPositionFixed = enabled;
    if (enabled) {
        orbitLockActive = false;
    }
    syncFixButton();
}

function kerrProgradeIscoradiusSim() {
    const aStarAbs = Math.min(0.999, Math.abs(spinAstar));
    const z1 = 1
        + Math.pow(1 - aStarAbs * aStarAbs, 1 / 3)
        * (Math.pow(1 + aStarAbs, 1 / 3) + Math.pow(1 - aStarAbs, 1 / 3));
    const z2 = Math.sqrt(3 * aStarAbs * aStarAbs + z1 * z1);
    const riscoOverM = 3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
    return Math.max(horizonRs * 1.0005, riscoOverM * massSim);
}

function circularOrbitLocalSpeed(radiusSim) {
    const r = Math.max(radiusSim, kerrProgradeIscoradiusSim());
    if (r <= 3 * massSim + 1e-4) {
        return 0.995;
    }
    const sqrtM = Math.sqrt(massSim);
    const omegaOrb = sqrtM / Math.max(1e-8, Math.pow(r, 1.5) + Math.abs(kerrASim) * sqrtM);
    const omegaFd = Math.abs(frameDragOmegaAt(r));
    const v = Math.max(0, (omegaOrb - omegaFd) * r);
    return Math.min(0.995, v);
}

function transportFromHorizonOffsetRs(offsetRs) {
    const parsed = Number(offsetRs);
    if (!Number.isFinite(parsed)) return false;

    const offset = Math.max(0, parsed);
    const targetRadiusSim = horizonRs + offset * rsSim;
    const iscoSim = kerrProgradeIscoradiusSim();
    if (targetRadiusSim <= iscoSim) {
        return false;
    }

    const radialDir = glMatrix.vec3.clone(camPos);
    if (glMatrix.vec3.length(radialDir) < 0.00001) {
        glMatrix.vec3.set(radialDir, 0, 0, 1);
    } else {
        glMatrix.vec3.normalize(radialDir, radialDir);
    }

    glMatrix.vec3.scale(camPos, radialDir, targetRadiusSim);

    const azimuthDir = glMatrix.vec3.fromValues(-spinSign() * camPos[2], 0, spinSign() * camPos[0]);
    if (glMatrix.vec3.length(azimuthDir) < 0.00001) {
        glMatrix.vec3.set(azimuthDir, spinSign(), 0, 0);
    } else {
        glMatrix.vec3.normalize(azimuthDir, azimuthDir);
    }

    const orbitSpeed = circularOrbitLocalSpeed(targetRadiusSim);
    glMatrix.vec3.scale(velocity, azimuthDir, orbitSpeed);
    orbitLockActive = true;
    orbitLockRadiusSim = targetRadiusSim;
    orbitLockDirection = spinSign();

    setFixedMode(false);
    return true;
}

if (fixToggleBtn) {
    fixToggleBtn.addEventListener('click', () => {
        setFixedMode(!isPositionFixed);
    });
    syncFixButton();
}

if (brakeBtn) {
    brakeBtn.addEventListener('click', () => {
        glMatrix.vec3.set(velocity, 0, 0, 0);
        orbitLockActive = false;
    });
}

if (transportBtn && transportRsInput) {
    const runTransport = () => {
        const ok = transportFromHorizonOffsetRs(transportRsInput.value);
        if (!ok) {
            const iscoSim = kerrProgradeIscoradiusSim();
            const minOffsetRs = Math.max(0, (iscoSim - horizonRs) / Math.max(1e-12, rsSim));
            alert(`Jump blocked: target must be outside prograde ISCO. Minimum offset is ${minOffsetRs.toFixed(3)} R_S.`);
            return;
        }
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
    const tenths = Math.floor((s - Math.floor(s)) * 10);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
}

function endSimulationAtHorizon() {
    if (simulationEnded) return;
    simulationEnded = true;
    glMatrix.vec3.set(velocity, 0, 0, 0);
    orbitLockActive = false;

    if (document.pointerLockElement === canvas && document.exitPointerLock) {
        document.exitPointerLock();
    }
    if (horizonEducation) {
        horizonEducation.classList.remove('hidden');
    }
}

if (restartBtn) {
    restartBtn.addEventListener('click', () => {
        window.location.reload();
    });
}

function updatePhysics(dt) {
    if (simulationEnded) return;

    const r = glMatrix.vec3.length(camPos);
    const rSafe = Math.max(horizonRs * 1.0005, r);
    const radialUnit = glMatrix.vec3.create();
    glMatrix.vec3.scale(radialUnit, camPos, 1 / Math.max(1e-8, r));

    const alpha = kerrLapseAt(rSafe);
    const dTauLocal = alpha * dt;

    const thrust = glMatrix.vec3.create();
    const thrustPower = 0.9;
    if (keys.w) glMatrix.vec3.scaleAndAdd(thrust, thrust, camForward, thrustPower);
    if (keys.r) glMatrix.vec3.scaleAndAdd(thrust, thrust, camForward, -thrustPower);
    if (keys.a) glMatrix.vec3.scaleAndAdd(thrust, thrust, camRight, -thrustPower);
    if (keys.s) glMatrix.vec3.scaleAndAdd(thrust, thrust, camRight, thrustPower);
    if (keys.q) glMatrix.vec3.scaleAndAdd(thrust, thrust, camUp, thrustPower);
    if (keys.e) glMatrix.vec3.scaleAndAdd(thrust, thrust, camUp, -thrustPower);

    // Manual thrust cancels orbit lock and returns to free flight.
    if (glMatrix.vec3.length(thrust) > 1e-8) {
        orbitLockActive = false;
    }

    const gravityMag = gm / Math.max(1e-8, rSafe * rSafe * alpha);
    const gravity = glMatrix.vec3.create();
    glMatrix.vec3.scale(gravity, radialUnit, -gravityMag);

    const azimuthDir = glMatrix.vec3.fromValues(-camPos[2], 0, camPos[0]);
    if (glMatrix.vec3.length(azimuthDir) > 1e-6) {
        glMatrix.vec3.normalize(azimuthDir, azimuthDir);
    } else {
        glMatrix.vec3.set(azimuthDir, 1, 0, 0);
    }

    const omegaFrame = frameDragOmegaAt(rSafe);
    const velDir = glMatrix.vec3.create();
    if (glMatrix.vec3.length(velocity) > 1e-7) {
        glMatrix.vec3.normalize(velDir, velocity);
    } else {
        glMatrix.vec3.copy(velDir, camForward);
    }
    const align = Math.abs(glMatrix.vec3.dot(velDir, azimuthDir));
    const frameDragAccel = glMatrix.vec3.create();
    glMatrix.vec3.scale(frameDragAccel, azimuthDir, omegaFrame * (0.2 + 0.8 * align));

    const totalAccel = glMatrix.vec3.create();
    glMatrix.vec3.add(totalAccel, totalAccel, gravity);
    glMatrix.vec3.add(totalAccel, totalAccel, frameDragAccel);

    if (isPositionFixed) {
        const antiGravity = glMatrix.vec3.create();
        glMatrix.vec3.scale(antiGravity, radialUnit, gravityMag);
        glMatrix.vec3.add(totalAccel, totalAccel, antiGravity);
        glMatrix.vec3.scaleAndAdd(totalAccel, totalAccel, frameDragAccel, -1);
    }

    glMatrix.vec3.add(totalAccel, totalAccel, thrust);

    glMatrix.vec3.scaleAndAdd(velocity, velocity, totalAccel, dTauLocal);

    const speed = glMatrix.vec3.length(velocity);
    if (speed > 0.995 * C) {
        glMatrix.vec3.scale(velocity, velocity, (0.995 * C) / speed);
    }

    const vRadial = glMatrix.vec3.dot(velocity, radialUnit);
    const vRadialVec = glMatrix.vec3.create();
    glMatrix.vec3.scale(vRadialVec, radialUnit, vRadial);

    const vTangential = glMatrix.vec3.create();
    glMatrix.vec3.subtract(vTangential, velocity, vRadialVec);

    const coordVel = glMatrix.vec3.create();
    glMatrix.vec3.scale(coordVel, vRadialVec, alpha * alpha);
    glMatrix.vec3.scaleAndAdd(coordVel, coordVel, vTangential, alpha);
    glMatrix.vec3.scaleAndAdd(coordVel, coordVel, azimuthDir, omegaFrame * rSafe);

    glMatrix.vec3.scaleAndAdd(camPos, camPos, coordVel, dt);

    const newR = glMatrix.vec3.length(camPos);
    const horizonGuard = horizonRs * 1.0005;
    if (newR <= horizonGuard) {
        endSimulationAtHorizon();
        return;
    }

    if (orbitLockActive && !isPositionFixed) {
        orbitLockRadiusSim = Math.max(orbitLockRadiusSim, kerrProgradeIscoradiusSim());

        const radialLock = glMatrix.vec3.clone(camPos);
        if (glMatrix.vec3.length(radialLock) < 1e-8) {
            glMatrix.vec3.set(radialLock, 0, 0, 1);
        } else {
            glMatrix.vec3.normalize(radialLock, radialLock);
        }

        glMatrix.vec3.scale(camPos, radialLock, orbitLockRadiusSim);

        const azLock = glMatrix.vec3.fromValues(-orbitLockDirection * camPos[2], 0, orbitLockDirection * camPos[0]);
        if (glMatrix.vec3.length(azLock) < 1e-8) {
            glMatrix.vec3.set(azLock, orbitLockDirection, 0, 0);
        } else {
            glMatrix.vec3.normalize(azLock, azLock);
        }

        const vTarget = circularOrbitLocalSpeed(orbitLockRadiusSim);
        glMatrix.vec3.scale(velocity, azLock, vTarget);
    }

    const radiusSim = glMatrix.vec3.length(camPos);
    const vFrac = Math.min(0.999999, glMatrix.vec3.length(velocity) / C);
    const gammaLocal = 1 / Math.sqrt(Math.max(1e-12, 1 - vFrac * vFrac));

    const alphaObs = kerrLapseAt(radiusSim);
    const dTauDt = Math.max(1e-12, alphaObs / gammaLocal);
    const dtOverDTau = 1 / dTauDt;

    // Treat render-frame dt as onboard proper-time increment and map it to
    // coordinate-time using the instantaneous shift factor.
    const dTauStep = dt;
    const dCoordStep = dTauStep * dtOverDTau;
    accumulatedProperTime += dTauStep;
    accumulatedCoordinateTime += dCoordStep;

    const distRs = radiusSim / Math.max(1e-12, rsSim);
    const distToHorizonRs = Math.max(0, (radiusSim - horizonRs) / Math.max(1e-12, rsSim));

    if (uiDist) {
        uiDist.textContent = distRs.toFixed(6);
    }
    if (uiDistHorizon) {
        uiDistHorizon.textContent = distToHorizonRs.toFixed(6);
    }
    if (uiVel) {
        uiVel.textContent = (vFrac * 100).toFixed(2);
    }
    if (uiTime) {
        uiTime.textContent = dTauDt.toFixed(4);
    }
    if (uiShift) {
        uiShift.textContent = dtOverDTau.toFixed(3);
    }
    if (uiProper) {
        uiProper.textContent = accumulatedProperTime.toFixed(2);
    }
    if (uiCoordClock) {
        uiCoordClock.textContent = formatClock(accumulatedCoordinateTime);
    }

    if (warningBanner) {
        if (radiusSim < horizonRs * 1.6) {
            warningBanner.classList.remove('hidden');
        } else {
            warningBanner.classList.add('hidden');
        }
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
    gl.uniform1f(uniformLocs.spinAstar, spinAstar);
    gl.uniform1f(uniformLocs.massM, massSim);
    gl.uniform1f(uniformLocs.discEnabled, discEnabled ? 1 : 0);
    gl.uniform1f(uniformLocs.discIntensity, discIntensity);
    gl.uniform1f(uniformLocs.discTemp, discTemperature);
    gl.uniform1f(uniformLocs.discThickness, discThicknessRs * rsSim);
    const discInner = Math.max(horizonRs * 1.02, kerrProgradeIscoradiusSim());
    const discOuter = discInner + 12.0 * rsSim;
    gl.uniform1f(uniformLocs.discInner, discInner);
    gl.uniform1f(uniformLocs.discOuter, discOuter);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (!simulationEnded) {
        requestAnimationFrame(render);
    }
}

requestAnimationFrame((t) => {
    lastTime = t * 0.001;
    requestAnimationFrame(render);
});
