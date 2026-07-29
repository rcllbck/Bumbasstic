const SB_URL = 'https://sqkhizjbmzujvjylovfk.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxa2hpempibXp1anZqeWxvdmZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1MDUxMDYsImV4cCI6MjA5NzA4MTEwNn0.N6uZ_wqumLz9UGs1wCK-EikWQSWMXIWYmISy-Mhulks';
const MB = 'https://musicbrainz.org/ws/2';
const CAA = 'https://coverartarchive.org/release';

// ── Auth (Supabase Google login) ────────────────────────────────
const sbClient = supabase.createClient(SB_URL, SB_KEY);
let currentUser = null;
let USER_ID = null;
let myProfile = null;

async function initAuth() {
  const { data: { session } } = await sbClient.auth.getSession();
  await handleSession(session);
  sbClient.auth.onAuthStateChange((_event, session) => handleSession(session));
}

async function handleSession(session) {
  currentUser = session?.user || null;
  USER_ID = currentUser?.id || null;
  myProfile = null;
  if (currentUser) await ensureProfile();
  updateAuthUI();
  await loadNotifications();
  if (location.hash.includes('access_token')) {
    history.replaceState(null, '', window.location.pathname);
  }
  const active = document.querySelector('.page.active');
  if (active?.id === 'page-profile') loadProfile();
  if (active?.id === 'page-home') loadHome();
}

function slugUsername(base) {
  const clean = (base || 'user').toLowerCase().replace(/[^a-z0-9]/g, '');
  return (clean || 'user').slice(0, 16) + Math.floor(Math.random() * 9000 + 1000);
}

async function ensureProfile() {
  try {
    const rows = await sb('profiles', 'GET', null, `?user_id=eq.${USER_ID}&select=*`);
    if (rows?.length) {
      myProfile = rows[0];
      return;
    }
    const defaultName = currentUser.user_metadata?.full_name || currentUser.email?.split('@')[0] || 'user';
    const created = await sb('profiles', 'POST',
      { user_id: USER_ID, username: slugUsername(defaultName), avatar_url: currentUser.user_metadata?.avatar_url || null }
    );
    myProfile = created?.[0] || null;
  } catch {
    myProfile = { user_id: USER_ID, username: 'user', avatar_url: null };
  }
}

function avatarHtml(url, initials) {
  return url
    ? `<img src="${url}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`
    : (initials || '?').slice(0, 2).toUpperCase();
}

function updateAuthUI() {
  const btn = document.getElementById('avatarBtn');
  if (currentUser && myProfile) {
    btn.innerHTML = avatarHtml(myProfile.avatar_url, myProfile.username);
    btn.onclick = () => showPage('profile');
  } else {
    btn.innerHTML = '<i class="ti ti-login"></i>';
    btn.onclick = () => loginWithGoogle();
  }
}

async function loginWithGoogle() {
  const cleanUrl = window.location.origin + window.location.pathname;
  await sbClient.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: cleanUrl,
      queryParams: { prompt: 'select_account' }
    }
  });
}

async function logout() {
  await sbClient.auth.signOut();
  toast('Successfully logged out');
  showPage('home');
}

function requireLogin() {
  if (!currentUser) {
    toast('Log in first to rate, review, or save an album');
    loginWithGoogle();
    return false;
  }
  return true;
}

function toggleEditProfile() {
  const box = document.getElementById('editProfileBox');
  box.style.display = box.style.display === 'none' ? 'block' : 'none';
}

