/**
 * Photo Organizer - iOS/Web PWA  v2.1
 * Photos + Videos, project-based organization, ZIP export
 * 
 * v2.1: Batch import, audio wake lock, deferred video sizing
 */

// ===================== STATE =====================
const state = {
  photos: [], selected: new Set(), cameras: [], projects: [],
  primary: 'date', secondary: 'camera', projectName: '', step: 'select',
  nextId: 0, audioWakeLock: null,
};

const PRESETS = {
  default: { name: 'Project + Date + Camera', primary: 'date', secondary: 'camera' },
  date_only: { name: 'Date Only', primary: 'date', secondary: 'none' },
  camera_first: { name: 'Camera First', primary: 'camera', secondary: 'date' },
  flat: { name: 'Flat Project', primary: 'none', secondary: 'none' },
};

const IMAGE_RE = /\.(jpe?g|png|tiff?|bmp|webp|dng|raf|cr2|cr3|nef|arw|orf|rw2|raw|heic|heif)$/i;
const VIDEO_RE = /\.(mp4|mov|m4v|avi|mkv|wmv|flv|webm|mts|m2ts|3gp)$/i;
const DB_NAME = 'PhotoOrgDB';
const DB_STORE = 'projects';

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// ===================== INIT =====================
function init() {
  loadState();
  setupTabs();
  setupFileInput();
  setupAddMoreButton();
  setupGroupingControls();
  setupPresets();
  renderDashboard();
  renderProjectHistory();
  updatePresetBadge();
}

// ===================== AUDIO WAKE LOCK (works on ALL iOS) =====================
function startAudioWakeLock() {
  if (state.audioWakeLock) return;
  try {
    const audio = document.createElement('audio');
    audio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
    audio.loop = true;
    audio.play().then(() => {
      state.audioWakeLock = audio;
    }).catch(() => {});
  } catch (e) {}
}

function stopAudioWakeLock() {
  if (state.audioWakeLock) {
    state.audioWakeLock.pause();
    state.audioWakeLock = null;
  }
}

function keepScreenActive() {
  startAudioWakeLock();
  if ('wakeLock' in navigator) {
    try { navigator.wakeLock.request('screen').catch(() => {}); } catch (e) {}
  }
}

// ===================== TABS =====================
function setupTabs() {
  $$('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.nav-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const name = tab.dataset.tab;
      ['import', 'dashboard', 'settings'].forEach(t => {
        $(`#tab-${t}`).classList.toggle('hidden', t !== name);
      });
      if (name === 'dashboard') { renderDashboard(); renderProjectHistory(); }
      $('#bottomBar').classList.toggle('hidden', name !== 'import' || state.step !== 'config');
    });
  });
}

// ===================== FILE INPUT =====================
function setupFileInput() {
  $('#photoInput').addEventListener('change', e => handleFiles(e.target.files, true));
}

function setupAddMoreButton() {
  const extra = document.createElement('input');
  extra.type = 'file'; extra.multiple = true;
  extra.accept = 'image/*,video/*,.dng,.raf,.cr2,.cr3,.nef,.arw,.orf,.rw2,.heic,.mp4,.mov,.m4v,.avi,.mkv';
  extra.style.display = 'none'; extra.id = 'addMoreInput';
  extra.addEventListener('change', e => handleFiles(e.target.files, false));
  document.body.appendChild(extra);
}

function triggerAddMore() {
  $('#addMoreInput').click();
}

function filterMedia(files) {
  return files.filter(f =>
    f.type.startsWith('image/') || f.type.startsWith('video/') ||
    IMAGE_RE.test(f.name) || VIDEO_RE.test(f.name)
  );
}

function isImage(f) { return f.type.startsWith('image/') || IMAGE_RE.test(f.name); }
function isVideo(f) { return f.type.startsWith('video/') || VIDEO_RE.test(f.name); }

