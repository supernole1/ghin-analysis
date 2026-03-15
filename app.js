// GHIN Hole-by-Hole Analysis — Application Logic

// ── Configuration ──────────────────────────────────────────────────
// Replace with your deployed Cloudflare Worker URL:
const WORKER_URL = 'https://ghin-proxy.supernole1.workers.dev';

// ── State ──────────────────────────────────────────────────────────
let token = null;
let golferId = null;
let golferName = '';
let allScores = [];
let coursesData = [];
let chartInstance = null;
let histogramInstance = null;
let maInstance = null;
let boxPlotInstance = null;

// ── DOM Elements ───────────────────────────────────────────────────
const loginSection = document.getElementById('login-section');
const courseSection = document.getElementById('course-section');
const statsSection = document.getElementById('stats-section');
const loginForm = document.getElementById('login-form');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const ghinInput = document.getElementById('ghin-number');
const passwordInput = document.getElementById('password');
const userNameEl = document.getElementById('user-name');
const logoutBtn = document.getElementById('logout-btn');
const courseSelect = document.getElementById('course-select');
const courseInfo = document.getElementById('course-info');
const statsTitle = document.getElementById('stats-title');
const statsBody = document.getElementById('stats-body');
const statsTotals = document.getElementById('stats-totals');
const loading = document.getElementById('loading');
const loadingMsg = document.getElementById('loading-msg');

// ── API Helpers ────────────────────────────────────────────────────

function showLoading(msg) {
  loadingMsg.textContent = msg || 'Loading...';
  loading.hidden = false;
}

function hideLoading() {
  loading.hidden = true;
}

function showError(msg) {
  loginError.textContent = msg;
  loginError.hidden = false;
}

async function apiRequest(path, options = {}) {
  const url = WORKER_URL + path;
  const headers = { 'Content-Type': 'application/json', ...options.headers };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, { ...options, headers });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }

  return res.json();
}

// ── Authentication ─────────────────────────────────────────────────

// GHIN requires a Firebase Installation token before login
async function getFirebaseToken() {
  // Generate a random 22-char base64url FID
  const bytes = new Uint8Array(17);
  crypto.getRandomValues(bytes);
  const fid = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    .slice(0, 22);

  const res = await fetch(
    'https://firebaseinstallations.googleapis.com/v1/projects/ghin-mobile-app/installations',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': 'AIzaSyBxgTOAWxiud0HuaE5tN-5NTlzFnrtyz-I',
      },
      body: JSON.stringify({
        fid: fid,
        appId: '1:884417644529:web:47fb315bc6c70242f72650',
        authVersion: 'FIS_v2',
        sdkVersion: 'w:0.5.7',
      }),
    }
  );

  if (!res.ok) {
    console.error('Firebase response status:', res.status);
    throw new Error('Failed to initialize session');
  }

  const data = await res.json();
  console.log('Firebase response:', JSON.stringify(data, null, 2));
  const fbToken = data.authToken?.token || data.token;
  if (!fbToken) throw new Error('No token in Firebase response');
  return fbToken;
}

async function login(ghinNumber, password) {
  // Step 1: Try to get Firebase Installation token (non-fatal if it fails)
  let firebaseToken = null;
  try {
    firebaseToken = await getFirebaseToken();
    console.log('Firebase token obtained:', firebaseToken ? 'yes' : 'no');
  } catch (err) {
    console.warn('Firebase token failed (will try login without it):', err.message);
  }

  // Step 2: Login with GHIN credentials (+ Firebase token if we got one)
  const body = {
    user: {
      email_or_ghin: ghinNumber,
      password: password,
      remember_me: false,
    },
  };
  if (firebaseToken) body.token = firebaseToken;

  let data;
  try {
    data = await apiRequest('/golfer_login.json', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err.message.includes('Failed to fetch')) {
      throw new Error('Could not reach the proxy server. Check your internet connection or try again.');
    }
    throw err;
  }

  // Log the full response so we can see the actual field names
  console.log('Login response:', JSON.stringify(data, null, 2));

  if (data.golfer_user) {
    token = data.golfer_user.golfer_user_token;
    golferId = data.golfer_user.golfer_id;
    const golfer = data.golfer_user.golfers?.[0];
    golferName = golfer?.player_name || `GHIN #${ghinNumber}`;
  } else {
    throw new Error('Unexpected login response format');
  }

  return { token, golferId, golferName };
}