async function saveProfileEdits() {
  const usernameInput = document.getElementById('editUsername');
  const fileInput = document.getElementById('editAvatarFile');
  const btn = document.getElementById('saveProfileBtn');
  const newUsername = usernameInput.value.trim();
  if (!newUsername) { toast('Username tidak boleh kosong'); return; }

  btn.disabled = true;
  btn.textContent = 'Menyimpan...';
  try {
    let avatarUrl = myProfile.avatar_url;
    const file = fileInput.files[0];
    if (file) {
      const ext = file.name.split('.').pop();
      const path = `${USER_ID}/avatar.${ext}`;
      const upRes = await fetch(`${SB_URL}/storage/v1/object/avatars/${path}?upsert=true`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${(await sbClient.auth.getSession()).data.session.access_token}`,
          'Content-Type': file.type
        },
        body: file
      });
      if (!upRes.ok) throw new Error('upload failed');
      avatarUrl = `${SB_URL}/storage/v1/object/public/avatars/${path}?t=${Date.now()}`;
    }
    const visibility = document.getElementById('editTrackVisibility').value;
    const updated = await sb('profiles', 'PATCH',
      { username: newUsername, avatar_url: avatarUrl, track_rating_visibility: visibility },
      `?user_id=eq.${USER_ID}`
    );
    myProfile = updated?.[0] || { ...myProfile, username: newUsername, avatar_url: avatarUrl, track_rating_visibility: visibility };
    updateAuthUI();
    renderProfileInfo();
    toast('Profile updated successfully ✓');
  } catch {
    toast('Failed to save profile');
  }
  btn.disabled = false;
  btn.textContent = 'Save Profile';
}

// ── Supabase helper ──────────────────────────────────────────
async function sb(table, method = 'GET', body = null, qs = '') {
  let token = SB_KEY;
  try {
    const { data: { session } } = await sbClient.auth.getSession();
    if (session?.access_token) token = session.access_token;
  } catch { /* fall back to anon key */ }

  const headers = {
    'apikey': SB_KEY,
    'Authorization': `Bearer ${token}`,
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
let myRatings = {}, mySaved = new Set(), myFavAlbums = new Set(), myFollowing = new Set(), currentAlbum = null, prevPage = 'home';

function esc(s) {
  return (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
function starFillPct(rating, idx) {
  if (rating >= idx) return 100;
  if (rating >= idx - 0.5) return 50;
  return 0;
}

function starsHtml(rating, size = 14) {
  return [1, 2, 3, 4, 5].map(i => `
    <span style="position:relative;display:inline-block;width:${size}px;height:${size}px;line-height:1;font-size:${size}px;vertical-align:middle;">
      <span style="position:absolute;left:0;top:0;color:var(--text3);">★</span>
      <span style="position:absolute;left:0;top:0;width:${starFillPct(rating, i)}%;overflow:hidden;color:#f59e0b;white-space:nowrap;">★</span>
    </span>`).join('');
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
  el.innerHTML = '<div class="loader"><div class="spinner"></div> loading cover...</div>';
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
          <span class="stars-sm">${myRatings[a.mbid] ? starsHtml(myRatings[a.mbid], 11) : '—'}</span>
          <span class="year-sm">${a.year || '—'}</span>
        </div>
      </div>
    </div>`).join('')}</div>`;
}

// ── HOME ──────────────────────────────────────────────────────
async function loadNewReleases() {
  const el = document.getElementById('newReleasesGrid');
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 60 * 24 * 60 * 60 * 1000); // last 60 days
    const fmt = d => d.toISOString().slice(0, 10);
    const r = await fetch(
      `${MB}/release/?query=date:[${fmt(start)} TO ${fmt(end)}] AND status:official&fmt=json&limit=25`,
      { headers: { 'Accept': 'application/json', 'User-Agent': 'Albumly/1.0' } }
    );
    const d = await r.json();
    const releases = (d.releases || [])
      .filter(rel => rel.date && rel['artist-credit']?.length && /^\d{4}-\d{2}-\d{2}$/.test(rel.date))
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 8)
      .map(rel => ({
        mbid: rel.id,
        title: rel.title,
        artist: rel['artist-credit'].map(c => c.name).join(', '),
        year: rel.date.slice(0, 4)
      }));
    if (!releases.length) {
      el.innerHTML = '<div class="empty"><i class="ti ti-calendar-off"></i><p>No recent releases found.</p></div>';
      return;
    }
    await renderGrid('newReleasesGrid', releases);
  } catch {
    el.innerHTML = '<div class="empty"><i class="ti ti-wifi-off"></i><p>Failed to load new releases.</p></div>';
  }
}

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

      const favs = await sb('favorite_albums', 'GET', null, `?user_id=eq.${USER_ID}&select=mbid`);
      favs?.forEach(x => myFavAlbums.add(x.mbid));
    }
  } catch (e) {
    // silently fail — DB errors don't surface to user
  }

  try {
    const rows = await sb('ratings', 'GET', null, '?select=mbid,album_title,artist,cover_url');
    const map = {};
    (rows || []).forEach(r => {
      if (!map[r.mbid]) map[r.mbid] = { mbid: r.mbid, title: r.album_title, artist: r.artist, cover: r.cover_url, count: 0 };
      map[r.mbid].count++;
    });
    const popular = Object.values(map).sort((a, b) => b.count - a.count).slice(0, 8);

    if (popular.length >= 4) {
      await renderGrid('homeGrid', popular);
    } else {
      const albums = await mbSearch('Kendrick Lamar', 8);
      await renderGrid('homeGrid', albums);
    }
  } catch {
    document.getElementById('homeGrid').innerHTML =
      '<div class="empty"><i class="ti ti-wifi-off"></i><p>Failed to load. Make sure your internet connection is active.</p></div>';
  }

  loadNewReleases();
}

// ── SEARCH ────────────────────────────────────────────────────
async function doSearch(overrideQuery) {
  const input = document.getElementById('searchInput');
  const q = overrideQuery || input.value.trim();
  if (!q) return;
  if (overrideQuery) input.value = overrideQuery;

  const el = document.getElementById('searchResults');
  const artistWrap = document.getElementById('searchArtistsWrap');
  const artistEl = document.getElementById('searchArtists');
  el.innerHTML = '<div class="loader"><div class="spinner"></div> searching...</div>';
  artistWrap.style.display = 'none';

  try {
    const [albums, artists] = await Promise.all([
      mbSearch(q, 16),
      mbArtistSearch(q, 6)
    ]);

    if (artists.length) {
      artistWrap.style.display = 'block';
      artistEl.innerHTML = artists.map(a => `
        <div class="trend-item" onclick="doSearch('${esc(a.name)}')">
          <div class="trend-cover-ph">🎤</div>
          <div class="trend-info">
            <div class="trend-title">${a.name}</div>
            <div class="trend-artist">${a.country || 'Artist'}</div>
          </div>
        </div>`).join('');
    } else {
      artistWrap.style.display = 'none';
    }

    if (!albums.length) {
      el.innerHTML = `<div class="empty"><i class="ti ti-search-off"></i><p>No results for "${q}".</p></div>`;
      return;
    }
    await renderGrid('searchResults', albums);
  } catch {
    el.innerHTML = '<div class="empty"><i class="ti ti-wifi-off"></i><p>Search failed.</p></div>';
  }
}

// ── TRENDING ──────────────────────────────────────────────────
async function loadTrending() {
  const el = document.getElementById('trendingList');
  el.innerHTML = '<div class="loader"><div class="spinner"></div> loading from database...</div>';
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
    el.innerHTML = '<div class="empty"><i class="ti ti-wifi-off"></i><p>Failed to load.</p></div>';
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

function fmtDuration(ms) {
  if (!ms) return '—';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── NOTIFICATIONS ─────────────────────────────────────────────
let notifications = [];

async function loadNotifications() {
  if (!USER_ID) {
    notifications = [];
    updateNotifBadge();
    return;
  }
  try {
    const rows = await sb('notifications', 'GET', null, `?user_id=eq.${USER_ID}&order=created_at.desc&limit=20`);
    notifications = rows || [];
    const actorIds = [...new Set(notifications.map(n => n.actor_id))];
    let actorMap = {};
    if (actorIds.length) {
      const profiles = await sb('profiles', 'GET', null, `?user_id=in.(${actorIds.join(',')})&select=user_id,username,avatar_url`);
      (profiles || []).forEach(p => actorMap[p.user_id] = p);
    }
    notifications.forEach(n => n.actor = actorMap[n.actor_id] || { username: 'someone', avatar_url: null });
    updateNotifBadge();
  } catch { /* ignore */ }
}

function updateNotifBadge() {
  const badge = document.getElementById('notifBadge');
  if (!badge) return;
  const unread = notifications.filter(n => !n.is_read).length;
  if (unread > 0) {
    badge.textContent = unread > 9 ? '9+' : unread;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function timeAgo(dateStr) {
  const diffSec = Math.floor((Date.now() - new Date(dateStr)) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function renderNotifPanel() {
  const el = document.getElementById('notifPanel');
  if (!notifications.length) {
    el.innerHTML = '<div class="empty" style="padding:1.5rem;"><i class="ti ti-bell-off"></i><p>No notifications yet.</p></div>';
    return;
  }
  el.innerHTML = notifications.map(n => {
    const text = n.type === 'follow' ? `<b style="cursor:pointer;" onclick="closeNotifPanel(); viewUserProfile('${esc(n.actor_id)}')">${n.actor.username}</b> started following you` : '';
    return `
    <div class="notif-item ${n.is_read ? '' : 'unread'}">
      <div class="notif-av">${avatarHtml(n.actor.avatar_url, n.actor.username)}</div>
      <div>
        <div>${text}</div>
        <div class="notif-time">${timeAgo(n.created_at)}</div>
      </div>
    </div>`;
  }).join('');
}

async function markAllNotifsRead() {
  const unreadIds = notifications.filter(n => !n.is_read).map(n => n.id);
  if (!unreadIds.length) return;
  try {
    await sb('notifications', 'PATCH', { is_read: true }, `?id=in.(${unreadIds.join(',')})`);
    notifications.forEach(n => n.is_read = true);
    updateNotifBadge();
  } catch { /* ignore */ }
}

function closeNotifPanel() {
  const panel = document.getElementById('notifPanel');
  if (panel) panel.style.display = 'none';
}

function toggleNotifPanel() {
  if (!requireLogin()) return;
  const panel = document.getElementById('notifPanel');
  const opening = panel.style.display === 'none' || !panel.style.display;
  panel.style.display = opening ? 'block' : 'none';
  if (opening) {
    renderNotifPanel();
    markAllNotifsRead();
  }
}

document.addEventListener('click', (e) => {
  const panel = document.getElementById('notifPanel');
  const bell = document.getElementById('notifBell');
  if (panel && panel.style.display === 'block' && !panel.contains(e.target) && !bell.contains(e.target)) {
    panel.style.display = 'none';
  }
});

// ── PUBLIC USER PROFILE ───────────────────────────────────────
let currentViewedUserId = null;

async function viewUserProfile(userId) {
  if (userId === USER_ID) { showPage('profile'); return; }
  currentViewedUserId = userId;
  const cur = document.querySelector('.page.active');
  prevPage = cur ? cur.id.replace('page-', '') : 'home';
  showPage('userprofile', true);

  document.getElementById('upName').textContent = 'Loading...';
  document.getElementById('upAv').innerHTML = '?';
  document.getElementById('upFavAlbums').innerHTML = '<div class="loader"><div class="spinner"></div> loading...</div>';
  document.getElementById('upFeed').innerHTML = '<div class="loader"><div class="spinner"></div> loading...</div>';

  try {
    const profRows = await sb('profiles', 'GET', null, `?user_id=eq.${userId}&select=*`);
    const prof = profRows?.[0];
    if (!prof) {
      document.getElementById('upName').textContent = 'User not found';
      return;
    }
    document.getElementById('upName').textContent = prof.username;
    document.getElementById('upAv').innerHTML = avatarHtml(prof.avatar_url, prof.username);

    const followBtn = document.getElementById('upFollowBtn');
    if (currentUser) {
      await loadMyFollowing();
      const following = myFollowing.has(userId);
      followBtn.style.display = 'inline-flex';
      followBtn.textContent = following ? 'Following' : 'Follow';
      followBtn.className = 'btn-save' + (following ? ' saved' : '');
      followBtn.onclick = () => toggleFollow(userId, followBtn);
    } else {
      followBtn.style.display = 'inline-flex';
      followBtn.textContent = 'Follow';
      followBtn.onclick = () => requireLogin();
    }

    const [ratings, reviews, followingRows, followersRows, favAlbums] = await Promise.all([
      sb('ratings', 'GET', null, `?user_id=eq.${userId}&order=created_at.desc`),
      sb('reviews', 'GET', null, `?user_id=eq.${userId}&order=created_at.desc`),
      sb('follows', 'GET', null, `?follower_id=eq.${userId}&select=following_id`),
      sb('follows', 'GET', null, `?following_id=eq.${userId}&select=follower_id`),
      sb('favorite_albums', 'GET', null, `?user_id=eq.${userId}&order=created_at.desc`)
    ]);
    document.getElementById('upRated').textContent = ratings?.length || 0;
    document.getElementById('upReviewed').textContent = reviews?.length || 0;
    document.getElementById('upFollowing').textContent = followingRows?.length || 0;
    document.getElementById('upFollowers').textContent = followersRows?.length || 0;

    document.getElementById('upFavAlbums').innerHTML = favAlbums?.length
      ? `<div class="album-grid">${favAlbums.map(a => `
          <div class="album-card" onclick="openDetail('${esc(a.mbid)}','${esc(a.album_title)}','${esc(a.artist)}','—','${esc(a.cover_url || '')}')">
            ${coverEl(a.cover_url, '🎵', 'album-cover')}
            <div class="album-info"><div class="album-title">${a.album_title}</div><div class="album-artist">${a.artist}</div></div>
          </div>`).join('')}</div>`
      : '<div class="empty"><i class="ti ti-heart"></i><p>No favorite albums yet.</p></div>';

    const items = [
      ...(ratings || []).map(r => ({ ...r, kind: 'rating' })),
      ...(reviews || []).map(r => ({ ...r, kind: 'review' }))
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 20);

    document.getElementById('upFeed').innerHTML = items.length
      ? items.map(it => `
          <div class="activity-item" style="cursor:pointer;" onclick="openDetail('${esc(it.mbid)}','${esc(it.album_title)}','${esc(it.artist)}','—','${esc(it.cover_url || '')}')">
            <div class="act-img">${coverEl(it.cover_url, '🎵', 'act-img')}</div>
            <div class="act-body">
              <div class="act-title">${it.kind === 'rating' ? `Rated ⭐ ${it.stars} for` : 'Wrote a review for'} <i>${it.album_title}</i></div>
              <div class="act-sub">${it.kind === 'review' ? esc(it.review_text).slice(0, 100) : ''}</div>
            </div>
          </div>`).join('')
      : '<div class="empty"><i class="ti ti-mood-empty"></i><p>No activity yet.</p></div>';
  } catch {
    document.getElementById('upName').textContent = 'Failed to load profile';
  }
}

async function openFollowList(userId, kind) {
  if (!userId) return;
  document.getElementById('followListTitle').textContent = kind === 'following' ? 'Following' : 'Followers';
  document.getElementById('followListBody').innerHTML = '<div class="loader"><div class="spinner"></div> loading...</div>';
  document.getElementById('followListModal').style.display = 'flex';
  try {
    const qs = kind === 'following'
      ? `?follower_id=eq.${userId}&select=following_id`
      : `?following_id=eq.${userId}&select=follower_id`;
    const rows = await sb('follows', 'GET', null, qs);
    const ids = (rows || []).map(r => kind === 'following' ? r.following_id : r.follower_id);
    if (!ids.length) {
      document.getElementById('followListBody').innerHTML = '<div class="empty" style="padding:1.5rem;"><p>No users yet.</p></div>';
      return;
    }
    const profiles = await sb('profiles', 'GET', null, `?user_id=in.(${ids.join(',')})&select=user_id,username,avatar_url`);
    document.getElementById('followListBody').innerHTML = (profiles || []).map(p => `
      <div class="trend-item" onclick="closeFollowList(); viewUserProfile('${esc(p.user_id)}')">
        <div class="trend-cover-ph">${avatarHtml(p.avatar_url, p.username)}</div>
        <div class="trend-info"><div class="trend-title">${p.username}</div></div>
      </div>`).join('');
  } catch {
    document.getElementById('followListBody').innerHTML = '<div class="empty" style="padding:1.5rem;"><p>Failed to load.</p></div>';
  }
}

function closeFollowList() {
  document.getElementById('followListModal').style.display = 'none';
}

// ── FRIENDS (follow) ──────────────────────────────────────────
async function loadMyFollowing() {
  if (!USER_ID) return;
  try {
    const rows = await sb('follows', 'GET', null, `?follower_id=eq.${USER_ID}&select=following_id`);
    myFollowing = new Set((rows || []).map(r => r.following_id));
  } catch { /* ignore */ }
}

async function searchFriends() {
  if (!requireLogin()) return;
  const q = document.getElementById('friendSearchInput').value.trim();
  if (!q) return;
  const el = document.getElementById('friendSearchResults');
  el.innerHTML = '<div class="loader"><div class="spinner"></div> searching...</div>';
  try {
    const rows = await sb('profiles', 'GET', null,
      `?username=ilike.*${encodeURIComponent(q)}*&select=user_id,username,avatar_url&limit=10`);
    const results = (rows || []).filter(r => r.user_id !== USER_ID);
    if (!results.length) {
      el.innerHTML = '<div class="empty"><i class="ti ti-user-off"></i><p>User not found.</p></div>';
      return;
    }
    el.innerHTML = results.map(r => {
      const following = myFollowing.has(r.user_id);
      return `
      <div class="trend-item" style="cursor:pointer;" onclick="viewUserProfile('${esc(r.user_id)}')">
        <div class="trend-cover-ph">${avatarHtml(r.avatar_url, r.username)}</div>
        <div class="trend-info">
          <div class="trend-title">${r.username}</div>
        </div>
        <button class="btn-save${following ? ' saved' : ''}" onclick="event.stopPropagation(); toggleFollow('${esc(r.user_id)}', this)">
          ${following ? 'Following' : 'Follow'}
        </button>
      </div>`;
    }).join('');
  } catch {
    el.innerHTML = '<div class="empty"><i class="ti ti-wifi-off"></i><p>Search failed.</p></div>';
  }
}

async function toggleFollow(targetId, btn) {
  if (!requireLogin()) return;
  try {
    if (myFollowing.has(targetId)) {
      await sb('follows', 'DELETE', null, `?follower_id=eq.${USER_ID}&following_id=eq.${targetId}`);
      myFollowing.delete(targetId);
      if (btn) { btn.textContent = 'Follow'; btn.classList.remove('saved'); }
      toast('Berhenti follow');
    } else {
      await sb('follows', 'POST', { follower_id: USER_ID, following_id: targetId });
      myFollowing.add(targetId);
      try {
        await sb('notifications', 'POST', { user_id: targetId, actor_id: USER_ID, type: 'follow' });
      } catch { /* non-critical */ }
      if (btn) { btn.textContent = 'Following'; btn.classList.add('saved'); }
      toast('Followed successfully ✓');
    }
  } catch {
    toast('Failed to update follow status');
  }
}

async function loadFriendsFeed() {
  const el = document.getElementById('friendsFeed');
  if (!currentUser) {
    el.innerHTML = '<div class="empty"><i class="ti ti-login"></i><p>Log in first to see your friends\' activity.</p></div>';
    return;
  }
  el.innerHTML = '<div class="loader"><div class="spinner"></div> load...</div>';
  await loadMyFollowing();
  const ids = [...myFollowing];
  if (!ids.length) {
    el.innerHTML = '<div class="empty"><i class="ti ti-users"></i><p>Not following anyone yet. Search a username above.</p></div>';
    return;
  }
  try {
    const idList = ids.join(',');
    const [ratings, reviews, profiles] = await Promise.all([
      sb('ratings', 'GET', null, `?user_id=in.(${idList})&order=created_at.desc&limit=30`),
      sb('reviews', 'GET', null, `?user_id=in.(${idList})&order=created_at.desc&limit=30`),
      sb('profiles', 'GET', null, `?user_id=in.(${idList})&select=user_id,username,avatar_url`)
    ]);
    const pMap = {};
    (profiles || []).forEach(p => pMap[p.user_id] = p);

    const items = [
      ...(ratings || []).map(r => ({ ...r, kind: 'rating' })),
      ...(reviews || []).map(r => ({ ...r, kind: 'review' }))
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 30);

    if (!items.length) {
      el.innerHTML = '<div class="empty"><i class="ti ti-mood-empty"></i><p>Your friends have no activity yet.</p></div>';
      return;
    }
    el.innerHTML = items.map(it => {
      const p = pMap[it.user_id] || { username: 'user' };
      const sub = it.kind === 'rating'
        ? `Rated ⭐ ${it.stars} for`
        : `Wrote a review for`;
      return `
      <div class="activity-item" style="cursor:pointer;" onclick="openDetail('${esc(it.mbid)}','${esc(it.album_title)}','${esc(it.artist)}','—','${esc(it.cover_url || '')}')">
        <div class="act-img">${coverEl(it.cover_url, '🎵', 'act-img')}</div>
        <div class="act-body">
          <div class="act-title"><b style="cursor:pointer;" onclick="event.stopPropagation(); viewUserProfile('${esc(it.user_id)}')">${p.username}</b> ${sub} <i>${it.album_title}</i></div>
          <div class="act-sub">${it.kind === 'review' ? esc(it.review_text).slice(0, 100) : ''}</div>
        </div>
      </div>`;
    }).join('');
  } catch {
    el.innerHTML = '<div class="empty"><i class="ti ti-wifi-off"></i><p>Failed to load activity.</p></div>';
  }
}

async function loadTracklist(mbid) {
  const el = document.getElementById('dTracklist');
  try {
    const r = await fetch(`${MB}/release/${mbid}?inc=recordings+labels+artist-credits+genres&fmt=json`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Albumly/1.0' }
    });
    const d = await r.json();

    // ── Extra metadata pills ──
    const pills = [];
    if (d.date) pills.push(d.date);
    if (d.country) pills.push(d.country);
    (d['label-info'] || []).forEach(li => {
      const label = li.label?.name;
      const cat = li['catalog-number'];
      if (label) pills.push(cat ? `${label} · ${cat}` : label);
    });
    (d.genres || []).slice(0, 4).forEach(g => pills.push(`#${g.name}`));
    const dMeta = document.getElementById('dMeta');
    if (pills.length) {
      dMeta.innerHTML = pills.map(p => `<span class="pill">${p}</span>`).join('');
    }

    // ── Full artist credit (featuring, etc) ──
    const credit = (d['artist-credit'] || [])
      .map(c => (c.name || c.artist?.name || '') + (c.joinphrase || ''))
      .join('');
    if (credit) document.getElementById('dArtist').textContent = credit;

    // ── Tracklist ──
    currentTracks = d.media?.flatMap(m => m.tracks || []) || [];
    if (!currentTracks.length) {
      el.innerHTML = '<div class="empty"><i class="ti ti-playlist-x"></i><p>Tracklist not available.</p></div>';
      return;
    }
    await loadTrackRatings(mbid);
    openTrackNum = null;
    renderTracklist();
  } catch {
    el.innerHTML = '<div class="empty"><i class="ti ti-wifi-off"></i><p>Failed to load tracklist.</p></div>';
  }
}