// ===================== FAST BATCH IMPORT =====================
async function handleFiles(fileList, isNewImport) {
  const files = filterMedia(Array.from(fileList));
  if (!files.length) return;

  if (isNewImport) {
    state.photos = []; state.selected = new Set(); state.nextId = 0;
  }

  keepScreenActive();
  showToast(`${isNewImport ? 'Importing' : 'Adding'} ${files.length} files... Keep screen on`, 'info');
  showStep('process');
  updateProgress(5, 'Reading file names...');

  // PHASE 1: Instant sync metadata from filenames (NO file access)
  const startIdx = state.nextId;
  const entries = files.map((file, i) => {
    const isVid = isVideo(file);
    const meta = isVid
      ? fastVideoMeta(file.name, file.lastModified)
      : { camera: 'Loading...', cameraMake: '', lens: '', focalLength: '', aperture: '', iso: '', date: '', shutterCount: 0, serial: '', gps: '' };

    return {
      id: startIdx + i,
      file,
      name: file.name,
      type: isVid ? 'video' : 'image',
      size: '', // Will fill later
      meta,
      thumb: null,
    };
  });

  // Add to state immediately so UI shows
  state.photos.push(...entries);
  state.nextId = startIdx + files.length;
  state.selected = new Set(state.photos.map(p => p.id));

  // Show config screen immediately with filename-based data
  autoSuggestProjectName();
  showStep('config');
  renderPhotoGrid();
  updateTreePreview();
  updateSelectedCount();
  $('#bottomBar').classList.remove('hidden');

  // PHASE 2: Parallel background processing
  const images = entries.filter(e => e.type === 'image');
  const videos = entries.filter(e => e.type === 'video');

  // Process videos: just get file size (still slow on iOS but we show progress)
  await processVideosInBatches(videos);

  // Process photos: EXIF + thumbnails in parallel
  await processPhotosInBatches(images);

  stopAudioWakeLock();
  showToast(`Ready: ${state.photos.filter(p => p.type === 'image').length} photos, ${state.photos.filter(p => p.type === 'video').length} videos`, 'success');
  updateTreePreview(); // Refresh with actual dates
}

async function processVideosInBatches(videoEntries) {
  const total = videoEntries.length;
  if (!total) return;

  // Process 3 at a time to avoid iOS choking
  for (let i = 0; i < videoEntries.length; i += 3) {
    const batch = videoEntries.slice(i, i + 3);
    updateProgress(Math.round((i / total) * 100), `Loading videos ${i + 1}-${Math.min(i + 3, total)}/${total}...`);

    // Process each video in batch
    await Promise.all(batch.map(async (entry) => {
      try {
        // THIS is the slow part on iOS - getting file.size triggers OS file prep
        entry.size = fmtSize(entry.file.size);
        // Refine metadata now that we have the file
        const refined = fastVideoMeta(entry.file.name, entry.file.lastModified);
        entry.meta = refined;
      } catch (e) {
        entry.size = '??';
      }
    }));

    // Update UI after each batch
    renderPhotoGrid();
    await new Promise(r => setTimeout(r, 10));
  }
}

async function processPhotosInBatches(imageEntries) {
  const total = imageEntries.length;
  if (!total) return;

  for (let i = 0; i < imageEntries.length; i += 5) {
    const batch = imageEntries.slice(i, i + 5);
    updateProgress(Math.round((i / total) * 100), `Reading photos ${i + 1}-${Math.min(i + 5, total)}/${total}...`);

    await Promise.all(batch.map(async (entry) => {
      try {
        // Read EXIF + size in parallel
        const [meta] = await Promise.all([
          readExifSafe(entry.file),
        ]);
        entry.meta = meta;
        entry.size = fmtSize(entry.file.size);

        // Thumbnail (after EXIF, in background)
        quickThumbnail(entry.file).then(thumb => {
          entry.thumb = thumb;
          // Find the card and update it
          const cards = $$('.photo-card');
          const idx = state.photos.findIndex(p => p.id === entry.id);
          if (idx >= 0 && cards[idx]) {
            const img = cards[idx].querySelector('.photo-thumb img');
            if (img) img.src = thumb;
          }
        }).catch(() => {});
      } catch (e) {
        entry.size = fmtSize(entry.file.size);
        entry.meta = unknownMeta();
      }
    }));

    renderPhotoGrid();
    await new Promise(r => setTimeout(r, 10));
  }
  updateProgress(100, 'Done!');
}