function logout() {
  token = null;
  golferId = null;
  golferName = '';
  allScores = [];

  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }

  if (histogramInstance) {
    histogramInstance.destroy();
    histogramInstance = null;
  }

  if (maInstance) {
    maInstance.destroy();
    maInstance = null;
  }

  if (boxPlotInstance) {
    boxPlotInstance.destroy();
    boxPlotInstance = null;
  }

  loginSection.hidden = false;
  courseSection.hidden = true;
  statsSection.hidden = true;
  loginError.hidden = true;
  passwordInput.value = '';
}

// ── Data Fetching ──────────────────────────────────────────────────

async function fetchAllScores() {
  // Fetch scores with pagination
  // Response: { scores: [...], total_count: N, ... }
  const scores = [];
  let page = 1;
  const perPage = 50;

  while (true) {
    const params = new URLSearchParams({
      golfer_id: golferId,
      per_page: perPage,
      page: page,
    });

    const data = await apiRequest(`/scores.json?${params}`);

    const batch = data.scores || [];
    if (page === 1 && batch.length > 0) {
      console.log('First score object keys:', Object.keys(batch[0]));
      console.log('First score object:', JSON.stringify(batch[0], null, 2));
    }
    scores.push(...batch);

    // Stop when we've fetched all scores or got a short page
    const totalCount = data.total_count || 0;
    if (scores.length >= totalCount || batch.length < perPage) break;
    page++;
  }

  return scores;
}

function extractCourses(scores) {
  const courseMap = new Map();

  for (const score of scores) {
    const id = score.course_id;
    if (!id) continue;

    if (!courseMap.has(id)) {
      courseMap.set(id, {
        id,
        name: score.course_name || score.facility_name || `Course ${id}`,
        roundCount: 0,
        tees: new Map(), // tee_name → round count
      });
    }
    const c = courseMap.get(id);
    c.roundCount++;
    const tee = score.tee_name || '';
    c.tees.set(tee, (c.tees.get(tee) || 0) + 1);
  }

  return Array.from(courseMap.values())
    .sort((a, b) => b.roundCount - a.roundCount);
}

// ── Stats Aggregation ──────────────────────────────────────────────

function getHoleDetails(score) {
  // The API uses "hole_details" but fall back to "hole_scores" just in case
  return score.hole_details || score.hole_scores || [];
}

function computeHoleStats(scores, courseId, tee = null) {
  const courseScores = scores.filter(
    (s) => s.course_id === courseId && getHoleDetails(s).length > 0
      && (tee === null || (s.tee_name || '') === tee)
  );

  if (courseScores.length === 0) return null;

  // Build per-hole stats
  const holes = {};

  for (const round of courseScores) {
    for (const hole of getHoleDetails(round)) {
      const num = hole.hole_number;
      if (!num) continue;

      if (!holes[num]) {
        holes[num] = {
          hole: num,
          par: hole.par || 0,
          scores: [],
        };
      }

      // Prefer adjusted_gross_score, fall back to raw_score
      const strokeCount = hole.adjusted_gross_score ?? hole.raw_score;
      if (strokeCount != null) {
        holes[num].scores.push(strokeCount);
        if (hole.par) holes[num].par = hole.par;
      }
    }
  }

  // Compute aggregates
  const stats = Object.values(holes)
    .sort((a, b) => a.hole - b.hole)
    .map((h) => {
      const n = h.scores.length;
      const avg = h.scores.reduce((s, v) => s + v, 0) / n;
      const variance = h.scores.reduce((s, v) => s + (v - avg) ** 2, 0) / n;
      const stdDev = Math.sqrt(variance);
      return {
        hole: h.hole,
        par: h.par,
        avg: Math.round(avg * 100) / 100,
        vsPar: Math.round((avg - h.par) * 100) / 100,
        stdDev: Math.round(stdDev * 100) / 100,
        best: Math.min(...h.scores),
        worst: Math.max(...h.scores),
        rounds: n,
        scores: h.scores,
      };
    });

  return stats;
}

// ── Round-level Stats ──────────────────────────────────────────────