// ── PER-TRACK RATINGS ─────────────────────────────────────────
const TRACK_CATEGORIES = ['perfect', 'amazing', 'great', 'good', 'meh', 'bad', 'awful'];
const TRACK_CATEGORY_LABELS = {
  perfect: 'Perfect', amazing: 'Amazing', great: 'Great', good: 'Good',
  meh: 'Meh', bad: 'Bad', awful: 'Awful'
};

let currentTracks = [];
let allTrackRatings = {};
let trackViewers = [];
let viewingUserId = null;
let openTrackNum = null;

async function loadTrackRatings(mbid) {
  allTrackRatings = {};
  trackViewers = [];
  viewingUserId = USER_ID || null;
  try {
    const rows = await sb('track_ratings', 'GET', null, `?mbid=eq.${mbid}&select=user_id,track_number,category`);
    const userIds = new Set();
    (rows || []).forEach(r => {
      if (!allTrackRatings[r.user_id]) allTrackRatings[r.user_id] = {};
      allTrackRatings[r.user_id][r.track_number] = r.category;
      userIds.add(r.user_id);
    });
    if (userIds.size) {
      const idList = [...userIds].join(',');
      trackViewers = await sb('profiles', 'GET', null, `?user_id=in.(${idList})&select=user_id,username`);
    }
  } catch { /* ignore, tracklist still works without colors */ }
}