// ===================== FAST METADATA (sync, no file access) =====================
function fastVideoMeta(filename, lastModified) {
  // Extract date from filename
  let date = extractDateFromFilename(filename);
  if (!date && lastModified) {
    const d = new Date(lastModified);
    date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  // Detect camera from filename
  const n = filename.toLowerCase();
  let camera = 'Video';
  if (n.includes('gopro')) camera = 'GoPro';
  else if (n.includes('dji')) camera = 'DJI';
  else if (n.includes('insta')) camera = 'Insta360';
  else if (n.includes('iphone')) camera = 'iPhone';
  else if (n.includes('fuji') || n.includes('xt-')) camera = 'Fujifilm';
  else if (n.includes('leica')) camera = 'Leica';
  else if (n.includes('sony')) camera = 'Sony';

  return { camera, cameraMake: '', lens: '', focalLength: '', aperture: '', iso: '', date, shutterCount: 0, serial: '', gps: '' };
}

function extractDateFromFilename(name) {
  const patterns = [
    /(20\d{2})[-_]?(\d{2})[-_]?(\d{2})/,
    /IMG_[EP]?(\d{4})(\d{2})(\d{2})_/,
    /VID_?(\d{4})(\d{2})(\d{2})/,
  ];
  for (const re of patterns) {
    const m = name.match(re);
    if (m && m[1] && parseInt(m[1]) >= 2000 && parseInt(m[1]) <= 2035) {
      return `${m[1]}-${m[2]}-${m[3]}`;
    }
  }
  return null;
}

function unknownMeta() {
  return { camera: 'Unknown', cameraMake: '', lens: '', focalLength: '', aperture: '', iso: '', date: '', shutterCount: 0, serial: '', gps: '' };
}

function extractDate(str) {
  if (!str) return '';
  const p = str.split(/[:\s]/);
  return p.length >= 3 ? `${p[0]}-${p[1]}-${p[2]}` : '';
}

// ===================== EXIF =====================
async function readExifSafe(file) {
  try {
    const buffer = await file.arrayBuffer();
    const tags = ExifReader.load(buffer);

    const make = (tags['Make']?.description || '').trim();
    const model = (tags['Model']?.description || '').trim();
    const camera = `${make} ${model}`.trim() || 'Unknown';
    const serial = tags['SerialNumber']?.description || '';
    const lens = tags['LensModel']?.description || tags['Lens']?.description || '';
    const focal = parseFloat(tags['FocalLength']?.description) || 0;
    const aperture = tags['FNumber']?.description || '';
    const iso = tags['ISOSpeedRatings']?.description || '';
    const date = extractDate(tags['DateTimeOriginal']?.description);

    let shutterCount = 0;
    for (const t of ['ImageCount','ShutterCount','TotalShutterReleases']) {
      if (tags[t]) { shutterCount = parseInt(tags[t].description) || 0; break; }
    }

    let gps = '';
    if (tags['GPSLatitude'] && tags['GPSLongitude']) {
      gps = `${tags['GPSLatitude'].description}, ${tags['GPSLongitude'].description}`;
    }

    // Track camera
    const camKey = serial || camera;
    if (camera !== 'Unknown' && !state.cameras.find(c => c.id === camKey)) {
      const makeKey = Object.keys(COLORS).find(k => make.toLowerCase().includes(k.toLowerCase()));
      const c = COLORS[makeKey] || COLORS.Sony;
      state.cameras.push({ id: camKey, model: camera, make, nickname: '', shutterCount, importedFiles: 0, color: c.gold });
    }
    const cam = state.cameras.find(c => c.id === camKey);
    if (cam) { cam.importedFiles++; if (shutterCount > cam.shutterCount) cam.shutterCount = shutterCount; }

    return { camera, cameraMake: make, lens, focalLength: focal ? `${Math.round(focal)}mm` : '', aperture: aperture ? `f/${aperture}` : '', iso, date, shutterCount, serial, gps };
  } catch (e) {
    return unknownMeta();
  }
}

const COLORS = {
  Leica: { gold: '#B8860B' }, Fujifilm: { gold: '#A07850' },
  Nikon: { gold: '#FFD700' }, Canon: { gold: '#DC143C' }, Sony: { gold: '#5C7C9C' },
};

// ===================== THUMBNAILS =====================
async function quickThumbnail(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 200; c.height = 150;
      c.getContext('2d').drawImage(img, 0, 0, 200, 150);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.5));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(); };
    img.src = url;
  });
}