function computeRoundData(scores, courseId, tee = null) {
  // Returns [{date, total}, ...] sorted oldest→newest, 18-hole valid rounds only
  return scores
    .filter((s) => s.course_id === courseId && getHoleDetails(s).length === 18
      && (tee === null || (s.tee_name || '') === tee))
    .map((s) => {
      const holes = getHoleDetails(s);
      const strokes = holes.map(h => h.adjusted_gross_score ?? h.raw_score);
      if (strokes.some(v => v == null || v <= 0)) return null;
      return {
        date: s.played_at || s.score_date || '',
        total: strokes.reduce((sum, v) => sum + v, 0),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function computeRoundTotals(scores, courseId) {
  return computeRoundData(scores, courseId).map(r => r.total);
}

function renderMovingAverage(roundData, windowSize = 20) {
  if (maInstance) {
    maInstance.destroy();
    maInstance = null;
  }

  if (roundData.length === 0) return;

  // roundData is sorted oldest→newest; compute trailing MA at each point
  const labels = roundData.map(r => r.date || '');
  const rawScores = roundData.map(r => r.total);
  const maScores = rawScores.map((_, i) => {
    const start = Math.max(0, i - windowSize + 1);
    const slice = rawScores.slice(start, i + 1);
    const avg = slice.reduce((s, v) => s + v, 0) / slice.length;
    return Math.round(avg * 10) / 10;
  });

  const ctx = document.getElementById('ma-chart').getContext('2d');
  maInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Round Score',
          data: rawScores,
          borderColor: 'rgba(136,136,136,0.5)',
          backgroundColor: 'transparent',
          borderWidth: 1,
          pointRadius: 2,
          pointHoverRadius: 4,
          fill: false,
          tension: 0,
          order: 2,
        },
        {
          label: '20-Round Moving Avg',
          data: maScores,
          borderColor: '#0f3460',
          backgroundColor: 'rgba(15,52,96,0.08)',
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 4,
          fill: true,
          tension: 0.3,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'top', labels: { font: { size: 11 } } },
        tooltip: {
          callbacks: {
            title: (items) => `Date: ${labels[items[0].dataIndex]}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: 10, maxRotation: 30, font: { size: 10 } },
          grid: { display: false },
        },
        y: {
          title: { display: true, text: 'Score' },
          grid: { color: '#eee' },
        },
      },
    },
  });
}

function descStats(totals) {
  const n = totals.length;
  if (n === 0) return null;
  const sorted = [...totals].sort((a, b) => a - b);
  const mean = totals.reduce((s, v) => s + v, 0) / n;
  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];
  const variance = totals.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);
  return {
    count: n,
    mean: Math.round(mean * 10) / 10,
    median,
    stdDev: Math.round(stdDev * 100) / 100,
    min: sorted[0],
    max: sorted[n - 1],
  };
}

function renderRoundDescStats(stats) {
  const el = document.getElementById('round-desc-stats');
  const items = [
    { label: 'Rounds', value: stats.count },
    { label: 'Mean', value: stats.mean.toFixed(1) },
    { label: 'Median', value: stats.median },
    { label: 'Std Dev', value: stats.stdDev.toFixed(2) },
    { label: 'Best', value: stats.min },
    { label: 'Worst', value: stats.max },
    { label: 'Range', value: stats.max - stats.min },
  ];
  el.innerHTML = items.map((item) => `
    <div class="desc-stat">
      <div class="stat-label">${item.label}</div>
      <div class="stat-value">${item.value}</div>
    </div>
  `).join('');
}

function renderHistogram(totals) {
  if (histogramInstance) {
    histogramInstance.destroy();
    histogramInstance = null;
  }

  if (totals.length === 0) return;

  const min = Math.min(...totals);
  const max = Math.max(...totals);
  const range = max - min;

  // Choose bin width so we get ~8–12 bins; minimum width of 1
  const rawBins = Math.ceil(range / 10) || 1;
  const binWidth = Math.max(1, rawBins);

  // Build bins
  const binCount = Math.ceil((max - min + 1) / binWidth);
  const counts = new Array(binCount).fill(0);
  for (const t of totals) {
    const idx = Math.floor((t - min) / binWidth);
    counts[Math.min(idx, binCount - 1)]++;
  }

  const labels = counts.map((_, i) => {
    const lo = min + i * binWidth;
    const hi = lo + binWidth - 1;
    return binWidth === 1 ? `${lo}` : `${lo}–${hi}`;
  });

  const ctx = document.getElementById('histogram-chart').getContext('2d');
  histogramInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Rounds',
        data: counts,
        backgroundColor: 'rgba(15, 52, 96, 0.65)',
        borderColor: '#0f3460',
        borderWidth: 1,
        barPercentage: 0.95,
        categoryPercentage: 1.0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => `Score: ${items[0].label}`,
            label: (item) => `${item.raw} round${item.raw !== 1 ? 's' : ''}`,
          },
        },
      },
      scales: {
        y: {
          title: { display: true, text: 'Rounds' },
          ticks: { stepSize: 1, precision: 0 },
          grid: { color: '#eee' },
        },
        x: {
          title: { display: true, text: 'Total Score' },
          grid: { display: false },
        },
      },
    },
  });
}

// ── Rendering ──────────────────────────────────────────────────────

function formatVsPar(val) {
  if (val > 0) return `+${val.toFixed(1)}`;
  if (val < 0) return val.toFixed(1);
  return 'E';
}

function vsParClass(val) {
  if (val > 0) return 'over-par';
  if (val < 0) return 'under-par';
  return 'even-par';
}

// ── Table Sorting ──────────────────────────────────────────────────

const sortColumns = ['hole', 'par', 'avg', 'vsPar', 'stdDev', 'best', 'worst', 'rounds'];
let currentSortCol = null;
let currentSortAsc = true;
let currentStats = [];

function initSortableHeaders() {
  const headers = document.querySelectorAll('#stats-table thead th');
  headers.forEach((th, i) => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const col = sortColumns[i];
      if (currentSortCol === col) {
        currentSortAsc = !currentSortAsc;
      } else {
        currentSortCol = col;
        currentSortAsc = true;
      }
      const sorted = [...currentStats].sort((a, b) =>
        currentSortAsc ? a[col] - b[col] : b[col] - a[col]
      );
      renderTableRows(sorted);
      updateSortIndicators(headers, i);
    });
  });
}

function updateSortIndicators(headers, activeIndex) {
  headers.forEach((th, i) => {
    // Strip existing indicator
    th.textContent = th.textContent.replace(/ [▲▼]$/, '');
    if (i === activeIndex) {
      th.textContent += currentSortAsc ? ' ▲' : ' ▼';
    }
  });
}

function renderTable(stats) {
  currentStats = stats;
  currentSortCol = null;
  currentSortAsc = true;
  // Reset sort indicators
  const headers = document.querySelectorAll('#stats-table thead th');
  headers.forEach((th) => {
    th.textContent = th.textContent.replace(/ [▲▼]$/, '');
  });
  renderTableRows(stats);
}

function renderTableRows(stats) {
  statsBody.innerHTML = '';

  let totalPar = 0, totalAvg = 0, totalBest = 0, totalWorst = 0;

  for (const h of stats) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${h.hole}</td>
      <td>${h.par}</td>
      <td>${h.avg.toFixed(1)}</td>
      <td class="${vsParClass(h.vsPar)}">${formatVsPar(h.vsPar)}</td>
      <td>${h.stdDev.toFixed(2)}</td>
      <td>${h.best}</td>
      <td>${h.worst}</td>
      <td>${h.rounds}</td>
    `;
    statsBody.appendChild(tr);

    totalPar += h.par;
    totalAvg += h.avg;
    totalBest += h.best;
    totalWorst += h.worst;
  }

  const totalVsPar = totalAvg - totalPar;
  statsTotals.innerHTML = `
    <td>Total</td>
    <td>${totalPar}</td>
    <td>${totalAvg.toFixed(1)}</td>
    <td class="${vsParClass(totalVsPar)}">${formatVsPar(totalVsPar)}</td>
    <td></td>
    <td>${totalBest}</td>
    <td>${totalWorst}</td>
    <td>${currentStats.length > 0 ? currentStats[0].rounds : 0}</td>
  `;
}

// Initialize sortable headers on load
initSortableHeaders();

// ── Box Plot ───────────────────────────────────────────────────────

function quartile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

function holeBoxStats(holeObj) {
  const sorted = [...holeObj.scores].sort((a, b) => a - b);
  const par = holeObj.par;
  const q1    = quartile(sorted, 0.25) - par;
  const med   = quartile(sorted, 0.5)  - par;
  const q3    = quartile(sorted, 0.75) - par;
  const iqr   = q3 - q1;
  const lo    = q1 - 1.5 * iqr;
  const hi    = q3 + 1.5 * iqr;
  const vsArr = sorted.map(s => s - par);
  const inner = vsArr.filter(v => v >= lo && v <= hi);
  return {
    q1, median: med, q3,
    whiskerMin: Math.min(...inner),
    whiskerMax: Math.max(...inner),
    outliers: vsArr.filter(v => v < lo || v > hi),
  };
}

// Plugin: draws whiskers, median line, and outlier dots over floating bars
const boxPlotPlugin = {
  id: 'boxPlotExtras',
  afterDatasetsDraw(chart) {
    const extras = chart._boxExtras;
    if (!extras) return;
    const ctx = chart.ctx;
    const yScale = chart.scales.y;
    const meta = chart.getDatasetMeta(0);

    ctx.save();
    meta.data.forEach((bar, i) => {
      const d = extras[i];
      if (!d) return;
      const x = bar.x;
      const hw = bar.width / 2;
      const cw = hw / 2;

      // Median line (white so it contrasts with box fill)
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.5;
      const yMed = yScale.getPixelForValue(d.median);
      ctx.beginPath(); ctx.moveTo(x - hw, yMed); ctx.lineTo(x + hw, yMed); ctx.stroke();

      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1.5;

      // Lower whisker
      const yQ1 = yScale.getPixelForValue(d.q1);
      const yWLo = yScale.getPixelForValue(d.whiskerMin);
      ctx.beginPath(); ctx.moveTo(x, yQ1); ctx.lineTo(x, yWLo); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - cw, yWLo); ctx.lineTo(x + cw, yWLo); ctx.stroke();

      // Upper whisker
      const yQ3 = yScale.getPixelForValue(d.q3);
      const yWHi = yScale.getPixelForValue(d.whiskerMax);
      ctx.beginPath(); ctx.moveTo(x, yQ3); ctx.lineTo(x, yWHi); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - cw, yWHi); ctx.lineTo(x + cw, yWHi); ctx.stroke();

      // Outlier dots
      ctx.fillStyle = '#555';
      for (const ov of d.outliers) {
        const yO = yScale.getPixelForValue(ov);
        ctx.beginPath(); ctx.arc(x, yO, 3, 0, Math.PI * 2); ctx.fill();
      }
    });
    ctx.restore();
  },
};

function renderBoxPlot(stats) {
  if (boxPlotInstance) { boxPlotInstance.destroy(); boxPlotInstance = null; }

  const labels  = stats.map(h => `H${h.hole}`);
  const extras  = stats.map(holeBoxStats);

  const colors = extras.map(d =>
    d.median > 0 ? 'rgba(192,57,43,0.65)' : d.median < 0 ? 'rgba(39,174,96,0.65)' : 'rgba(136,136,136,0.65)'
  );
  const borders = extras.map(d =>
    d.median > 0 ? '#c0392b' : d.median < 0 ? '#27ae60' : '#888'
  );

  const ctx = document.getElementById('boxplot-chart').getContext('2d');
  boxPlotInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: extras.map(d => [d.q1, d.q3]),   // floating bar Q1→Q3
        backgroundColor: colors,
        borderColor: borders,
        borderWidth: 1.5,
        barPercentage: 0.5,
        categoryPercentage: 0.8,
      }],
    },
    plugins: [boxPlotPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => `Hole ${stats[items[0].dataIndex].hole} (Par ${stats[items[0].dataIndex].par})`,
            label: (item) => {
              const d = extras[item.dataIndex];
              const h = stats[item.dataIndex];
              return [
                `Median:  ${formatVsPar(d.median)}`,
                `Q1–Q3:  ${formatVsPar(d.q1)} to ${formatVsPar(d.q3)}`,
                `Whiskers: ${formatVsPar(d.whiskerMin)} to ${formatVsPar(d.whiskerMax)}`,
                `Outliers: ${d.outliers.length}  |  Rounds: ${h.rounds}`,
              ];
            },
          },
        },
      },
      scales: {
        y: {
          min: -1.5,
          max: 3.5,
          title: { display: true, text: 'vs Par' },
          grid: { color: '#eee' },
        },
        x: { grid: { display: false } },
      },
    },
  });

  boxPlotInstance._boxExtras = extras;
}