function trackClassFor(num) {
  const cat = viewingUserId && allTrackRatings[viewingUserId] ? allTrackRatings[viewingUserId][num] : null;
  return cat ? `track-${cat}` : '';
}

function renderTracklist() {
  const el = document.getElementById('dTracklist');
  const others = (trackViewers || []).filter(v => v.user_id !== USER_ID);
  const viewerSelectHtml = (currentUser && others.length)
    ? `<div style="margin-bottom:10px;font-size:12px;color:var(--text2);">
        Viewing colors from:
        <select onchange="switchTrackViewer(this.value)" style="background:var(--bg2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:3px 6px;font-size:12px;">
          <option value="${USER_ID}">Me</option>
          ${others.map(v => `<option value="${esc(v.user_id)}" ${viewingUserId === v.user_id ? 'selected' : ''}>${v.username}</option>`).join('')}
        </select>
      </div>`
    : '';

  el.innerHTML = viewerSelectHtml + currentTracks.map(t => {
    const num = t.number || t.position;
    const cls = trackClassFor(num);
    const isOpen = openTrackNum === num;
    return `
      <div class="track-item" style="flex-direction:column;align-items:stretch;cursor:pointer;" onclick="toggleTrackMenu('${esc(num)}')">
        <div style="display:flex;align-items:center;gap:12px;">
          <span class="track-num">${num}</span>
          <span class="track-title ${cls}">${t.title}</span>
          <span class="track-dur">${fmtDuration(t.length)}</span>
        </div>
        ${isOpen ? `
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;padding-left:32px;" onclick="event.stopPropagation()">
          ${TRACK_CATEGORIES.map(c => `<button class="genre-chip track-${c}" onclick="setTrackCategory('${esc(num)}','${c}','${esc(t.title)}')">${TRACK_CATEGORY_LABELS[c]}</button>`).join('')}
          ${cls ? `<button class="genre-chip" onclick="clearTrackCategory('${esc(num)}')">Clear</button>` : ''}
        </div>` : ''}
      </div>`;
  }).join('');
}

