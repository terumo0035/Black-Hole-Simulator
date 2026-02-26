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
    uniform vec3 u_velocity; // Spacecraft velocity vector

    varying vec2 v_uv;

    const int MAX_STEPS = 1000;
    const float STEP_SIZE = 0.1;
    const float RS = 1.0; // Schwarzschild radius scaled to 1
    const float ISCO = 3.0 * RS; // Inner Most Stable Circular Orbit
    const float DISK_OUTER = 12.0 * RS;

    // Noise function for stars and disk
    float hash(vec3 p) {
        p  = fract( p*0.3183099 + .1 );
        p *= 17.0;
        return fract( p.x*p.y*p.z*(p.x+p.y+p.z) );
    }

    float noise(vec3 x) {
        vec3 p = floor(x);
        vec3 f = fract(x);
        f = f*f*(3.0-2.0*f);
        return mix(mix(mix(hash(p+vec3(0,0,0)), hash(p+vec3(1,0,0)),f.x),
                       mix(hash(p+vec3(0,1,0)), hash(p+vec3(1,1,0)),f.x),f.y),
                   mix(mix(hash(p+vec3(0,0,1)), hash(p+vec3(1,0,1)),f.x),
                       mix(hash(p+vec3(0,1,1)), hash(p+vec3(1,1,1)),f.x),f.y),f.z);
    }

    // Procedural starry background
    vec3 getBackground(vec3 dir) {
        float n = noise(dir * 200.0);
        float star = pow(n, 40.0) * 10.0;
        float n2 = noise(dir * 50.0);
        vec3 galaxy = vec3(0.1, 0.2, 0.4) * pow(n2, 3.0);
        return vec3(star) + galaxy;
    }

    void main() {
        // Normalized device coordinates (-1 to 1)
        vec2 uv = (v_uv - 0.5) * 2.0;
        uv.x *= u_resolution.x / u_resolution.y;

        // Initial ray setup
        vec3 ro = u_camPos;
        // FOV ~90 degrees
        vec3 rd = normalize(u_camForward + uv.x * u_camRight + uv.y * u_camUp);

        // Relativistic aberration (Doppler beaming / headlight effect) approximation
        // If moving fast, rays are bunched up forward.
        // v/c is represented by length(u_velocity) which is [0, 1)
        float speed = length(u_velocity);
        if (speed > 0.001) {
            vec3 beta = u_velocity;
            float gamma = 1.0 / sqrt(1.0 - speed * speed + 0.001);
            float dotP = dot(rd, beta) / speed;
            // Simplified aberration
            vec3 parallel = dotP * beta / speed;
            vec3 perp = rd - parallel;
            rd = normalize((parallel + beta) + perp / gamma);
        }

        vec3 color = vec3(0.0);
        float hitDisk = 0.0;
        
        // Raymarching variables
        vec3 pos = ro;
        vec3 dir = rd;
        float dt = STEP_SIZE;
        
        float diskAlpha = 0.0;
        vec3 diskColorAccum = vec3(0.0);

        for(int i = 0; i < MAX_STEPS; i++) {
            float r2 = dot(pos, pos);
            float r = sqrt(r2);

            // Black hole event horizon
            if (r < RS * 1.02) {
                break; 
            }

            // Geodesic equation for null paths (light) in Schwarzschild 
            // a = -1.5 * rs * L^2 * r^-5 * pos
            vec3 L = cross(pos, dir);
            float L2 = dot(L, L);
            vec3 accel = -1.5 * RS * L2 * pos / (r2 * r2 * r);

            // Update direction and position (Euler integration)
            float stepScale = 0.05 + r * 0.05;  // Step size can be moderate for performance since we will interpolate the disk hit
            dir = normalize(dir + accel * stepScale);
            
            vec3 nextPos = pos + dir * stepScale;

            // Check accretion disk intersection (y = 0 plane)
            // If the ray crosses the y=0 plane between pos and nextPos
            if (pos.y * nextPos.y <= 0.0) {
                // Find exact intersection point on the plane y=0 using linear interpolation
                float tHit = pos.y / (pos.y - nextPos.y);
                // Handle division by zero edge case
                if (pos.y == nextPos.y) tHit = 0.5; 
                
                vec3 hitPos = mix(pos, nextPos, tHit);
                float distToCenter = length(hitPos.xz);
                
                if (distToCenter > ISCO && distToCenter < DISK_OUTER) {
                    // Disk hit! Calculate properties at the exact hitPos
                    float diskR = distToCenter;
                    
                    // Keplerian velocity of disk v = sqrt(GM/r)
                    float v_disk = sqrt(RS / (2.0 * diskR));
                    vec3 diskVel = normalize(vec3(-hitPos.z, 0.0, hitPos.x)) * v_disk;
                    
                    // Doppler shift factor D = 1 / (gamma * (1 - v * cos(theta)))
                    float gamma_disk = 1.0 / sqrt(1.0 - v_disk * v_disk);
                    float cosTheta = dot(dir, normalize(diskVel));
                    float D = 1.0 / (gamma_disk * (1.0 - v_disk * cosTheta));
                    
                    // Gravitational redshift
                    float gravRedshift = sqrt(1.0 - RS / diskR);
                    float totalShift = D * gravRedshift;

                    // Procedural texture for disk
                    // Avoid seam from atan by using sine/cosine combined with smooth noise
                    float angle = atan(hitPos.z, hitPos.x);
                    float rotAngle = angle - u_time * v_disk * 2.0; 
                    vec3 rotPos = vec3(cos(rotAngle)*diskR, 0.0, sin(rotAngle)*diskR);
                    
                    // High-quality continuous noise using the exact float position
                    // Add a fractional offset to time to prevent sampling exactly on the z=0 integer noise plane at startup, which causes grid artifacts
                    float density = noise(vec3(rotPos.x * 2.5, rotPos.z * 2.5, u_time * 0.5 + 13.73));
                    
                    // Radial fading
                    density *= smoothstep(ISCO, ISCO + 1.0, diskR) * smoothstep(DISK_OUTER, DISK_OUTER - 2.0, diskR);

                    // Base color maps temperature (hot inner, cooler outer)
                    vec3 baseColor = mix(vec3(1.0, 0.9, 0.5), vec3(1.0, 0.3, 0.0), (diskR - ISCO) / (DISK_OUTER - ISCO));
                    
                    // Apply relativistic shift to color (blueshift becomes brighter/bluer, redshift becomes dimmer/redder)
                    vec3 shiftColor = baseColor * pow(totalShift, 3.0); 
                    
                    // Since it's infinitely thin geometrically, we assign an arbitrary thickness opacity
                    float alpha = clamp(density * 1.5, 0.0, 1.0);
                    diskColorAccum += (1.0 - diskAlpha) * shiftColor * alpha;
                    diskAlpha += (1.0 - diskAlpha) * alpha;
                }
            }

            pos = nextPos;
            
            // Escape condition (ray goes to infinity)
            if (r > max(100.0, length(u_camPos) + 50.0)) {
                // Background stars
                vec3 bg = getBackground(dir);
                
                // Add overall doppler shift of observer
                float shift = 1.0;
                if (speed > 0.001) {
                    float gamma = 1.0 / sqrt(1.0 - speed*speed);
                    shift = 1.0 / (gamma * (1.0 - dot(dir, u_velocity)));
                }
                
                // Very simple color tint for redshift/blueshift of stars
                vec3 tint = vec3(1.0);
                if (shift > 1.1) tint = vec3(0.5, 0.8, 1.0) * shift; // Blueshift
                else if (shift < 0.9) tint = vec3(1.0, 0.5, 0.5) * shift; // Redshift
                
                color = diskColorAccum + (1.0 - diskAlpha) * bg * tint * pow(shift, 2.0);
                break;
            }
        }

        gl_FragColor = vec4(color, 1.0);
    }
