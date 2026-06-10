(function () {
  'use strict';

  const canvas = document.getElementById('robot-motion-canvas');
  const playButton = document.getElementById('motion-play');
  const timeline = document.getElementById('motion-timeline');
  const timeLabel = document.getElementById('motion-time');
  const speedLabel = document.getElementById('motion-speed');
  const rateSelect = document.getElementById('motion-rate');
  if (
    !canvas
    || typeof JOINT_DATA === 'undefined'
    || typeof TCP_DATA === 'undefined'
  ) return;

  const ctx = canvas.getContext('2d');
  const PI = Math.PI;
  const dh = [
    { a: 0, d: 0.1625, alpha: PI / 2 },
    { a: -0.425, d: 0, alpha: 0 },
    { a: -0.3922, d: 0, alpha: 0 },
    { a: 0, d: 0.1333, alpha: PI / 2 },
    { a: 0, d: 0.0997, alpha: -PI / 2 },
    { a: 0, d: 0.0996, alpha: 0 }
  ];

  let width = 0;
  let height = 0;
  let index = 0;
  let playing = false;
  let playbackRate = 1;
  let lastFrame = 0;
  let sessionTime = JOINT_DATA[0].ts;

  timeline.max = String(JOINT_DATA.length - 1);

  function multiply(a, b) {
    const out = new Array(16).fill(0);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        for (let k = 0; k < 4; k++) {
          out[row * 4 + col] += a[row * 4 + k] * b[k * 4 + col];
        }
      }
    }
    return out;
  }

  function dhMatrix(theta, a, d, alpha) {
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    const ca = Math.cos(alpha);
    const sa = Math.sin(alpha);
    return [
      ct, -st * ca, st * sa, a * ct,
      st, ct * ca, -ct * sa, a * st,
      0, sa, ca, d,
      0, 0, 0, 1
    ];
  }

  function jointPoints(sample) {
    let transform = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ];
    const points = [{ x: 0, y: 0, z: 0 }];
    for (let joint = 0; joint < 6; joint++) {
      const theta = sample['q' + joint] * PI / 180;
      const link = dh[joint];
      transform = multiply(
        transform,
        dhMatrix(theta, link.a, link.d, link.alpha)
      );
      points.push({
        x: transform[3],
        y: transform[7],
        z: transform[11]
      });
    }
    return points;
  }

  function project(point, centerX, centerY, scale) {
    const yaw = -0.72;
    const pitch = 0.52;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const x1 = point.x * cy - point.y * sy;
    const y1 = point.x * sy + point.y * cy;
    const y2 = y1 * cp - point.z * sp;
    return {
      x: centerX + x1 * scale,
      y: centerY - y2 * scale
    };
  }

  const skeletons = JOINT_DATA.map(jointPoints);
  const endPath = skeletons.map(points => points[points.length - 1]);
  const tcpBounds = TCP_DATA.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    maxX: Math.max(bounds.maxX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxY: Math.max(bounds.maxY, point.y)
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });

  function nearestTcpIndex(time) {
    let low = 0;
    let high = TCP_DATA.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (TCP_DATA[mid].ts < time) low = mid + 1;
      else high = mid;
    }
    if (low > 0 && Math.abs(TCP_DATA[low - 1].ts - time) < Math.abs(TCP_DATA[low].ts - time)) {
      return low - 1;
    }
    return low;
  }

  function tcpSpeed(tcpIndex) {
    if (tcpIndex < 1) return 0;
    const a = TCP_DATA[tcpIndex - 1];
    const b = TCP_DATA[tcpIndex];
    const dt = b.ts - a.ts;
    if (dt <= 0) return 0;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) / dt * 1000;
  }

  function drawGrid(centerX, centerY, scale) {
    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    ctx.lineWidth = 1;
    for (let value = -0.8; value <= 0.8; value += 0.2) {
      const a = project({ x: -0.8, y: value, z: 0 }, centerX, centerY, scale);
      const b = project({ x: 0.8, y: value, z: 0 }, centerX, centerY, scale);
      const c = project({ x: value, y: -0.8, z: 0 }, centerX, centerY, scale);
      const d = project({ x: value, y: 0.8, z: 0 }, centerX, centerY, scale);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
      ctx.stroke();
    }
  }

  function drawRobot() {
    const mainWidth = width * 0.68;
    const centerX = mainWidth * 0.48;
    const centerY = height * 0.58;
    const scale = Math.min(mainWidth, height) * 0.38;
    const points = skeletons[index].map(point => project(point, centerX, centerY, scale));

    drawGrid(centerX, centerY, scale);

    ctx.strokeStyle = 'rgba(172,16,230,.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= index; i += 2) {
      const point = project(endPath[i], centerX, centerY, scale);
      if (i === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let link = 0; link < points.length - 1; link++) {
      ctx.strokeStyle = link < 3 ? '#E6E6E6' : '#B8B8B8';
      ctx.lineWidth = link < 3 ? 16 : 11;
      ctx.beginPath();
      ctx.moveTo(points[link].x, points[link].y);
      ctx.lineTo(points[link + 1].x, points[link + 1].y);
      ctx.stroke();
    }

    points.forEach((point, joint) => {
      ctx.fillStyle = joint === points.length - 1 ? '#00BDF2' : '#500778';
      ctx.beginPath();
      ctx.arc(point.x, point.y, joint === points.length - 1 ? 9 : 7, 0, PI * 2);
      ctx.fill();
    });

    const head = points[points.length - 1];
    const glow = ctx.createRadialGradient(head.x, head.y, 2, head.x, head.y, 28);
    glow.addColorStop(0, 'rgba(0,189,242,.8)');
    glow.addColorStop(1, 'rgba(0,189,242,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(head.x, head.y, 28, 0, PI * 2);
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.font = '600 13px UCLSans, sans-serif';
    ctx.fillText('DIGITAL TWIN', 22, 30);
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.font = '12px UCLSans, sans-serif';
    ctx.fillText('Approximate UR5e kinematics from recorded joint angles', 22, 50);
  }

  function drawTcpMap(tcpIndex) {
    const panelX = width * 0.7;
    const panelY = 28;
    const panelW = width * 0.27;
    const panelH = height - 56;
    ctx.fillStyle = 'rgba(255,255,255,.045)';
    ctx.fillRect(panelX, panelY, panelW, panelH);

    ctx.fillStyle = '#fff';
    ctx.font = '600 12px UCLSans, sans-serif';
    ctx.fillText('MEASURED TCP PATH', panelX + 16, panelY + 24);

    const pad = 22;
    const mapX = panelX + pad;
    const mapY = panelY + 44;
    const mapW = panelW - pad * 2;
    const mapH = panelH - 100;
    const rangeX = tcpBounds.maxX - tcpBounds.minX || 1;
    const rangeY = tcpBounds.maxY - tcpBounds.minY || 1;
    const mapPoint = point => ({
      x: mapX + (point.x - tcpBounds.minX) / rangeX * mapW,
      y: mapY + mapH - (point.y - tcpBounds.minY) / rangeY * mapH
    });

    ctx.strokeStyle = 'rgba(255,255,255,.12)';
    ctx.strokeRect(mapX, mapY, mapW, mapH);
    ctx.strokeStyle = 'rgba(172,16,230,.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    TCP_DATA.forEach((point, i) => {
      const p = mapPoint(point);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();

    const current = mapPoint(TCP_DATA[tcpIndex]);
    ctx.fillStyle = '#00BDF2';
    ctx.beginPath();
    ctx.arc(current.x, current.y, 6, 0, PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.font = '11px UCLSans, sans-serif';
    ctx.fillText('X-Y top view', mapX, mapY + mapH + 20);
    ctx.fillText('Recorded path: 0.84 m', mapX, mapY + mapH + 38);
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    drawRobot();
    const tcpIndex = nearestTcpIndex(JOINT_DATA[index].ts);
    drawTcpMap(tcpIndex);
    const speed = tcpSpeed(tcpIndex);
    timeLabel.textContent = JOINT_DATA[index].ts.toFixed(1) + ' s';
    speedLabel.textContent = speed.toFixed(1) + ' mm/s';
    timeline.value = String(index);
  }

  function findJointIndex(time) {
    let low = 0;
    let high = JOINT_DATA.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (JOINT_DATA[mid].ts < time) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  function frame(timestamp) {
    if (!lastFrame) lastFrame = timestamp;
    const delta = Math.min((timestamp - lastFrame) / 1000, 0.1);
    lastFrame = timestamp;
    if (playing) {
      sessionTime += delta * playbackRate;
      if (sessionTime > JOINT_DATA[JOINT_DATA.length - 1].ts) {
        sessionTime = JOINT_DATA[0].ts;
      }
      index = findJointIndex(sessionTime);
      draw();
    }
    requestAnimationFrame(frame);
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(320, rect.width);
    height = Math.max(360, rect.height);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw();
  }

  playButton.addEventListener('click', function () {
    playing = !playing;
    playButton.textContent = playing ? 'Pause' : 'Play';
    lastFrame = performance.now();
  });
  timeline.addEventListener('input', function () {
    index = Number(timeline.value);
    sessionTime = JOINT_DATA[index].ts;
    draw();
  });
  rateSelect.addEventListener('change', function () {
    playbackRate = Number(rateSelect.value);
  });

  new ResizeObserver(resize).observe(canvas);
  requestAnimationFrame(frame);
})();