// ===================== PROJECT NAME =====================
function autoSuggestProjectName() {
  const dates = state.photos.map(p => p.meta.date).filter(d => d).sort();
  const cams = [...new Set(state.photos.map(p => p.meta.camera).filter(c => c && c !== 'Unknown' && c !== 'Loading...' && c !== 'Video'))];

  if (!dates.length) {
    state.projectName = `Import ${new Date().toISOString().slice(0, 10)}`;
  } else {
    const s = dates[0], e = dates[dates.length - 1];
    let n = s === e ? s : `${s} to ${e}`;
    if (cams.length === 1) n += ` (${cams[0]})`;
    else if (cams.length > 1) n += ` (${cams.length} cameras)`;
    state.projectName = n;
  }
  $('#projectName').value = state.projectName;
}

// ===================== GROUPING =====================
function setupGroupingControls() {
  $('#primaryGroup').addEventListener('change', e => { state.primary = e.target.value; updateTreePreview(); updatePresetBadge(); });
  $('#secondaryGroup').addEventListener('change', e => { state.secondary = e.target.value; updateTreePreview(); updatePresetBadge(); });
  $('#projectName').addEventListener('input', e => { state.projectName = e.target.value; updateTreePreview(); });
  $('#defaultPrimary').addEventListener('change', e => { state.primary = e.target.value; syncSelects(); updateTreePreview(); updatePresetBadge(); saveState(); });
  $('#defaultSecondary').addEventListener('change', e => { state.secondary = e.target.value; syncSelects(); updateTreePreview(); updatePresetBadge(); saveState(); });
}
function syncSelects() { $('#primaryGroup').value = state.primary; $('#secondaryGroup').value = state.secondary; }

function updatePresetBadge() {
  let match = 'custom';
  for (const [k, p] of Object.entries(PRESETS)) { if (p.primary === state.primary && p.secondary === state.secondary) { match = k; break; } }
  const b = $('#presetBadge');
  if (match !== 'custom') { b.textContent = `Preset: ${PRESETS[match].name}`; b.style.color = 'var(--indigo)'; b.style.background = 'rgba(92,124,156,0.1)'; }
  else { b.textContent = `Custom: ${state.primary} / ${state.secondary}`; b.style.color = 'var(--text2)'; b.style.background = 'rgba(232,226,217,0.05)'; }
}

