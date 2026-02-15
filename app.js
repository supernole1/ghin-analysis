// GHIN Hole-by-Hole Analysis — Application Logic

// ── Configuration ──────────────────────────────────────────────────
// Replace with your deployed Cloudflare Worker URL:
const WORKER_URL = 'https://ghin-proxy.supernole1.workers.dev';

// ── State ──────────────────────────────────────────────────────────
let token = null;
let golferId = null;
let golferName = '';
let allScores = [];
let chartInstance = null;

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

  if (!res.ok) throw new Error('Failed to initialize session');

  const data = await res.json();
  return data.authToken?.token || data.token;
}

async function login(ghinNumber, password) {
  // Step 1: Get Firebase Installation token
  const firebaseToken = await getFirebaseToken();

  // Step 2: Login with GHIN credentials + Firebase token
  const data = await apiRequest('/golfer_login.json', {
    method: 'POST',
    body: JSON.stringify({
      user: {
        email_or_ghin: ghinNumber,
        password: password,
        remember_me: false,
        token: firebaseToken,
      },
    }),
  });

  // Extract token and golfer info from response
  // The response shape: { golfer_user: { golfer_user_token: "...", golfer_user_id: ... } }
  // or possibly: { token: "...", golfer: { ... } }
  if (data.golfer_user) {
    token = data.golfer_user.golfer_user_token;
    golferId = data.golfer_user.golfer_user_id;
    golferName = [data.golfer_user.first_name, data.golfer_user.last_name]
      .filter(Boolean).join(' ');
  } else if (data.token) {
    token = data.token;
    golferId = data.golfer?.id || ghinNumber;
    golferName = data.golfer?.name || `GHIN #${ghinNumber}`;
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
    scores.push(...batch);

    // Stop when we've fetched all scores or got a short page
    const totalCount = data.total_count || 0;
    if (scores.length >= totalCount || batch.length < perPage) break;
    page++;
  }

  return scores;
}

function extractCourses(scores) {
  // Build a map of unique courses from scores
  const courseMap = new Map();

  for (const score of scores) {
    const id = score.course_id;
    if (!id) continue;

    if (!courseMap.has(id)) {
      courseMap.set(id, {
        id,
        name: score.course_name || score.facility_name || `Course ${id}`,
        tee: score.tee_name || '',
        roundCount: 0,
      });
    }
    courseMap.get(id).roundCount++;
  }

  // Sort by number of rounds played (most first)
  return Array.from(courseMap.values())
    .sort((a, b) => b.roundCount - a.roundCount);
}

// ── Stats Aggregation ──────────────────────────────────────────────

function getHoleDetails(score) {
  // The API uses "hole_details" but fall back to "hole_scores" just in case
  return score.hole_details || score.hole_scores || [];
}

function computeHoleStats(scores, courseId) {
  // Filter scores for the selected course that have hole-by-hole data
  const courseScores = scores.filter(
    (s) => s.course_id === courseId && getHoleDetails(s).length > 0
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
      const avg = h.scores.reduce((s, v) => s + v, 0) / h.scores.length;
      return {
        hole: h.hole,
        par: h.par,
        avg: Math.round(avg * 100) / 100,
        vsPar: Math.round((avg - h.par) * 100) / 100,
        best: Math.min(...h.scores),
        worst: Math.max(...h.scores),
        rounds: h.scores.length,
      };
    });

  return stats;
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

function renderTable(stats) {
  statsBody.innerHTML = '';

  let totalPar = 0, totalAvg = 0, totalBest = 0, totalWorst = 0;

  for (const h of stats) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${h.hole}</td>
      <td>${h.par}</td>
      <td>${h.avg.toFixed(1)}</td>
      <td class="${vsParClass(h.vsPar)}">${formatVsPar(h.vsPar)}</td>
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

  // Totals row
  const totalVsPar = totalAvg - totalPar;
  statsTotals.innerHTML = `
    <td>Total</td>
    <td>${totalPar}</td>
    <td>${totalAvg.toFixed(1)}</td>
    <td class="${vsParClass(totalVsPar)}">${formatVsPar(totalVsPar)}</td>
    <td>${totalBest}</td>
    <td>${totalWorst}</td>
    <td>${stats.length > 0 ? stats[0].rounds : 0}</td>
  `;
}

function renderChart(stats) {
  if (chartInstance) {
    chartInstance.destroy();
  }

  const ctx = document.getElementById('score-chart').getContext('2d');
  const labels = stats.map((h) => `H${h.hole}`);
  const vsParData = stats.map((h) => h.vsPar);

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
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const h = stats[ctx.dataIndex];
              return `Avg: ${h.avg.toFixed(1)} (Par ${h.par}, ${formatVsPar(h.vsPar)})`;
            },
          },
        },
      },
      scales: {
        y: {
          title: { display: true, text: 'Avg vs Par' },
          grid: { color: '#eee' },
        },
        x: {
          grid: { display: false },
        },
      },
    },
  });
}

function populateCourseDropdown(courses) {
  courseSelect.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '-- Select a course --';
  courseSelect.appendChild(placeholder);

  for (const c of courses) {
    const opt = document.createElement('option');
    opt.value = c.id;
    const teeLabel = c.tee ? ` (${c.tee})` : '';
    opt.textContent = `${c.name}${teeLabel} — ${c.roundCount} round${c.roundCount !== 1 ? 's' : ''}`;
    courseSelect.appendChild(opt);
  }
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
  const courseId = parseInt(courseSelect.value, 10);
  if (!courseId) {
    statsSection.hidden = true;
    return;
  }

  const stats = computeHoleStats(allScores, courseId);

  if (!stats || stats.length === 0) {
    statsSection.hidden = true;
    courseInfo.textContent = 'No hole-by-hole data available for this course. Scores may have been posted as totals only.';
    return;
  }

  // Find the course name for the title
  const selectedOption = courseSelect.options[courseSelect.selectedIndex];
  const courseName = selectedOption.textContent.split(' — ')[0];
  statsTitle.textContent = `Hole-by-Hole Stats: ${courseName}`;

  renderTable(stats);
  renderChart(stats);
  statsSection.hidden = false;
});

logoutBtn.addEventListener('click', logout);