// Chart.js plugin: draw ±1 std dev error bars on each bar
const errorBarPlugin = {
  id: 'errorBars',
  afterDatasetsDraw(chart) {
    const meta = chart.getDatasetMeta(0);
    const ctx = chart.ctx;
    const stdDevs = chart._stdDevData;
    if (!stdDevs) return;

    const yScale = chart.scales.y;

    ctx.save();
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1.5;

    meta.data.forEach((bar, i) => {
      const sd = stdDevs[i];
      if (!sd) return;

      const x = bar.x;
      const yTop = yScale.getPixelForValue(bar.$context.raw + sd);
      const yBot = yScale.getPixelForValue(bar.$context.raw - sd);
      const capW = 6;

      // Vertical line
      ctx.beginPath();
      ctx.moveTo(x, yTop);
      ctx.lineTo(x, yBot);
      ctx.stroke();

      // Top cap
      ctx.beginPath();
      ctx.moveTo(x - capW, yTop);
      ctx.lineTo(x + capW, yTop);
      ctx.stroke();

      // Bottom cap
      ctx.beginPath();
      ctx.moveTo(x - capW, yBot);
      ctx.lineTo(x + capW, yBot);
      ctx.stroke();
    });

    ctx.restore();
  },
};

function renderChart(stats) {
  if (chartInstance) {
    chartInstance.destroy();
  }

  const ctx = document.getElementById('score-chart').getContext('2d');
  const labels = stats.map((h) => `H${h.hole}`);
  const vsParData = stats.map((h) => h.vsPar);
  const stdDevData = stats.map((h) => h.stdDev);

  const colors = vsParData.map((v) =>
    v > 0 ? 'rgba(192, 57, 43, 0.7)' : v < 0 ? 'rgba(39, 174, 96, 0.7)' : 'rgba(136, 136, 136, 0.7)'
  );
  const borderColors = vsParData.map((v) =>
    v > 0 ? '#c0392b' : v < 0 ? '#27ae60' : '#888'
  );

  chartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Avg vs Par',
        data: vsParData,
        backgroundColor: colors,
        borderColor: borderColors,
        borderWidth: 1,
      }],
    },
    plugins: [errorBarPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (tipCtx) => {
              const h = stats[tipCtx.dataIndex];
              return [
                `Avg: ${h.avg.toFixed(1)} (Par ${h.par}, ${formatVsPar(h.vsPar)})`,
                `Std Dev: ${h.stdDev.toFixed(2)}`,
              ];
            },
          },
        },
      },
      scales: {
        y: {
          title: { display: true, text: 'Avg vs Par' },
          min: -1.5,
          max: 3.5,
          grid: { color: '#eee' },
        },
        x: {
          grid: { display: false },
        },
      },
    },
  });

  // Attach std dev data for the plugin
  chartInstance._stdDevData = stdDevData;
}

