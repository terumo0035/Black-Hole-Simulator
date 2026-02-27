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
    const float ISCO = 3.0;
    const float DISK_OUTER = 18.0;

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
        float milky = smoothstep(0.35, 0.9, noise(dir * 18.0));
        vec3 dust = vec3(0.07, 0.11, 0.2) * milky;

        float sparkle = pow(noise(dir * 280.0), 42.0) * 8.0;
        float giant = pow(noise(dir * 75.0), 25.0) * 1.8;
        return dust + vec3(sparkle + giant);
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
        vec3 outColor = vec3(0.0);

        for (int i = 0; i < MAX_STEPS; i++) {
            float r2 = dot(pos, pos);
            float r = sqrt(r2);
            if (r <= RS * 1.002) {
                outColor = vec3(0.0);
                break;
            }

            vec3 L = cross(pos, dir);
            float L2 = dot(L, L);
            vec3 accel = -1.5 * RS * L2 * pos / max(0.0001, (r2 * r2 * r));

            float stepScale = clamp(0.025 * r + 0.02, 0.02, 0.22);
            dir = normalize(dir + accel * stepScale);
            vec3 nextPos = pos + dir * stepScale;

            if (pos.y * nextPos.y <= 0.0) {
                float tPlane = (abs(pos.y - nextPos.y) < 0.0001) ? 0.5 : pos.y / (pos.y - nextPos.y);
                vec3 hitPos = mix(pos, nextPos, tPlane);
                float diskR = length(hitPos.xz);
                if (diskR > ISCO && diskR < DISK_OUTER) {
                    float vk = sqrt(RS / (2.0 * diskR));
                    vec3 diskVel = normalize(vec3(-hitPos.z, 0.0, hitPos.x)) * vk;

                    float gammaDisk = 1.0 / sqrt(max(0.0004, 1.0 - vk * vk));
                    float D = 1.0 / (gammaDisk * (1.0 - dot(diskVel, -dir)));
                    float grav = sqrt(max(0.001, 1.0 - RS / diskR));
                    float shift = D * grav;

                    float angle = atan(hitPos.z, hitPos.x);
                    float swirl = sin(angle * 16.0 - u_time * 4.0 * vk) * 0.5 + 0.5;
                    float turbulence = noise(vec3(hitPos.xz * 1.3, u_time * 0.15));
                    float density = smoothstep(ISCO, ISCO + 0.6, diskR)
                        * (1.0 - smoothstep(DISK_OUTER - 2.5, DISK_OUTER, diskR))
                        * (0.45 + 0.9 * swirl)
                        * (0.6 + turbulence);

                    float heat = clamp((DISK_OUTER - diskR) / (DISK_OUTER - ISCO), 0.0, 1.0);
                    vec3 base = mix(vec3(1.0, 0.25, 0.05), vec3(1.0, 0.86, 0.48), heat);
                    vec3 shifted = dopplerTint(base * pow(shift, 2.4), shift);

                    float alpha = clamp(density * 0.5, 0.0, 1.0);
                    diskAccum += (1.0 - diskAlpha) * shifted * alpha;
                    diskAlpha += (1.0 - diskAlpha) * alpha;
                }
            }

            pos = nextPos;

            if (r > max(180.0, length(u_camPos) + 80.0)) {
                vec3 bg = starfield(dir);
                float observerShift = 1.0;
                if (speed > 0.0005) {
                    float gammaObs = 1.0 / sqrt(max(0.0004, 1.0 - speed * speed));
                    observerShift = 1.0 / (gammaObs * (1.0 - dot(dir, u_velocity)));
                }

                vec3 lensed = dopplerTint(bg, observerShift) * pow(observerShift, 1.6);
                outColor = diskAccum + (1.0 - diskAlpha) * lensed;
                break;
            }
        }

        float vignette = smoothstep(1.15, 0.2, length(uv));
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

const program = gl.createProgram();
gl.attachShader(program, vertexShader);
gl.attachShader(program, fragmentShader);
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Program link error: ' + gl.getProgramInfoLog(program));
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
const GM = 0.5 * RS;

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
const uiVel = document.getElementById('vel-val');
const uiTime = document.getElementById('time-val');
const uiShift = document.getElementById('shift-val');
const uiProper = document.getElementById('proper-val');
const warningBanner = document.getElementById('warning-banner');

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

function updatePhysics(dt) {
    const r = glMatrix.vec3.length(camPos);
    const radialUnit = glMatrix.vec3.create();
    glMatrix.vec3.scale(radialUnit, camPos, 1 / Math.max(0.0001, r));

    const gravity = glMatrix.vec3.create();
    const gMag = GM / Math.max(0.02, r * r);
    glMatrix.vec3.scale(gravity, radialUnit, -gMag);

    const thrust = glMatrix.vec3.create();
    const thrustPower = 0.9;
    if (keys.w) glMatrix.vec3.scaleAndAdd(thrust, thrust, camForward, thrustPower);
    if (keys.s) glMatrix.vec3.scaleAndAdd(thrust, thrust, camForward, -thrustPower);
    if (keys.a) glMatrix.vec3.scaleAndAdd(thrust, thrust, camRight, -thrustPower);
    if (keys.d) glMatrix.vec3.scaleAndAdd(thrust, thrust, camRight, thrustPower);
    if (keys.q) glMatrix.vec3.scaleAndAdd(thrust, thrust, camUp, thrustPower);
    if (keys.e) glMatrix.vec3.scaleAndAdd(thrust, thrust, camUp, -thrustPower);

    const totalAccel = glMatrix.vec3.create();
    glMatrix.vec3.add(totalAccel, gravity, thrust);

    glMatrix.vec3.scaleAndAdd(velocity, velocity, totalAccel, dt);

    const speed = glMatrix.vec3.length(velocity);
    if (speed > 0.995 * C) {
        glMatrix.vec3.scale(velocity, velocity, (0.995 * C) / speed);
    }

    glMatrix.vec3.scaleAndAdd(camPos, camPos, velocity, dt);

    const newR = glMatrix.vec3.length(camPos);
    if (newR <= RS * 1.003) {
        const safeScale = (RS * 1.003) / Math.max(0.0001, newR);
        glMatrix.vec3.scale(camPos, camPos, safeScale);
        glMatrix.vec3.scale(velocity, velocity, 0.4);
    }

    const vFrac = Math.min(0.999, glMatrix.vec3.length(velocity) / C);
    const gamma = 1 / Math.sqrt(Math.max(0.001, 1 - vFrac * vFrac));
    const gravFactor = Math.sqrt(Math.max(0.001, 1 - RS / glMatrix.vec3.length(camPos)));
    const dTauDt = gravFactor / gamma;
    accumulatedProperTime += dt * dTauDt;

    uiDist.textContent = (glMatrix.vec3.length(camPos) / RS).toFixed(3);
    uiVel.textContent = (vFrac * 100).toFixed(2);
    uiTime.textContent = dTauDt.toFixed(4);
    uiShift.textContent = (1 / Math.max(0.001, dTauDt)).toFixed(3);
    uiProper.textContent = accumulatedProperTime.toFixed(2);

    if (glMatrix.vec3.length(camPos) < RS * 1.6) {
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