function toggleTrackMenu(num) {
  if (!requireLogin()) return;
  openTrackNum = (openTrackNum === num) ? null : num;
  renderTracklist();
}

async function setTrackCategory(num, category, title) {
  try {
    await sb('track_ratings', 'POST',
      { user_id: USER_ID, mbid: currentAlbum.mbid, track_number: num, track_title: title, category },
      '?on_conflict=user_id,mbid,track_number'
    );
    if (!allTrackRatings[USER_ID]) allTrackRatings[USER_ID] = {};
    allTrackRatings[USER_ID][num] = category;
    viewingUserId = USER_ID;
    openTrackNum = null;
    renderTracklist();
    toast('Track rated ✓');
  } catch {
    toast('Failed to save track rating');
  }
}

async function clearTrackCategory(num) {
  try {
    await sb('track_ratings', 'DELETE', null,
      `?user_id=eq.${USER_ID}&mbid=eq.${currentAlbum.mbid}&track_number=eq.${encodeURIComponent(num)}`);
    if (allTrackRatings[USER_ID]) delete allTrackRatings[USER_ID][num];
    openTrackNum = null;
    renderTracklist();
    toast('Track rating cleared');
  } catch {
    toast('Failed to clear rating');
  }
}

function switchTrackViewer(userId) {
  viewingUserId = userId;
  openTrackNum = null;
  renderTracklist();
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
  document.getElementById('dRatingSub').textContent = 'loading...';
  document.getElementById('reviewsList').innerHTML =
    '<div class="loader"><div class="spinner"></div> loading reviews...</div>';
  document.getElementById('dTracklist').innerHTML =
    '<div class="loader"><div class="spinner"></div> loading tracklist...</div>';
  loadTracklist(mbid);

  const saved = mySaved.has(mbid);
  document.getElementById('saveBtn').className = 'btn-save' + (saved ? ' saved' : '');
  document.getElementById('saveText').textContent = saved ? 'saved' : 'save';

  const isFav = myFavAlbums.has(mbid);
  document.getElementById('favBtn').className = 'btn-save' + (isFav ? ' saved' : '');
  document.getElementById('favText').textContent = isFav ? 'favorite ♥' : 'favorite';

  showPage('detail', true);

  // Build star picker (half-star capable)
  const myS = myRatings[mbid] || 0;
  document.getElementById('starRow').innerHTML = [1, 2, 3, 4, 5].map(i => `
    <button class="star-btn" style="position:relative;width:24px;height:24px;padding:0;"
      onclick="handleStarClick(event,'${esc(mbid)}',${i})"
      onmousemove="hoverStarMove(event,${i})"
      onmouseleave="resetS('${esc(mbid)}')">
      <span style="position:absolute;inset:0;color:var(--text3);">★</span>
      <span class="star-fg" data-idx="${i}" style="position:absolute;inset:0;width:${starFillPct(myS, i)}%;overflow:hidden;color:#f59e0b;white-space:nowrap;">★</span>
    </button>`).join('');

  // Load DB data
  const [ratingRows, reviewRows] = await Promise.all([
    sb('ratings', 'GET', null, `?mbid=eq.${mbid}&select=stars`),
    sb('reviews', 'GET', null, `?mbid=eq.${mbid}&order=created_at.desc`)
  ]);

  if (ratingRows?.length) {
    const avg = (ratingRows.reduce((s, r) => s + r.stars, 0) / ratingRows.length).toFixed(1);
    document.getElementById('dRating').textContent = avg;
    document.getElementById('dStars').innerHTML = starsHtml(parseFloat(avg), 16);
    document.getElementById('dRatingSub').textContent = `average of ${ratingRows.length} ratings`;
  } else {
    document.getElementById('dRating').textContent = '—';
    document.getElementById('dStars').textContent = '';
    document.getElementById('dRatingSub').textContent = 'no ratings yet';
  }

  renderReviews(reviewRows || []);
}

