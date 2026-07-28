const SB_URL = 'https://sqkhizjbmzujvjylovfk.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxa2hpempibXp1anZqeWxvdmZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1MDUxMDYsImV4cCI6MjA5NzA4MTEwNn0.N6uZ_wqumLz9UGs1wCK-EikWQSWMXIWYmISy-Mhulks';
const MB = 'https://musicbrainz.org/ws/2';
const CAA = 'https://coverartarchive.org/release';

// ── Auth (Supabase Google login) ────────────────────────────────
const sbClient = supabase.createClient(SB_URL, SB_KEY);
let currentUser = null;
let USER_ID = null;

async function initAuth() {
  const { data: { session } } = await sbClient.auth.getSession();
  handleSession(session);
  sbClient.auth.onAuthStateChange((_event, session) => handleSession(session));
}

function handleSession(session) {
  currentUser = session?.user || null;
  USER_ID = currentUser?.id || null;
  updateAuthUI();
}

function updateAuthUI() {
  const btn = document.getElementById('avatarBtn');
  if (currentUser) {
    const name = currentUser.user_metadata?.full_name || currentUser.email || 'User';
    const pic = currentUser.user_metadata?.avatar_url;
    btn.innerHTML = pic
      ? `<img src="${pic}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`
      : name.slice(0, 2).toUpperCase();
    btn.onclick = () => showPage('profile');
  } else {
    btn.innerHTML = '<i class="ti ti-login"></i>';
    btn.onclick = () => loginWithGoogle();
  }
}

async function loginWithGoogle() {
  await sbClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href }
  });
}

async function logout() {
  await sbClient.auth.signOut();
  toast('Berhasil logout');
  showPage('home');
}

function requireLogin() {
  if (!currentUser) {
    toast('Login dulu buat rating, review, atau simpan album');
    loginWithGoogle();
    return false;
  }
  return true;
}