`;

// -----------------------------------------------------------------------------
// WebGL Setup routines
// -----------------------------------------------------------------------------

function compileShader(gl, source, type) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error("Shader compile error: " + gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
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
    console.error("Program link error: " + gl.getProgramInfoLog(program));
}

const positionAttributeLocation = gl.getAttribLocation(program, "a_position");
const positionBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
const positions = [
    -1, -1,
    1, -1,
    -1, 1,
    -1, 1,
    1, -1,
    1, 1,
];
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

// -----------------------------------------------------------------------------
// Physics and Camera Simulation
// -----------------------------------------------------------------------------

const RS = 1.0; // Scaled Schwarzschild radius
const C = 10.0; // Scaled speed of light for movement purposes

// Spacecraft state
let camPos = glMatrix.vec3.fromValues(0, 2, 12); // Start tilted slightly up to see disk
let camForward = glMatrix.vec3.fromValues(0, -0.15, -1);
glMatrix.vec3.normalize(camForward, camForward);
let camUp = glMatrix.vec3.fromValues(0, 1, 0);
let camRight = glMatrix.vec3.create();
glMatrix.vec3.cross(camRight, camForward, camUp);
glMatrix.vec3.normalize(camRight, camRight);

let velocity = glMatrix.vec3.fromValues(0, 0, 0); // physical velocity
let acceleration = glMatrix.vec3.fromValues(0, 0, 0);

// Input state
const keys = {};
let isDragging = false;
let lastMouseX = 0;
let lastMouseY = 0;

window.addEventListener('keydown', (e) => keys[e.key.toLowerCase()] = true);
window.addEventListener('keyup', (e) => keys[e.key.toLowerCase()] = false);
canvas.addEventListener('mousedown', (e) => { isDragging = true; lastMouseX = e.clientX; lastMouseY = e.clientY; });
window.addEventListener('mouseup', () => isDragging = false);
window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - lastMouseX;
    const dy = e.clientY - lastMouseY;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;

    const sensitivity = 0.003;

    // Yaw (rotate around Up)
    const yawMat = glMatrix.mat4.create();
    glMatrix.mat4.rotate(yawMat, yawMat, -dx * sensitivity, camUp);
    glMatrix.vec3.transformMat4(camForward, camForward, yawMat);

    // Pitch (rotate around Right)
    glMatrix.vec3.cross(camRight, camForward, camUp);
    glMatrix.vec3.normalize(camRight, camRight);
    const pitchMat = glMatrix.mat4.create();
    glMatrix.mat4.rotate(pitchMat, pitchMat, -dy * sensitivity, camRight);
    glMatrix.vec3.transformMat4(camForward, camForward, pitchMat);

    // Update Up vector to maintain orthogonality
    glMatrix.vec3.cross(camUp, camRight, camForward);
    glMatrix.vec3.normalize(camUp, camUp);

    glMatrix.vec3.normalize(camForward, camForward);
});

// Resize handler
function resize() {
    const pixelRatio = window.devicePixelRatio || 1;
    // Super-sample for maximum resolution (pushing up to 2x the native device pixels)
    const pr = pixelRatio * 2.0;
    canvas.width = window.innerWidth * pr;
    canvas.height = window.innerHeight * pr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    gl.viewport(0, 0, canvas.width, canvas.height);
}
window.addEventListener('resize', resize);
resize();

// UI Elements
const uiDist = document.getElementById('dist-val');
const uiVel = document.getElementById('vel-val');
const uiTime = document.getElementById('time-val');
const warningBanner = document.getElementById('warning-banner');

// -----------------------------------------------------------------------------
// Main Loop
// -----------------------------------------------------------------------------

let lastTime = 0;

function updatePhysics(dt) {
    // Gravitational acceleration: a = -GM/r^2. G=C=M=1 -> GM = 0.5 * rs
    const rMag = glMatrix.vec3.length(camPos);
    let GM = 0.5 * RS;
    let gMag = GM / (rMag * rMag);

    const gravity = glMatrix.vec3.create();
    glMatrix.vec3.scale(gravity, camPos, -gMag / rMag);

    // Thruster acceleration
    const thrust = glMatrix.vec3.create();
    const thrustPower = 2.0;

    if (keys['w']) glMatrix.vec3.scaleAndAdd(thrust, thrust, camForward, thrustPower);
    if (keys['r']) glMatrix.vec3.scaleAndAdd(thrust, thrust, camForward, -thrustPower);
    if (keys['a']) glMatrix.vec3.scaleAndAdd(thrust, thrust, camRight, -thrustPower);
    if (keys['s']) glMatrix.vec3.scaleAndAdd(thrust, thrust, camRight, thrustPower);

    // Combine forces
    glMatrix.vec3.add(acceleration, gravity, thrust);

    // Update velocity
    glMatrix.vec3.scaleAndAdd(velocity, velocity, acceleration, dt);

    // Speed limit (restrict to < C)
    const speed = glMatrix.vec3.length(velocity);
    if (speed > C * 0.99) {
        glMatrix.vec3.scale(velocity, velocity, (C * 0.99) / speed);
    }

    // Update position
    glMatrix.vec3.scaleAndAdd(camPos, camPos, velocity, dt);

    // Relativistic calculations for HUD
    const r = glMatrix.vec3.length(camPos);

    // Prevent falling inside completely (numerical instability in simple Euler)
    if (r < RS * 1.01) {
        glMatrix.vec3.scale(camPos, camPos, (RS * 1.01) / r);
        glMatrix.vec3.set(velocity, 0, 0, 0);
    }

    const timeDilation = Math.sqrt(Math.max(0.001, 1.0 - RS / r));
    const speedPercent = (speed / C) * 100;

    // Update HUD
    uiDist.textContent = (r / RS).toFixed(3);
    uiVel.textContent = speedPercent.toFixed(1);
    uiTime.textContent = timeDilation.toFixed(4);

    if (r < RS * 1.5) {
        warningBanner.classList.remove('hidden');
    } else {
        warningBanner.classList.add('hidden');
    }
}

function render(time) {
    time *= 0.001; // convert to seconds
    const dt = Math.min(time - lastTime, 0.1); // cap dt to prevent huge jumps
    lastTime = time;

    updatePhysics(dt);

    gl.useProgram(program);

    gl.enableVertexAttribArray(positionAttributeLocation);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0);

    const resLoc = gl.getUniformLocation(program, "u_resolution");
    const camPosLoc = gl.getUniformLocation(program, "u_camPos");
    const camFwdLoc = gl.getUniformLocation(program, "u_camForward");
    const camRightLoc = gl.getUniformLocation(program, "u_camRight");
    const camUpLoc = gl.getUniformLocation(program, "u_camUp");
    const timeLoc = gl.getUniformLocation(program, "u_time");
    const velLoc = gl.getUniformLocation(program, "u_velocity");

    gl.uniform2f(resLoc, canvas.width, canvas.height);
    gl.uniform3f(camPosLoc, camPos[0], camPos[1], camPos[2]);
    gl.uniform3f(camFwdLoc, camForward[0], camForward[1], camForward[2]);
    gl.uniform3f(camRightLoc, camRight[0], camRight[1], camRight[2]);
    gl.uniform3f(camUpLoc, camUp[0], camUp[1], camUp[2]);
    gl.uniform1f(timeLoc, time);

    // Pass velocity scaled to [0, 1) for shader doppler effects
    const shaderVel = [velocity[0] / C, velocity[1] / C, velocity[2] / C];
    gl.uniform3f(velLoc, shaderVel[0], shaderVel[1], shaderVel[2]);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    requestAnimationFrame(render);
}

// Start simulation
requestAnimationFrame((time) => {
    lastTime = time * 0.001;
    requestAnimationFrame(render);
});