function handleStarClick(event, mbid, idx) {
  if (!requireLogin()) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const frac = (event.clientX - rect.left) / rect.width;
  const value = frac < 0.5 ? idx - 0.5 : idx;
  doRate(mbid, value);
}

function hoverStarMove(event, idx) {
  const rect = event.currentTarget.getBoundingClientRect();
  const frac = (event.clientX - rect.left) / rect.width;
  const hoverVal = frac < 0.5 ? idx - 0.5 : idx;
  document.querySelectorAll('#starRow .star-fg').forEach(el => {
    el.style.width = starFillPct(hoverVal, parseInt(el.dataset.idx)) + '%';
  });
}
function resetS(mbid) {
  const u = myRatings[mbid] || 0;
  document.querySelectorAll('#starRow .star-fg').forEach(el => {
    el.style.width = starFillPct(u, parseInt(el.dataset.idx)) + '%';
  });
}

async function doRate(mbid, stars) {
  if (!requireLogin()) return;
  myRatings[mbid] = stars;
  resetS(mbid);
  const a = currentAlbum;
  try {
    await sb('ratings', 'POST',
      { user_id: USER_ID, user_name: myProfile.username, mbid, stars, album_title: a.title, artist: a.artist, cover_url: a.coverUrl || null },
      '?on_conflict=user_id,mbid'
    );
    toast(`⭐ Rating of ${stars} stars saved`);
    const rows = await sb('ratings', 'GET', null, `?mbid=eq.${mbid}&select=stars`);
    if (rows?.length) {
      const avg = (rows.reduce((s, r) => s + r.stars, 0) / rows.length).toFixed(1);
      document.getElementById('dRating').textContent = avg;
      document.getElementById('dStars').innerHTML = starsHtml(parseFloat(avg), 16);
      document.getElementById('dRatingSub').textContent = `average of ${rows.length} ratings`;
    }
  } catch {
    toast('Failed to save rating');
  }
}