// ===================== TREE PREVIEW =====================
function updateTreePreview() {
  const sel = state.photos.filter(p => state.selected.has(p.id));
  const proj = state.projectName || 'Project';
  const lines = [`<span class="folder">${esc(proj)}/</span>`];

  if (state.primary === 'date') {
    const dates = [...new Set(sel.map(p => p.meta.date).filter(d => d))].sort();
    for (const date of dates) {
      lines.push(`  <span class="indent">&#9492;&#9472;</span> <span class="folder">${date}/</span>`);
      const day = sel.filter(p => p.meta.date === date);
      if (state.secondary === 'camera') {
        const cams = [...new Set(day.map(p => p.meta.camera))];
        cams.forEach((cam, ci) => {
          const last = ci === cams.length - 1;
          lines.push(`      <span class="indent">${last?'&#9492;':'&#9500;'}&#9472;</span> <span class="folder">${esc(cam)}/</span>`);
          day.filter(p => p.meta.camera === cam).slice(0, 2).forEach(f =>
            lines.push(`          <span class="indent">&#9500;&#9472;</span> <span class="file">${esc(f.name)}</span>`));
          const m = day.filter(p => p.meta.camera === cam).length - 2;
          if (m > 0) lines.push(`          <span class="indent">&#9492;&#9472;</span> <span class="file">+${m} more</span>`);
        });
      } else {
        day.slice(0, 3).forEach(f => lines.push(`      <span class="indent">&#9500;&#9472;</span> <span class="file">${esc(f.name)}</span>`));
        if (day.length > 3) lines.push(`      <span class="indent">&#9492;&#9472;</span> <span class="file">+${day.length - 3} more</span>`);
      }
    }
  } else {
    sel.slice(0, 10).forEach(f => lines.push(`  <span class="indent">&#9500;&#9472;</span> <span class="file">${esc(f.name)}</span>`));
    if (sel.length > 10) lines.push(`  <span class="indent">&#9492;&#9472;</span> <span class="file">+${sel.length - 10} more</span>`);
  }

  $('#treePreview').innerHTML = lines.join('\n');
  const imgs = sel.filter(p => p.type === 'image').length;
  const vids = sel.filter(p => p.type === 'video').length;
  const parts = [`${sel.length} files`];
  if (imgs) parts.push(`${imgs} photos`);
  if (vids) parts.push(`${vids} videos`);
  parts.push(`${[...new Set(sel.map(p => p.meta.date))].filter(d => d).length} days`);
  $('#photoCount').textContent = parts.join(' \u00b7 ');
}
function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

// ===================== PHOTO GRID =====================
function renderPhotoGrid() {
  const grid = $('#photoGrid');
  grid.innerHTML = '';

  state.photos.forEach(photo => {
    const div = document.createElement('div');
    div.className = `photo-card ${state.selected.has(photo.id) ? 'selected' : ''}`;
    div.onclick = () => togglePhoto(photo.id);

    let thumbHtml;
    if (photo.thumb) thumbHtml = `<img src="${photo.thumb}" alt="">`;
    else if (photo.type === 'video') thumbHtml = `<div class="placeholder video-placeholder">&#9654;</div>`;
    else thumbHtml = `<div class="placeholder">&#128247;</div>`;

    const videoBadge = photo.type === 'video' ? '<div class="video-badge">VIDEO</div>' : '';
    const meta = photo.type === 'video'
      ? `<div class="photo-meta" style="color:var(--moss);">${esc(photo.meta.camera)}</div><div class="photo-meta">${photo.size || '...'} \u00b7 ${photo.meta.date || 'No date'}</div>`
      : `<div class="photo-meta">${esc(photo.meta.camera)} \u00b7 ${photo.meta.focalLength} ${photo.meta.aperture}</div><div class="photo-meta">${photo.meta.date || '?'} \u00b7 ISO${photo.meta.iso}</div>`;

    div.innerHTML = `<div class="photo-thumb">${thumbHtml}${videoBadge}</div><div class="photo-check">&#10003;</div><div class="photo-info"><div class="photo-name">${esc(photo.name)}</div>${meta}</div>`;
    grid.appendChild(div);
  });
}