// ── Supabase helper ──────────────────────────────────────────
async function sb(table, method = 'GET', body = null, qs = '') {
  const headers = {
    'apikey': SB_KEY,
    'Authorization': `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': method === 'POST'
      ? 'return=representation,resolution=merge-duplicates'
      : 'return=representation'
  };
  const res = await fetch(`${SB_URL}/rest/v1/${table}${qs}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

// ── MusicBrainz ──────────────────────────────────────────────
const coverCache = {};

async function getCover(mbid) {
  if (coverCache[mbid] !== undefined) return coverCache[mbid];
  try {
    const r = await fetch(`${CAA}/${mbid}/front-250`, { method: 'HEAD' });
    coverCache[mbid] = r.ok ? `${CAA}/${mbid}/front-250` : null;
  } catch {
    coverCache[mbid] = null;
  }
  return coverCache[mbid];
}

async function mbSearch(q, limit = 12) {
  const r = await fetch(
    `${MB}/release/?query=${encodeURIComponent(q)}&limit=${limit}&fmt=json`,
    { headers: { 'Accept': 'application/json', 'User-Agent': 'Albumly/1.0' } }
  );
  const d = await r.json();
  return (d.releases || []).map(x => ({
    mbid: x.id,
    title: x.title,
    artist: x['artist-credit']?.[0]?.name || 'Unknown',
    year: x.date?.slice(0, 4) || '—'
  }));
}

// ── State ─────────────────────────────────────────────────────
let myRatings = {}, mySaved = new Set(), currentAlbum = null, prevPage = 'home';

function esc(s) {
  return (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
function starsStr(n) {
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ── Render helpers ────────────────────────────────────────────
function coverEl(url, ph = '🎵', cls = 'album-cover') {
  return url
    ? `<img class="${cls}" src="${url}" loading="lazy" onerror="this.outerHTML='<div class=\\'${cls}-ph\\'>${ph}</div>'">`
    : `<div class="${cls}-ph">${ph}</div>`;
}

async function renderGrid(containerId, albums) {
  const el = document.getElementById(containerId);
  if (!albums.length) {
    el.innerHTML = '<div class="empty"><i class="ti ti-music-off"></i><p>tidak ada hasil.</p></div>';
    return;
  }
  el.innerHTML = '<div class="loader"><div class="spinner"></div> memuat cover...</div>';
  const list = await Promise.all(
    albums.map(async a => ({ ...a, cover: a.cover || await getCover(a.mbid) }))
  );
  el.innerHTML = `<div class="album-grid">${list.map(a => `
    <div class="album-card" onclick="openDetail('${esc(a.mbid)}','${esc(a.title)}','${esc(a.artist)}','${a.year || '—'}','${esc(a.cover || '')}')">
      ${coverEl(a.cover, '🎵', 'album-cover')}
      <div class="album-info">
        <div class="album-title">${a.title}</div>
        <div class="album-artist">${a.artist}</div>
        <div class="album-bottom">
          <span class="stars-sm">${myRatings[a.mbid] ? '★'.repeat(myRatings[a.mbid]) : '—'}</span>
          <span class="year-sm">${a.year || '—'}</span>
        </div>
      </div>
    </div>`).join('')}</div>`;
}

// ── HOME ──────────────────────────────────────────────────────
async function loadHome() {
  try {
    const [r, rv, s] = await Promise.all([
      sb('ratings', 'GET', null, '?select=id'),
      sb('reviews', 'GET', null, '?select=id'),
      sb('saved_albums', 'GET', null, '?select=id')
    ]);
    document.getElementById('sTotalRating').textContent = r?.length || 0;
    document.getElementById('sTotalReview').textContent = rv?.length || 0;
    document.getElementById('sTotalSaved').textContent = s?.length || 0;

    if (USER_ID) {
      const mine = await sb('ratings', 'GET', null, `?user_id=eq.${USER_ID}&select=mbid,stars`);
      mine?.forEach(x => myRatings[x.mbid] = x.stars);

      const saved = await sb('saved_albums', 'GET', null, `?user_id=eq.${USER_ID}&select=mbid`);
      saved?.forEach(x => mySaved.add(x.mbid));
    }
  } catch (e) {
    // silently fail — DB errors don't surface to user
  }

  try {
    const albums = await mbSearch('Kendrick Lamar', 8);
    await renderGrid('homeGrid', albums);
  } catch {
    document.getElementById('homeGrid').innerHTML =
      '<div class="empty"><i class="ti ti-wifi-off"></i><p>Gagal memuat. Pastikan koneksi internet aktif.</p></div>';
  }
}

// ── SEARCH ────────────────────────────────────────────────────
async function doSearch() {
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return;
  const el = document.getElementById('searchResults');
  el.innerHTML = '<div class="loader"><div class="spinner"></div> mencari...</div>';
  try {
    const albums = await mbSearch(q, 16);
    if (!albums.length) {
      el.innerHTML = `<div class="empty"><i class="ti ti-search-off"></i><p>Tidak ada hasil untuk "${q}".</p></div>`;
      return;
    }
    await renderGrid('searchResults', albums);
  } catch {
    el.innerHTML = '<div class="empty"><i class="ti ti-wifi-off"></i><p>Gagal mencari.</p></div>';
  }
}

// ── TRENDING ──────────────────────────────────────────────────
async function loadTrending() {
  const el = document.getElementById('trendingList');
  el.innerHTML = '<div class="loader"><div class="spinner"></div> memuat dari database...</div>';
  try {
    const rows = await sb('ratings', 'GET', null,
      '?select=mbid,album_title,artist,cover_url,stars&order=created_at.desc&limit=50');
    if (!rows?.length) {
      el.innerHTML = '<div class="empty"><i class="ti ti-chart-bar"></i><p>No one has been rated yet. Be the first!</p></div>';
      return;
    }
    const map = {};
    rows.forEach(r => {
      if (!map[r.mbid]) map[r.mbid] = {
        mbid: r.mbid, title: r.album_title, artist: r.artist,
        cover: r.cover_url, total: 0, count: 0
      };
      map[r.mbid].total += r.stars;
      map[r.mbid].count++;
    });
    const sorted = Object.values(map)
      .map(a => ({ ...a, avg: (a.total / a.count).toFixed(1) }))
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 15);
    el.innerHTML = sorted.map((a, i) => `
      <div class="trend-item" onclick="openDetail('${esc(a.mbid)}','${esc(a.title)}','${esc(a.artist)}','—','${esc(a.cover || '')}')">
        <div class="trend-rank">${i + 1}</div>
        ${a.cover
          ? `<img class="trend-cover" src="${a.cover}" onerror="this.outerHTML='<div class=trend-cover-ph>🎵</div>'">`
          : '<div class="trend-cover-ph">🎵</div>'}
        <div class="trend-info">
          <div class="trend-title">${a.title}</div>
          <div class="trend-artist">${a.artist}</div>
        </div>
        <div class="trend-meta">
          <div class="trend-rating">⭐ ${a.avg}</div>
          <div class="trend-count">${a.count} rating</div>
        </div>
      </div>`).join('');
  } catch {
    el.innerHTML = '<div class="empty"><i class="ti ti-wifi-off"></i><p>Gagal memuat.</p></div>';
  }
}

// ── GENRE ─────────────────────────────────────────────────────
const GENRES = {
  'Semua':      { emoji: '🎵', color: '#EEEDFE', tc: '#3C3489' },
  'Hip-Hop':    { emoji: '🎤', color: '#FAECE7', tc: '#712B13', tag: 'hip hop' },
  'R&B':        { emoji: '🌊', color: '#E1F5EE', tc: '#085041', tag: 'r&b' },
  'Electronic': { emoji: '⚡', color: '#E6F1FB', tc: '#0C447C', tag: 'electronic' },
  'Pop':        { emoji: '🌸', color: '#FBEAF0', tc: '#72243E', tag: 'pop' },
  'Rock':       { emoji: '🎸', color: '#F1EFE8', tc: '#444441', tag: 'rock' },
  'Jazz':       { emoji: '🎷', color: '#FAEEDA', tc: '#633806', tag: 'jazz' },
  'Indie':      { emoji: '🌿', color: '#EAF3DE', tc: '#27500A', tag: 'indie' },
};
let activeGenre = 'Semua';

function renderGenreChips(active) {
  document.getElementById('genreChips').innerHTML = Object.keys(GENRES).map(g =>
    `<button class="genre-chip ${g === active ? 'active' : ''}" onclick="filterGenre('${g}')">${GENRES[g].emoji} ${g}</button>`
  ).join('');
}

function renderGenreCards() {
  document.getElementById('genreCards').innerHTML = Object.entries(GENRES)
    .filter(([g]) => g !== 'Semua')
    .map(([g, m]) => `
      <div class="genre-card" style="background:${m.color}" onclick="filterGenre('${g}')">
        <div class="g-emoji">${m.emoji}</div>
        <div class="g-name" style="color:${m.tc}">${g}</div>
        <div class="g-sub" style="color:${m.tc}">ketuk untuk jelajahi</div>
      </div>`
    ).join('');
}

async function filterGenre(genre) {
  activeGenre = genre;
  renderGenreChips(genre);
  const cards  = document.getElementById('genreCards');
  const albums = document.getElementById('genreAlbums');
  const loader = document.getElementById('genreLoader');
  const empty  = document.getElementById('genreEmpty');

  if (genre === 'Semua') {
    cards.style.display  = 'grid';
    albums.style.display = 'none';
    loader.style.display = 'none';
    empty.style.display  = 'none';
    document.getElementById('genreTitle').textContent = 'jelajahi genre';
    document.getElementById('genreCount').textContent = '';
    renderGenreCards();
    return;
  }

  const m = GENRES[genre];
  cards.style.display  = 'none';
  albums.style.display = 'none';
  empty.style.display  = 'none';
  loader.style.display = 'flex';
  document.getElementById('genreTitle').textContent = `${m.emoji} ${genre}`;

  try {
    const tag = m.tag || genre.toLowerCase();
    const r = await fetch(
      `${MB}/release/?query=tag:${encodeURIComponent(tag)}&limit=12&fmt=json`,
      { headers: { 'Accept': 'application/json', 'User-Agent': 'Albumly/1.0' } }
    );
    const d = await r.json();
    const list = (d.releases || []).map(x => ({
      mbid: x.id,
      title: x.title,
      artist: x['artist-credit']?.[0]?.name || 'Unknown',
      year: x.date?.slice(0, 4) || '—'
    }));
    loader.style.display = 'none';
    document.getElementById('genreCount').textContent = `${list.length} album`;
    if (!list.length) { empty.style.display = 'block'; return; }
    albums.style.display = 'grid';
    await renderGrid('genreAlbums', list);
  } catch {
    loader.style.display = 'none';
    empty.style.display  = 'block';
  }
}

// ── DETAIL ────────────────────────────────────────────────────
async function openDetail(mbid, title, artist, year, coverUrl) {
  const cur = document.querySelector('.page.active');
  prevPage = cur ? cur.id.replace('page-', '') : 'home';
  currentAlbum = { mbid, title, artist, year, coverUrl };

  document.getElementById('dCover').innerHTML = coverUrl
    ? `<img class="detail-cover-img" src="${coverUrl}" onerror="this.outerHTML='🎵'">`
    : '🎵';
  document.getElementById('dTitle').textContent = title;
  document.getElementById('dArtist').textContent = artist;
  document.getElementById('dMeta').innerHTML = `<span class="pill">${year}</span>`;
  document.getElementById('dRating').textContent = '—';
  document.getElementById('dStars').textContent = '';
  document.getElementById('dRatingSub').textContent = 'memuat...';
  document.getElementById('reviewsList').innerHTML =
    '<div class="loader"><div class="spinner"></div> memuat review...</div>';

  const saved = mySaved.has(mbid);
  document.getElementById('saveBtn').className = 'btn-save' + (saved ? ' saved' : '');
  document.getElementById('saveText').textContent = saved ? 'tersimpan' : 'simpan';

  showPage('detail', true);

  // Build star picker
  const myS = myRatings[mbid] || 0;
  document.getElementById('starRow').innerHTML = [1, 2, 3, 4, 5].map(s =>
    `<button class="star-btn ${s <= myS ? 'filled' : ''}" onclick="doRate('${esc(mbid)}',${s})"
      onmouseover="hoverS(${s})" onmouseout="resetS('${esc(mbid)}')">★</button>`
  ).join('');

  // Load DB data
  const [ratingRows, reviewRows] = await Promise.all([
    sb('ratings', 'GET', null, `?mbid=eq.${mbid}&select=stars`),
    sb('reviews', 'GET', null, `?mbid=eq.${mbid}&order=created_at.desc`)
  ]);

  if (ratingRows?.length) {
    const avg = (ratingRows.reduce((s, r) => s + r.stars, 0) / ratingRows.length).toFixed(1);
    document.getElementById('dRating').textContent = avg;
    document.getElementById('dStars').textContent = starsStr(Math.round(avg));
    document.getElementById('dRatingSub').textContent = `rata-rata dari ${ratingRows.length} rating`;
  } else {
    document.getElementById('dRating').textContent = '—';
    document.getElementById('dStars').textContent = '';
    document.getElementById('dRatingSub').textContent = 'belum ada rating';
  }

  renderReviews(reviewRows || []);
}

function hoverS(n) {
  document.querySelectorAll('.star-btn').forEach((b, i) =>
    b.style.color = i < n ? '#f59e0b' : 'var(--text3)');
}
function resetS(mbid) {
  const u = myRatings[mbid] || 0;
  document.querySelectorAll('.star-btn').forEach((b, i) =>
    b.style.color = i < u ? '#f59e0b' : 'var(--text3)');
}

async function doRate(mbid, stars) {
  if (!requireLogin()) return;
  myRatings[mbid] = stars;
  resetS(mbid);
  const a = currentAlbum;
  try {
    await sb('ratings', 'POST',
      { user_id: USER_ID, user_name: currentUser.user_metadata?.full_name || currentUser.email, mbid, stars, album_title: a.title, artist: a.artist, cover_url: a.coverUrl || null },
      '?on_conflict=user_id,mbid'
    );
    toast(`⭐ Rating ${stars} bintang tersimpan`);
    const rows = await sb('ratings', 'GET', null, `?mbid=eq.${mbid}&select=stars`);
    if (rows?.length) {
      const avg = (rows.reduce((s, r) => s + r.stars, 0) / rows.length).toFixed(1);
      document.getElementById('dRating').textContent = avg;
      document.getElementById('dStars').textContent = starsStr(Math.round(avg));
      document.getElementById('dRatingSub').textContent = `rata-rata dari ${rows.length} rating`;
    }
  } catch {
    toast('Gagal menyimpan rating');
  }
}

async function toggleSave() {
  if (!currentAlbum) return;
  if (!requireLogin()) return;
  const { mbid, title, artist, coverUrl } = currentAlbum;
  try {
    if (mySaved.has(mbid)) {
      await sb('saved_albums', 'DELETE', null, `?user_id=eq.${USER_ID}&mbid=eq.${mbid}`);
      mySaved.delete(mbid);
      document.getElementById('saveBtn').className = 'btn-save';
      document.getElementById('saveText').textContent = 'simpan';
      toast('Dihapus dari simpanan');
    } else {
      await sb('saved_albums', 'POST',
        { user_id: USER_ID, user_name: currentUser.user_metadata?.full_name || currentUser.email, mbid, album_title: title, artist, cover_url: coverUrl || null },
        '?on_conflict=user_id,mbid'
      );
      mySaved.add(mbid);
      document.getElementById('saveBtn').className = 'btn-save saved';
      document.getElementById('saveText').textContent = 'tersimpan';
      toast('Album disimpan ✓');
    }
  } catch {
    toast('Gagal menyimpan');
  }
}

function renderReviews(list) {
  const el = document.getElementById('reviewsList');
  if (!list.length) {
    el.innerHTML = '<div class="empty"><i class="ti ti-message-circle"></i><p>Belum ada review. Jadilah yang pertama!</p></div>';
    return;
  }
  el.innerHTML = list.map(r => `
    <div class="review-card">
      <div class="review-top">
        <div class="rev-av">${(r.user_name || r.user_id || '?').slice(0, 2).toUpperCase()}</div>
        <div>
          <div class="rev-name">${r.user_name || r.user_id}</div>
          <div class="rev-date">${new Date(r.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
        </div>
        ${r.stars ? `<div class="rev-stars">${'★'.repeat(r.stars)}</div>` : ''}
      </div>
      <div class="rev-text">${r.review_text}</div>
    </div>`).join('');
}

async function submitReview() {
  const txt = document.getElementById('reviewTxt').value.trim();
  if (!txt || !currentAlbum) return;
  if (!requireLogin()) return;
  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';
  try {
    await sb('reviews', 'POST', {
      user_id: USER_ID,
      user_name: currentUser.user_metadata?.full_name || currentUser.email,
      mbid: currentAlbum.mbid,
      review_text: txt,
      stars: myRatings[currentAlbum.mbid] || 0,
      album_title: currentAlbum.title,
      artist: currentAlbum.artist
    });
    document.getElementById('reviewTxt').value = '';
    toast('Review tersimpan ✓');
    const rows = await sb('reviews', 'GET', null, `?mbid=eq.${currentAlbum.mbid}&order=created_at.desc`);
    renderReviews(rows || []);
  } catch {
    toast('Gagal menyimpan review');
  }
  btn.disabled = false;
  btn.textContent = 'Kirim Review';
}

// ── PROFILE ───────────────────────────────────────────────────
async function loadProfile() {
  if (!currentUser) {
    document.getElementById('profileFeed').innerHTML =
      '<div class="empty"><i class="ti ti-login"></i><p>Login dulu buat lihat profil kamu.</p><button class="btn-primary" style="margin-top:10px;" onclick="loginWithGoogle()">Login with Google</button></div>';
    document.getElementById('profileName').textContent = 'Belum login';
    document.getElementById('profileBio').textContent = '';
    document.getElementById('myRated').textContent = '—';
    document.getElementById('myReviewed').textContent = '—';
    document.getElementById('mySaved').textContent = '—';
    return;
  }

  const name = currentUser.user_metadata?.full_name || currentUser.email;
  const pic = currentUser.user_metadata?.avatar_url;
  document.getElementById('profileName').textContent = name;
  document.getElementById('profileBio').textContent = currentUser.email;
  document.getElementById('profileAv').innerHTML = pic
    ? `<img src="${pic}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`
    : name.slice(0, 2).toUpperCase();
  document.getElementById('writeAv').innerHTML = pic
    ? `<img src="${pic}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`
    : name.slice(0, 2).toUpperCase();
  document.getElementById('writeName').textContent = name;

  try {
    const [ratings, reviews, saved] = await Promise.all([
      sb('ratings', 'GET', null, `?user_id=eq.${USER_ID}&order=created_at.desc`),
      sb('reviews', 'GET', null, `?user_id=eq.${USER_ID}&order=created_at.desc`),
      sb('saved_albums', 'GET', null, `?user_id=eq.${USER_ID}&order=created_at.desc`)
    ]);
    document.getElementById('myRated').textContent    = ratings?.length || 0;
    document.getElementById('myReviewed').textContent = reviews?.length || 0;
    document.getElementById('mySaved').textContent    = saved?.length   || 0;

    const activities = [
      ...(ratings || []).map(r => ({ cover: r.cover_url,  title: r.album_title, sub: `Rating ⭐ ${r.stars} bintang`,          date: r.created_at })),
      ...(reviews || []).map(r => ({ cover: null,          title: r.album_title, sub: r.review_text.slice(0, 70) + (r.review_text.length > 70 ? '...' : ''), date: r.created_at })),
      ...(saved   || []).map(r => ({ cover: r.cover_url,  title: r.album_title, sub: 'Disimpan ke koleksi',                   date: r.created_at })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 20);

    const el = document.getElementById('profileFeed');
    if (!activities.length) {
      el.innerHTML = '<div class="empty"><i class="ti ti-history"></i><p>Belum ada aktivitas.</p></div>';
      return;
    }
    el.innerHTML =
      `<div class="section-header" style="margin-bottom:12px;"><span class="section-title">aktivitas terbaru</span></div>` +
      activities.map(a => `
        <div class="activity-item">
          ${a.cover
            ? `<img class="act-img" style="object-fit:cover;" src="${a.cover}" onerror="this.outerHTML='<div class=act-img>🎵</div>'">`
            : `<div class="act-img">🎵</div>`}
          <div class="act-body">
            <div class="act-title">${a.title || '—'}</div>
            <div class="act-sub">${a.sub} · ${new Date(a.date).toLocaleDateString('id-ID')}</div>
          </div>
        </div>`).join('');
  } catch {
    document.getElementById('profileFeed').innerHTML =
      '<div class="empty"><i class="ti ti-wifi-off"></i><p>Gagal memuat profil.</p></div>';
  }
}

// ── NAV ───────────────────────────────────────────────────────
function goBack() { showPage(prevPage, true); }

function showPage(name, skipNav) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  if (!skipNav) {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById('nav-' + name);
    if (btn) btn.classList.add('active');
  }
  if (name === 'trending') loadTrending();
  if (name === 'profile')  loadProfile();
}

// ── INIT ──────────────────────────────────────────────────────
renderGenreChips('Semua');
renderGenreCards();
initAuth();
loadHome();