async function toggleFavAlbum() {
  if (!currentAlbum) return;
  if (!requireLogin()) return;
  const { mbid, title, artist, coverUrl } = currentAlbum;
  try {
    if (myFavAlbums.has(mbid)) {
      await sb('favorite_albums', 'DELETE', null, `?user_id=eq.${USER_ID}&mbid=eq.${mbid}`);
      myFavAlbums.delete(mbid);
      document.getElementById('favBtn').className = 'btn-save';
      document.getElementById('favText').textContent = 'favorite';
      toast('Removed from favorites');
    } else {
      if (myFavAlbums.size >= 6) {
        toast('Maximum of 6 favorite albums. Remove one first.');
        return;
      }
      await sb('favorite_albums', 'POST',
        { user_id: USER_ID, mbid, album_title: title, artist, cover_url: coverUrl || null },
        '?on_conflict=user_id,mbid'
      );
      myFavAlbums.add(mbid);
      document.getElementById('favBtn').className = 'btn-save saved';
      document.getElementById('favText').textContent = 'favorite ♥';
      toast('Added to favorites ✓');
    }
  } catch {
    toast('Failed to save favorite');
  }
}

// ── FAVORITE ARTISTS ──────────────────────────────────────────
async function mbArtistSearch(q, limit = 8) {
  const r = await fetch(
    `${MB}/artist/?query=${encodeURIComponent(q)}&limit=${limit}&fmt=json`,
    { headers: { 'Accept': 'application/json', 'User-Agent': 'Albumly/1.0' } }
  );
  const d = await r.json();
  return (d.artists || []).map(a => ({ mbid: a.id, name: a.name, country: a.country || '' }));
}

async function searchFavArtist() {
  if (!requireLogin()) return;
  const q = document.getElementById('favArtistInput').value.trim();
  if (!q) return;
  const el = document.getElementById('favArtistResults');
  el.innerHTML = '<div class="loader"><div class="spinner"></div> searching...</div>';
  try {
    const artists = await mbArtistSearch(q);
    if (!artists.length) {
      el.innerHTML = '<div class="empty"><i class="ti ti-user-off"></i><p>Artist not found.</p></div>';
      return;
    }
    el.innerHTML = artists.map(a => `
      <div class="trend-item" onclick="addFavArtist('${esc(a.mbid)}','${esc(a.name)}')">
        <div class="trend-cover-ph">🎤</div>
        <div class="trend-info">
          <div class="trend-title">${a.name}</div>
          <div class="trend-artist">${a.country || ''}</div>
        </div>
      </div>`).join('');
  } catch {
    el.innerHTML = '<div class="empty"><i class="ti ti-wifi-off"></i><p>Search failed.</p></div>';
  }
}

async function addFavArtist(mbid, name) {
  try {
    await sb('favorite_artists', 'POST',
      { user_id: USER_ID, artist_mbid: mbid, artist_name: name },
      '?on_conflict=user_id,artist_name'
    );
    document.getElementById('favArtistResults').innerHTML = '';
    document.getElementById('favArtistInput').value = '';
    toast(`${name} added to favorite artists ✓`);
    await renderFavArtists();
  } catch {
    toast('Failed to add artist');
  }
}

async function removeFavArtist(name) {
  try {
    await sb('favorite_artists', 'DELETE', null, `?user_id=eq.${USER_ID}&artist_name=eq.${encodeURIComponent(name)}`);
    toast(`${name} removed from favorites`);
    await renderFavArtists();
  } catch {
    toast('Failed to remove artist');
  }
}

async function renderFavArtists() {
  const el = document.getElementById('favArtistChips');
  if (!el) return;
  try {
    const rows = await sb('favorite_artists', 'GET', null, `?user_id=eq.${USER_ID}&order=created_at.desc`);
    if (!rows?.length) {
      el.innerHTML = '<span style="font-size:12px;color:var(--text3);">No favorite artists yet.</span>';
      return;
    }
    el.innerHTML = rows.map(r => `
      <button class="genre-chip active" onclick="removeFavArtist('${esc(r.artist_name)}')">${r.artist_name} ✕</button>
    `).join('');
  } catch {
    el.innerHTML = '';
  }
}

async function renderFavAlbums() {
  const el = document.getElementById('favAlbumsGrid');
  if (!el) return;
  try {
    const rows = await sb('favorite_albums', 'GET', null, `?user_id=eq.${USER_ID}&order=created_at.desc`);
    if (!rows?.length) {
      el.innerHTML = '<div class="empty"><i class="ti ti-heart"></i><p>No favorite albums yet. Open an album detail page and tap the favorite button.</p></div>';
      return;
    }
    el.innerHTML = `<div class="album-grid">${rows.map(a => `
      <div class="album-card" onclick="openDetail('${esc(a.mbid)}','${esc(a.album_title)}','${esc(a.artist)}','—','${esc(a.cover_url || '')}')">
        ${coverEl(a.cover_url, '🎵', 'album-cover')}
        <div class="album-info">
          <div class="album-title">${a.album_title}</div>
          <div class="album-artist">${a.artist}</div>
        </div>
      </div>`).join('')}</div>`;
  } catch {
    el.innerHTML = '<div class="empty"><i class="ti ti-wifi-off"></i><p>Failed to load.</p></div>';
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
      document.getElementById('saveText').textContent = 'save';
      toast('Removed from saved');
    } else {
      await sb('saved_albums', 'POST',
        { user_id: USER_ID, user_name: myProfile.username, mbid, album_title: title, artist, cover_url: coverUrl || null },
        '?on_conflict=user_id,mbid'
      );
      mySaved.add(mbid);
      document.getElementById('saveBtn').className = 'btn-save saved';
      document.getElementById('saveText').textContent = 'saved';
      toast('Album saved ✓');
    }
  } catch {
    toast('Failed to save');
  }
}