function populateCourseDropdown(courses) {
  coursesData = courses;
  courseSelect.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '-- Select a course --';
  courseSelect.appendChild(placeholder);

  for (const c of courses) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.name} — ${c.roundCount} round${c.roundCount !== 1 ? 's' : ''}`;
    courseSelect.appendChild(opt);
  }
}

// ── Tee Filter ─────────────────────────────────────────────────────

function renderTeeFilter(courseId) {
  const container = document.getElementById('tee-filter');
  container.innerHTML = '';

  const course = coursesData.find(c => String(c.id) === String(courseId));
  if (!course || course.tees.size <= 1) return;

  const tees = [...course.tees.entries()].sort((a, b) => b[1] - a[1]);

  const wrapper = document.createElement('div');
  wrapper.className = 'tee-radios';

  const allLabel = document.createElement('label');
  allLabel.className = 'tee-radio-label';
  allLabel.innerHTML = `<input type="radio" name="tee-filter" value=""> All Tees`;
  allLabel.querySelector('input').checked = true;
  wrapper.appendChild(allLabel);

  for (const [tee, count] of tees) {
    const label = document.createElement('label');
    label.className = 'tee-radio-label';
    label.innerHTML = `<input type="radio" name="tee-filter" value="${tee}"> ${tee || 'Unknown'} <span class="tee-count">(${count})</span>`;
    wrapper.appendChild(label);
  }

  container.appendChild(wrapper);
}

function renderStats(courseId, tee) {
  const stats = computeHoleStats(allScores, courseId, tee);

  if (!stats || stats.length === 0) {
    statsSection.hidden = true;
    courseInfo.textContent = 'No hole-by-hole data available for this course.';
    return false;
  }

  renderTable(stats);
  renderChart(stats);
  renderBoxPlot(stats);

  const roundData = computeRoundData(allScores, courseId, tee);
  const roundTotals = roundData.map(r => r.total);
  const ds = descStats(roundTotals);
  const roundDistPanel = document.getElementById('round-desc-stats');
  if (ds) {
    renderRoundDescStats(ds);
    renderHistogram(roundTotals);
    renderMovingAverage(roundData);
  } else {
    roundDistPanel.innerHTML = '<p class="muted">No 18-hole round data available for this selection.</p>';
    if (histogramInstance) { histogramInstance.destroy(); histogramInstance = null; }
    if (maInstance) { maInstance.destroy(); maInstance = null; }
  }

  return true;
}

// ── Event Handlers ─────────────────────────────────────────────────

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.hidden = true;

  const ghinNumber = ghinInput.value.trim();
  const password = passwordInput.value;

  if (!ghinNumber || !password) {
    showError('Please enter your GHIN number and password.');
    return;
  }

  loginBtn.disabled = true;
  loginBtn.textContent = 'Signing in...';
  showLoading('Signing in...');

  try {
    await login(ghinNumber, password);

    // Show course section
    userNameEl.textContent = golferName || `GHIN #${ghinNumber}`;
    loginSection.hidden = true;
    courseSection.hidden = false;

    // Fetch all scores
    showLoading('Fetching your scores...');
    allScores = await fetchAllScores();

    if (allScores.length === 0) {
      courseInfo.textContent = 'No scores found in your GHIN account.';
      hideLoading();
      return;
    }

    // Populate course dropdown
    const courses = extractCourses(allScores);
    populateCourseDropdown(courses);

    const withHoleData = allScores.filter((s) => getHoleDetails(s).length > 0);
    courseInfo.textContent =
      `${allScores.length} total rounds found, ${withHoleData.length} with hole-by-hole data.`;

    hideLoading();
  } catch (err) {
    hideLoading();
    loginSection.hidden = false;
    courseSection.hidden = true;
    showError(err.message || 'Login failed. Please check your credentials.');
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign In';
  }
});