function togglePhoto(id) { state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id); refreshGrid(); }
function selectAll() { state.selected = new Set(state.photos.map(p => p.id)); refreshGrid(); }
function deselectAll() { state.selected.clear(); refreshGrid(); }
function refreshGrid() { renderPhotoGrid(); updateTreePreview(); updateSelectedCount(); }
function updateSelectedCount() {
  const sel = state.photos.filter(p => state.selected.has(p.id));
  const i = sel.filter(p => p.type === 'image').length;
  const v = sel.filter(p => p.type === 'video').length;
  const parts = [`${sel.length} selected`];
  if (i) parts.push(`${i} photos`);
  if (v) parts.push(`${v} videos`);
  $('#selectedCount').textContent = parts.join(' \u00b7 ');
}

// ===================== ORGANIZE & ZIP =====================
async function organize() {
  const sel = state.photos.filter(p => state.selected.has(p.id));
  if (!sel.length) { showToast('No files selected', 'error'); return; }

  keepScreenActive();
  $('#bottomBar').classList.add('hidden');
  showStep('process');

  const zip = new JSZip();
  const project = state.projectName || 'Project';
  const total = sel.length;

  for (let i = 0; i < sel.length; i++) {
    const item = sel[i];
    updateProgress(Math.round((i / total) * 100), `${item.name} (${i + 1}/${total})...`);

    let path = project;
    if (state.primary === 'date' && item.meta.date) {
      path += `/${item.meta.date}`;
      if (state.secondary === 'camera' && item.meta.camera !== 'Unknown') path += `/${san(item.meta.camera)}`;
    } else if (state.primary === 'camera' && item.meta.camera !== 'Unknown') {
      path += `/${san(item.meta.camera)}`;
      if (state.secondary === 'date' && item.meta.date) path += `/${item.meta.date}`;
    }

    zip.folder(path).file(item.name, await item.file.arrayBuffer());
    await new Promise(r => setTimeout(r, 5));
  }

  updateProgress(95, 'Creating ZIP...');
  const blob = await zip.generateAsync({ type: 'blob' });

  const imgs = sel.filter(p => p.type === 'image').length;
  const vids = sel.filter(p => p.type === 'video').length;
  const entry = { id: Date.now().toString(), name: project, date: new Date().toISOString().slice(0, 10), photos: imgs, videos: vids, cameras: [...new Set(sel.map(p => p.meta.camera).filter(c => c !== 'Unknown'))], days: [...new Set(sel.map(p => p.meta.date).filter(d => d))].length, fileCount: sel.length };
  await saveProjectToDB(entry, blob);
  state.projects.unshift(entry);
  if (state.projects.length > 30) state.projects = state.projects.slice(0, 30);
  saveState();

  showStep('done');
  $('#doneText').textContent = `${imgs} photos and ${vids} videos organized into "${project}".`;
  const safe = san(project).replace(/\s+/g, '_') + '.zip';
  $('#downloadBtn').onclick = () => { saveAs(blob, safe); showToast('ZIP downloaded!', 'success'); };
  stopAudioWakeLock();
  showToast('Done!', 'success');
}