function renderReviews(list) {
  const el = document.getElementById('reviewsList');
  if (!list.length) {
    el.innerHTML = '<div class="empty"><i class="ti ti-message-circle"></i><p>No reviews yet. Be the first!</p></div>';
    return;
  }
  el.innerHTML = list.map(r => `
    <div class="review-card">
      <div class="review-top">
        <div class="rev-av">${(r.user_name || r.user_id || '?').slice(0, 2).toUpperCase()}</div>
        <div>
          <div class="rev-name" style="cursor:pointer;" onclick="viewUserProfile('${esc(r.user_id)}')">${r.user_name || r.user_id}</div>
          <div class="rev-date">${new Date(r.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
        </div>
        ${r.stars ? `<div class="rev-stars">${starsHtml(r.stars, 12)}</div>` : ''}
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
      user_name: myProfile.username,
      mbid: currentAlbum.mbid,
      review_text: txt,
      stars: myRatings[currentAlbum.mbid] || 0,
      album_title: currentAlbum.title,
      artist: currentAlbum.artist
    });
    document.getElementById('reviewTxt').value = '';
    toast('Review submitted ✓');
    const rows = await sb('reviews', 'GET', null, `?mbid=eq.${currentAlbum.mbid}&order=created_at.desc`);
    renderReviews(rows || []);
  } catch {
    toast('Failed to submit review');
  }
  btn.disabled = false;
  btn.textContent = 'Kirim Review';
}

// ── PROFILE ───────────────────────────────────────────────────
function renderProfileInfo() {
  const pic = myProfile?.avatar_url;
  const name = myProfile?.username || '—';
  document.getElementById('profileName').textContent = name;
  document.getElementById('profileBio').textContent = '';
  document.getElementById('profileAv').innerHTML = avatarHtml(pic, name);
  document.getElementById('writeAv').innerHTML = avatarHtml(pic, name);
  document.getElementById('writeName').textContent = name;
  const editInput = document.getElementById('editUsername');
  if (editInput) editInput.value = name;
  const visInput = document.getElementById('editTrackVisibility');
  if (visInput) visInput.value = myProfile?.track_rating_visibility || 'public';
}

async function loadProfile() {
  if (!currentUser) {
    document.getElementById('profileFeed').innerHTML =
      '<div class="empty"><i class="ti ti-login"></i><p>Log in first to see your profile.</p><button class="btn-primary" style="margin-top:10px;" onclick="loginWithGoogle()">Login with Google</button></div>';
    document.getElementById('profileName').textContent = 'Not logged in';
    document.getElementById('profileBio').textContent = '';
    document.getElementById('myRated').textContent = '—';
    document.getElementById('myReviewed').textContent = '—';
    document.getElementById('mySaved').textContent = '—';
    document.getElementById('myFollowing').textContent = '—';
    document.getElementById('myFollowers').textContent = '—';
    return;
  }

  renderProfileInfo();
  renderFavAlbums();
  renderFavArtists();

  try {
    const [ratings, reviews, saved, following, followers] = await Promise.all([
      sb('ratings', 'GET', null, `?user_id=eq.${USER_ID}&order=created_at.desc`),
      sb('reviews', 'GET', null, `?user_id=eq.${USER_ID}&order=created_at.desc`),
      sb('saved_albums', 'GET', null, `?user_id=eq.${USER_ID}&order=created_at.desc`),
      sb('follows', 'GET', null, `?follower_id=eq.${USER_ID}&select=following_id`),
      sb('follows', 'GET', null, `?following_id=eq.${USER_ID}&select=follower_id`)
    ]);
    document.getElementById('myRated').textContent    = ratings?.length || 0;
    document.getElementById('myReviewed').textContent = reviews?.length || 0;
    document.getElementById('mySaved').textContent    = saved?.length   || 0;
    document.getElementById('myFollowing').textContent = following?.length || 0;
    document.getElementById('myFollowers').textContent = followers?.length || 0;

    const activities = [
      ...(ratings || []).map(r => ({ cover: r.cover_url,  title: r.album_title, sub: `Rating ⭐ ${r.stars} stars`,          date: r.created_at })),
      ...(reviews || []).map(r => ({ cover: null,          title: r.album_title, sub: r.review_text.slice(0, 70) + (r.review_text.length > 70 ? '...' : ''), date: r.created_at })),
      ...(saved   || []).map(r => ({ cover: r.cover_url,  title: r.album_title, sub: 'Saved to collection',                   date: r.created_at })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 20);

    const el = document.getElementById('profileFeed');
    if (!activities.length) {
      el.innerHTML = '<div class="empty"><i class="ti ti-history"></i><p>No activity yet.</p></div>';
      return;
    }
    el.innerHTML =
      `<div class="section-header" style="margin-bottom:12px;"><span class="section-title">recent activity</span></div>` +
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
      '<div class="empty"><i class="ti ti-wifi-off"></i><p>Failed to load profile.</p></div>';
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
  if (name !== 'detail' && name !== 'userprofile') {
    history.replaceState(null, '', '#' + name);
  }
  if (name === 'trending') loadTrending();
  if (name === 'profile')  loadProfile();
  if (name === 'friends')  loadFriendsFeed();
}

// ── INIT ──────────────────────────────────────────────────────
renderGenreChips('Semua');
renderGenreCards();

const VALID_PAGES = ['home', 'search', 'trending', 'genres', 'profile', 'friends'];

(async function initApp() {
  await initAuth();
  loadHome();
  const startHash = location.hash.replace('#', '');
  if (VALID_PAGES.includes(startHash) && startHash !== 'home') {
    showPage(startHash);
  }
})();

setInterval(() => { if (USER_ID) loadNotifications(); }, 30000);