courseSelect.addEventListener('change', () => {
  const courseId = courseSelect.value;
  if (!courseId) {
    statsSection.hidden = true;
    document.getElementById('tee-filter').innerHTML = '';
    return;
  }

  const selectedOption = courseSelect.options[courseSelect.selectedIndex];
  const courseName = selectedOption.textContent.split(' — ')[0];
  statsTitle.textContent = courseName;

  renderTeeFilter(courseId);
  const ok = renderStats(courseId, null);
  if (!ok) return;

  // Reset to default tabs
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.hidden = true);
  document.querySelector('.tab-btn[data-tab="tab-rounds"]').classList.add('active');
  document.getElementById('tab-rounds').hidden = false;

  document.querySelectorAll('.subtab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.subtab-panel').forEach(p => p.hidden = true);
  document.querySelector('.subtab-btn[data-subtab="subtab-basic"]').classList.add('active');
  document.getElementById('subtab-basic').hidden = false;

  statsSection.hidden = false;
});

document.getElementById('tee-filter').addEventListener('change', (e) => {
  if (e.target.name !== 'tee-filter') return;
  const courseId = courseSelect.value;
  const tee = e.target.value === '' ? null : e.target.value;
  renderStats(courseId, tee);
});

// ── Tab & Sub-tab switching ─────────────────────────────────────────

document.querySelectorAll('.subtab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.subtab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.subtab-panel').forEach(p => p.hidden = true);
    btn.classList.add('active');
    document.getElementById(btn.dataset.subtab).hidden = false;
  });
});

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.hidden = true);
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).hidden = false;
  });
});

logoutBtn.addEventListener('click', logout);

document.getElementById('toggle-password').addEventListener('click', () => {
  const isPassword = passwordInput.type === 'password';
  passwordInput.type = isPassword ? 'text' : 'password';
  const icon = document.getElementById('eye-icon');
  if (isPassword) {
    // Eye-off (slash through eye)
    icon.innerHTML = `
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    `;
  } else {
    icon.innerHTML = `
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    `;
  }
});