function san(n) { return n.replace(/[<>"/\\|?*]/g, '_').trim().slice(0, 100) || 'Unknown'; }

// ===================== STEPS =====================
function showStep(step) {
  state.step = step;
  ['select', 'config', 'process', 'done'].forEach(s => $(`#step-${s}`).classList.toggle('hidden', s !== step));
  $('#bottomBar').classList.toggle('hidden', step !== 'config');
}
function updateProgress(pct, text) { $('#processBar').style.width = pct + '%'; $('#processText').textContent = text; }
function resetAll() {
  state.photos = []; state.selected.clear(); state.step = 'select'; state.nextId = 0;
  $('#photoInput').value = ''; $('#addMoreInput').value = '';
  showStep('select'); $('#bottomBar').classList.add('hidden');
}

// ===================== INDEXEDDB =====================
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = e => { if (!e.target.result.objectStoreNames.contains(DB_STORE)) e.target.result.createObjectStore(DB_STORE, { keyPath: 'id' }); };
  });
}
async function saveProjectToDB(meta, blob) {
  try { const db = await openDB(); const tx = db.transaction(DB_STORE, 'readwrite'); await new Promise((res, rej) => { const r = tx.objectStore(DB_STORE).put({ id: meta.id, meta, blob }); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); db.close(); } catch (e) {}
}
async function loadProjectBlob(projectId) {
  try { const db = await openDB(); const tx = db.transaction(DB_STORE, 'readonly'); const result = await new Promise((res, rej) => { const r = tx.objectStore(DB_STORE).get(projectId); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); db.close(); return result ? result.blob : null; } catch (e) { return null; }
}

// ===================== PROJECT HISTORY =====================
function renderProjectHistory() {
  ['#projectHistory', '#projectHistoryDash'].forEach(selector => {
    const container = $(selector);
    if (!container) return;
    container.innerHTML = '';
    if (!state.projects.length) { container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text2);font-size:12px;">No projects yet</div>'; return; }

    state.projects.slice(0, 15).forEach(proj => {
      const div = document.createElement('div');
      div.className = 'project-card';
      const parts = [`&#128197; ${proj.date}`];
      if (proj.photos) parts.push(`&#128444; ${proj.photos} photos`);
      if (proj.videos) parts.push(`&#127909; ${proj.videos} videos`);

      div.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div style="flex:1;min-width:0;"><div class="project-name">${esc(proj.name)}</div><div class="project-meta">${parts.map(p => `<span>${p}</span>`).join('')}</div></div>
          <div style="display:flex;gap:6px;flex-shrink:0;">
            <button class="btn btn-sm btn-secondary" onclick="app.addToProject('${proj.id}','${esc(proj.name)}')" style="padding:6px 10px;font-size:11px;">+ Add</button>
            <button class="btn btn-sm btn-primary" onclick="app.reDownload('${proj.id}','${esc(proj.name)}')" style="padding:6px 10px;font-size:11px;">&#11015; DL</button>
          </div>
        </div>`;
      container.appendChild(div);
    });
  });
}

async function reDownload(projectId, projectName) {
  showToast('Loading ZIP...', 'info');
  const blob = await loadProjectBlob(projectId);
  if (blob) { saveAs(blob, san(projectName).replace(/\s+/g, '_') + '.zip'); showToast('Downloaded!', 'success'); }
  else { showToast('ZIP not found. Re-organize to create new.', 'error'); }
}

async function addToProject(projectId, projectName) {
  state.projectName = projectName;
  $('#projectName').value = projectName;
  showToast(`Select files to add to "${projectName}"...`, 'info');
  setTimeout(() => triggerAddMore(), 100);
}

// ===================== DASHBOARD =====================
function renderDashboard() {
  const total = state.projects.reduce((a, p) => a + (p.fileCount || p.photos + p.videos || 0), 0);
  const vids = state.projects.reduce((a, p) => a + (p.videos || 0), 0);
  $('#dashFiles').textContent = total.toLocaleString();
  $('#dashVideos').textContent = vids.toLocaleString();
  $('#dashCameras').textContent = state.cameras.length;
  $('#dashProjects').textContent = state.projects.length;

  const camList = $('#cameraList');
  camList.innerHTML = '';
  if (!state.cameras.length) { camList.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text2);font-size:12px;">No cameras yet</div>'; return; }

  state.cameras.forEach(cam => {
    const wear = Math.min(100, Math.round((cam.shutterCount / 150000) * 100));
    const wearColor = cam.shutterCount > 120000 ? 'var(--vermilion)' : cam.shutterCount > 80000 ? 'var(--wood)' : 'var(--moss)';
    const div = document.createElement('div');
    div.className = 'camera-card';
    div.innerHTML = `
      <div class="camera-header"><div class="camera-icon" style="background:${cam.color}15;color:${cam.color};">&#128247;</div>
        <div style="flex:1;min-width:0;"><div class="camera-name">${esc(cam.nickname || cam.model)}</div><div class="camera-model">${esc(cam.model)}</div></div></div>
      <div class="camera-stats"><div class="camera-stat"><div class="camera-stat-val" style="color:${cam.color};">${cam.shutterCount.toLocaleString()}</div><div class="camera-stat-label">Shutter</div></div>
        <div class="camera-stat"><div class="camera-stat-val">${cam.importedFiles.toLocaleString()}</div><div class="camera-stat-label">Files</div></div>
        <div class="camera-stat"><div class="camera-stat-val" style="color:${wearColor};">${wear}%</div><div class="camera-stat-label">Wear</div></div></div>
      <div class="wear-bar"><div class="wear-fill" style="width:${wear}%;background:${wearColor};"></div></div>
      <div style="margin-top:8px;"><input type="text" placeholder="Nickname..." value="${esc(cam.nickname)}" style="font-size:12px;padding:6px 10px;" onchange="app.setNickname('${cam.id}',this.value)"></div>`;
    camList.appendChild(div);
  });
}

function setNickname(id, nick) { const cam = state.cameras.find(c => c.id === id); if (cam) { cam.nickname = nick; saveState(); renderDashboard(); showToast('Saved', 'success'); } }

// ===================== SETTINGS =====================
function setupPresets() {
  const list = $('#presetList');
  list.innerHTML = '';
  Object.entries(PRESETS).forEach(([key, preset]) => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary btn-block';
    btn.style.cssText = 'margin-bottom:8px;text-align:left;justify-content:flex-start;';
    btn.innerHTML = `<span style="flex:1;"><strong>${preset.name}</strong><br><span style="font-size:11px;color:var(--text2);">${preset.primary} / ${preset.secondary}</span></span>`;
    btn.onclick = () => { state.primary = preset.primary; state.secondary = preset.secondary; syncSelects(); updateTreePreview(); updatePresetBadge(); saveState(); showToast(`Preset: ${preset.name}`, 'success'); };
    list.appendChild(btn);
  });
}

// ===================== STORAGE =====================
function saveState() {
  try {
    localStorage.setItem('photoOrg_v2_cameras', JSON.stringify(state.cameras));
    localStorage.setItem('photoOrg_v2_projects', JSON.stringify(state.projects));
    localStorage.setItem('photoOrg_v2_primary', state.primary);
    localStorage.setItem('photoOrg_v2_secondary', state.secondary);
  } catch (e) {}
}
function loadState() {
  try {
    const c = localStorage.getItem('photoOrg_v2_cameras');
    if (c) state.cameras = JSON.parse(c);
    const p = localStorage.getItem('photoOrg_v2_projects');
    if (p) state.projects = JSON.parse(p).map(pr => ({ photos: 0, videos: 0, fileCount: 0, ...pr }));
    const pr = localStorage.getItem('photoOrg_v2_primary');
    if (pr) { state.primary = pr; syncSelects(); }
    const s = localStorage.getItem('photoOrg_v2_secondary');
    if (s) { state.secondary = s; syncSelects(); }
  } catch (e) {}
}

// ===================== UTILS =====================
function fmtSize(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(0) + ' KB'; if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB'; return (b / 1073741824).toFixed(1) + ' GB'; }
function showToast(msg, type) {
  const c = $('#toastContainer');
  const d = document.createElement('div');
  d.className = `toast ${type}`;
  d.textContent = msg;
  c.appendChild(d);
  setTimeout(() => d.remove(), type === 'error' ? 5000 : 3000);
}

// ===================== APP =====================
const app = { selectAll, deselectAll, organize, resetAll, setNickname, triggerAddMore, reDownload, addToProject };
window.app = app;
document.addEventListener('DOMContentLoaded', init);
