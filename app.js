/**
 * Photo Organizer - iOS/Web PWA
 * Photos + Videos, project-based organization, ZIP export
 * 
 * v2.0: + Add more files, project history, wake lock, fast video handling
 */

// ===================== STATE =====================
const state = {
  photos: [],
  selected: new Set(),
  cameras: [],
  projects: [],
  primary: 'date',
  secondary: 'camera',
  projectName: '',
  step: 'select',
  wakeLock: null,
  nextId: 0,
};

const PRESETS = {
  default: { name: 'Project + Date + Camera', primary: 'date', secondary: 'camera' },
  date_only: { name: 'Date Only', primary: 'date', secondary: 'none' },
  camera_only: { name: 'Camera First', primary: 'camera', secondary: 'date' },
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
  updatePresetBadge();
  renderProjectHistory();
  setupWakeLock();
}

// ===================== WAKE LOCK (prevent standby) =====================
function setupWakeLock() {
  if ('wakeLock' in navigator) {
    document.addEventListener('visibilitychange', async () => {
      if (state.wakeLock !== null && document.visibilityState === 'visible') {
        try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
      }
    });
  }
}

async function acquireWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) { /* not supported or denied */ }
  }
}

function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
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
  const input = $('#photoInput');
  input.addEventListener('change', e => handleFiles(e.target.files));
}

function setupAddMoreButton() {
  // Hidden file input for the "+" button
  const extraInput = document.createElement('input');
  extraInput.type = 'file';
  extraInput.multiple = true;
  extraInput.accept = 'image/*,video/*,.dng,.raf,.cr2,.cr3,.nef,.arw,.orf,.rw2,.heic,.mp4,.mov,.m4v';
  extraInput.style.display = 'none';
  extraInput.id = 'addMoreInput';
  extraInput.addEventListener('change', e => handleAddMore(e.target.files));
  document.body.appendChild(extraInput);
}

function triggerAddMore() {
  $('#addMoreInput').click();
}

async function handleFiles(fileList) {
  const files = filterMedia(Array.from(fileList));
  if (!files.length) return;
  startImport(files, true);
}

async function handleAddMore(fileList) {
  const files = filterMedia(Array.from(fileList));
  if (!files.length) return;
  startImport(files, false);
}

function filterMedia(files) {
  return files.filter(f =>
    f.type.startsWith('image/') || f.type.startsWith('video/') ||
    IMAGE_RE.test(f.name) || VIDEO_RE.test(f.name)
  );
}

async function startImport(files, isNewImport) {
  const imgs = files.filter(f => isImage(f)).length;
  const vids = files.filter(f => isVideo(f)).length;

  if (isNewImport) {
    state.photos = [];
    state.selected = new Set();
    state.nextId = 0;
    showToast(`Reading ${files.length} files...`, 'info');
    showStep('process');
  } else {
    showToast(`Adding ${files.length} more files...`, 'info');
  }

  await acquireWakeLock();

  const startIdx = state.nextId;
  const total = files.length;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const isVid = isVideo(file);
    const id = startIdx + i;

    if (isNewImport) {
      updateProgress(Math.round(((i + 0.5) / total) * 50),
        isVid ? `Reading video ${i+1}/${total}...` : `Reading photo ${i+1}/${total}...`);
    }

    const meta = isVid ? await readVideoMeta(file) : await readExif(file);

    state.photos.push({
      id, file, name: file.name,
      type: isVid ? 'video' : 'image',
      size: fmtSize(file.size),
      meta, thumb: isVid ? null : null
    });

    // Generate thumbnail (async, non-blocking for photos)
    if (!isVid) {
      try {
        state.photos[state.photos.length - 1].thumb = await quickThumbnail(file);
      } catch (_) {}
    }
  }

  state.nextId = startIdx + total;
  state.selected = new Set(state.photos.map(p => p.id));

  autoSuggestProjectName();
  showStep('config');
  renderPhotoGrid();
  updateTreePreview();
  updatePresetBadge();
  updateSelectedCount();
  $('#bottomBar').classList.remove('hidden');

  const allImgs = state.photos.filter(p => p.type === 'image').length;
  const allVids = state.photos.filter(p => p.type === 'video').length;
  showToast(`Ready: ${allImgs} photos, ${allVids} videos`, 'success');

  releaseWakeLock();
}

function isImage(f) {
  return f.type.startsWith('image/') || IMAGE_RE.test(f.name);
}

function isVideo(f) {
  return f.type.startsWith('video/') || VIDEO_RE.test(f.name);
}

// ===================== EXIF (photos) =====================
async function readExif(file) {
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

  return { camera, cameraMake: make, lens,
    focalLength: focal ? `${Math.round(focal)}mm` : '',
    aperture: aperture ? `f/${aperture}` : '', iso, date, shutterCount, serial, gps };
}

// ===================== VIDEO META (fast - no thumbnails) =====================
async function readVideoMeta(file) {
  // Fast path: extract date from filename or file metadata, NO video element creation
  let date = extractDateFromFilename(file.name);
  if (!date && file.lastModified) {
    const d = new Date(file.lastModified);
    date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  // Detect camera from filename
  const n = file.name.toLowerCase();
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
  const m = name.match(/(20\d{2})(\d{2})(\d{2})/);
  return m && m[1] ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function extractDate(str) {
  if (!str) return '';
  const p = str.split(/[:\s]/);
  return p.length >= 3 ? `${p[0]}-${p[1]}-${p[2]}` : '';
}

// ===================== FAST THUMBNAIL =====================
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
  const cams = [...new Set(state.photos.map(p => p.meta.camera).filter(c => c && c !== 'Unknown'))];
  if (!dates.length) {
    state.projectName = `Import ${new Date().toISOString().slice(0,10)}`;
  } else {
    const s = dates[0], e = dates[dates.length-1];
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
function syncSelects() {
  $('#primaryGroup').value = state.primary;
  $('#secondaryGroup').value = state.secondary;
}

function updatePresetBadge() {
  let match = 'custom';
  for (const [k, p] of Object.entries(PRESETS)) {
    if (p.primary === state.primary && p.secondary === state.secondary) { match = k; break; }
  }
  const b = $('#presetBadge');
  if (match !== 'custom') {
    b.textContent = `Preset: ${PRESETS[match].name}`;
    b.style.color = 'var(--indigo)'; b.style.background = 'rgba(92,124,156,0.1)';
  } else {
    b.textContent = `Custom: ${state.primary} / ${state.secondary}`;
    b.style.color = 'var(--text2)'; b.style.background = 'rgba(232,226,217,0.05)';
  }
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
          day.filter(p => p.meta.camera === cam).slice(0,2).forEach(f =>
            lines.push(`          <span class="indent">&#9500;&#9472;</span> <span class="file">${esc(f.name)}</span>`));
          const m = day.filter(p => p.meta.camera === cam).length - 2;
          if (m > 0) lines.push(`          <span class="indent">&#9492;&#9472;</span> <span class="file">+${m} more</span>`);
        });
      } else {
        day.slice(0,3).forEach(f => lines.push(`      <span class="indent">&#9500;&#9472;</span> <span class="file">${esc(f.name)}</span>`));
        if (day.length > 3) lines.push(`      <span class="indent">&#9492;&#9472;</span> <span class="file">+${day.length-3} more</span>`);
      }
    }
  } else if (state.primary === 'camera') {
    const cams = [...new Set(sel.map(p => p.meta.camera).filter(c => c !== 'Unknown'))];
    for (const cam of cams) {
      lines.push(`  <span class="indent">&#9492;&#9472;</span> <span class="folder">${esc(cam)}/</span>`);
      const m = sel.filter(p => p.meta.camera === cam);
      m.slice(0,4).forEach(f => lines.push(`      <span class="indent">&#9500;&#9472;</span> <span class="file">${esc(f.name)}</span>`));
      if (m.length > 4) lines.push(`      <span class="indent">&#9492;&#9472;</span> <span class="file">+${m.length-4} more</span>`);
    }
  } else {
    sel.slice(0,8).forEach(f => lines.push(`  <span class="indent">&#9500;&#9472;</span> <span class="file">${esc(f.name)}</span>`));
    if (sel.length > 8) lines.push(`  <span class="indent">&#9492;&#9472;</span> <span class="file">+${sel.length-8} more</span>`);
  }

  $('#treePreview').innerHTML = lines.join('\n');
  const imgs = sel.filter(p => p.type === 'image').length;
  const vids = sel.filter(p => p.type === 'video').length;
  const parts = [`${sel.length} files`];
  if (imgs) parts.push(`${imgs} photos`);
  if (vids) parts.push(`${vids} videos`);
  parts.push(`${[...new Set(sel.map(p => p.meta.date))].filter(d=>d).length} days`);
  $('#photoCount').textContent = parts.join(' \u00b7 ');
}
function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

// ===================== PHOTO GRID =====================
function renderPhotoGrid() {
  const grid = $('#photoGrid');
  grid.innerHTML = '';

  state.photos.forEach(photo => {
    const div = document.createElement('div');
    div.className = `photo-card ${state.selected.has(photo.id)?'selected':''}`;
    div.onclick = () => togglePhoto(photo.id);

    // Thumbnail or placeholder
    let thumbHtml;
    if (photo.thumb) {
      thumbHtml = `<img src="${photo.thumb}" alt="">`;
    } else if (photo.type === 'video') {
      thumbHtml = `<div class="placeholder video-placeholder">&#9654;</div>`;
    } else {
      thumbHtml = `<div class="placeholder">&#128247;</div>`;
    }

    const videoBadge = photo.type === 'video' ? '<div class="video-badge">VIDEO</div>' : '';

    const meta = photo.type === 'video'
      ? `<div class="photo-meta" style="color:var(--moss);">${esc(photo.meta.camera)}</div><div class="photo-meta">${photo.size} \u00b7 ${photo.meta.date||'No date'}</div>`
      : `<div class="photo-meta">${esc(photo.meta.camera)} \u00b7 ${photo.meta.focalLength} ${photo.meta.aperture}</div><div class="photo-meta">${photo.meta.date||'?'} \u00b7 ISO${photo.meta.iso}</div>`;

    div.innerHTML = `
      <div class="photo-thumb">${thumbHtml}${videoBadge}</div>
      <div class="photo-check">&#10003;</div>
      <div class="photo-info">
        <div class="photo-name">${esc(photo.name)}</div>
        ${meta}
      </div>`;
    grid.appendChild(div);
  });
}

function togglePhoto(id) {
  state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
  renderPhotoGrid(); updateTreePreview(); updateSelectedCount();
}
function selectAll() { state.selected = new Set(state.photos.map(p=>p.id)); refreshGrid(); }
function deselectAll() { state.selected.clear(); refreshGrid(); }
function refreshGrid() { renderPhotoGrid(); updateTreePreview(); updateSelectedCount(); }
function updateSelectedCount() {
  const sel = state.photos.filter(p => state.selected.has(p.id));
  const i = sel.filter(p=>p.type==='image').length;
  const v = sel.filter(p=>p.type==='video').length;
  const parts = [`${sel.length} selected`];
  if (i) parts.push(`${i} photos`);
  if (v) parts.push(`${v} videos`);
  $('#selectedCount').textContent = parts.join(' \u00b7 ');
}

// ===================== ORGANIZE & ZIP =====================
async function organize() {
  const sel = state.photos.filter(p => state.selected.has(p.id));
  if (!sel.length) { showToast('No files selected', 'error'); return; }

  await acquireWakeLock();
  $('#bottomBar').classList.add('hidden');
  showStep('process');

  const zip = new JSZip();
  const project = state.projectName || 'Project';
  const total = sel.length;

  for (let i = 0; i < sel.length; i++) {
    const item = sel[i];
    updateProgress(Math.round((i/total)*100), `Adding ${item.name} (${i+1}/${total})...`);

    let path = project;
    if (state.primary === 'date' && item.meta.date) {
      path += `/${item.meta.date}`;
      if (state.secondary === 'camera' && item.meta.camera !== 'Unknown') path += `/${san(item.meta.camera)}`;
    } else if (state.primary === 'camera' && item.meta.camera !== 'Unknown') {
      path += `/${san(item.meta.camera)}`;
      if (state.secondary === 'date' && item.meta.date) path += `/${item.meta.date}`;
    } else if (state.primary === 'location' && item.meta.gps) {
      path += `/${item.meta.gps.replace(/[,\s]/g,'_')}`;
    }

    zip.folder(path).file(item.name, await item.file.arrayBuffer());
    await new Promise(r => setTimeout(r, 5));
  }

  updateProgress(95, 'Creating ZIP...');
  const blob = await zip.generateAsync({ type: 'blob' });

  // Save to IndexedDB
  const imgs = sel.filter(p=>p.type==='image').length;
  const vids = sel.filter(p=>p.type==='video').length;
  const entry = {
    id: Date.now().toString(),
    name: project,
    date: new Date().toISOString().slice(0,10),
    photos: imgs, videos: vids,
    cameras: [...new Set(sel.map(p=>p.meta.camera).filter(c=>c!=='Unknown'))],
    days: [...new Set(sel.map(p=>p.meta.date).filter(d=>d))].length,
    fileCount: sel.length,
    createdAt: new Date().toISOString(),
  };
  await saveProjectToDB(entry, blob);

  state.projects.unshift(entry);
  if (state.projects.length > 30) state.projects = state.projects.slice(0,30);
  saveState();

  showStep('done');
  $('#doneText').textContent = `${imgs} photos and ${vids} videos organized into "${project}".`;
  const safe = san(project).replace(/\s+/g,'_') + '.zip';
  $('#downloadBtn').onclick = () => { saveAs(blob, safe); showToast('ZIP downloaded!', 'success'); };

  releaseWakeLock();
  showToast('Done! ZIP ready.', 'success');
  renderProjectHistory();
}

function san(n) { return n.replace(/[<>"/\\|?*]/g,'_').trim().slice(0,100)||'Unknown'; }

// ===================== STEPS =====================
function showStep(step) {
  state.step = step;
  ['select','config','process','done'].forEach(s => $(`#step-${s}`).classList.toggle('hidden', s !== step));
  $('#bottomBar').classList.toggle('hidden', step !== 'config');
}
function updateProgress(pct, text) {
  $('#processBar').style.width = pct + '%';
  $('#processText').textContent = text;
}
function resetAll() {
  state.photos = []; state.selected.clear(); state.step = 'select'; state.nextId = 0;
  $('#photoInput').value = ''; $('#addMoreInput').value = '';
  showStep('select'); $('#bottomBar').classList.add('hidden');
}

// ===================== INDEXEDDB PROJECTS =====================
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'id' });
      }
    };
  });
}

async function saveProjectToDB(meta, blob) {
  try {
    const db = await openDB();
    const tx = db.transaction(DB_STORE, 'readwrite');
    const store = tx.objectStore(DB_STORE);
    await new Promise((resolve, reject) => {
      const req = store.put({ id: meta.id, meta, blob, savedAt: Date.now() });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    db.close();
  } catch (e) { console.warn('DB save failed:', e); }
}

async function loadProjectBlob(projectId) {
  try {
    const db = await openDB();
    const tx = db.transaction(DB_STORE, 'readonly');
    const store = tx.objectStore(DB_STORE);
    const result = await new Promise((resolve, reject) => {
      const req = store.get(projectId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return result ? result.blob : null;
  } catch (e) { console.warn('DB load failed:', e); return null; }
}

async function deleteProjectFromDB(projectId) {
  try {
    const db = await openDB();
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(projectId);
    db.close();
  } catch (e) {}
}

// ===================== PROJECT HISTORY UI =====================
function renderProjectHistory() {
  const container = $('#projectHistory');
  if (!container) return;
  container.innerHTML = '';

  if (!state.projects.length) {
    container.innerHTML = `<div style="text-align:center;padding:30px;color:var(--text2);font-size:13px;">No projects yet. Import photos to see them here.</div>`;
    return;
  }

  state.projects.slice(0, 20).forEach(proj => {
    const div = document.createElement('div');
    div.className = 'project-card';
    div.style.marginBottom = '10px';

    const parts = [`&#128197; ${proj.date}`];
    if (proj.photos) parts.push(`&#128444; ${proj.photos} photos`);
    if (proj.videos) parts.push(`&#127909; ${proj.videos} videos`);
    parts.push(`&#128198; ${proj.days} day${proj.days>1?'s':''}`);

    div.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
        <div style="flex:1;min-width:0;">
          <div class="project-name">${esc(proj.name)}</div>
          <div class="project-meta">${parts.map(p=>`<span>${p}</span>`).join('')}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;">
          <button class="btn btn-sm btn-secondary" onclick="app.addToProject('${proj.id}','${esc(proj.name)}')" style="padding:6px 10px;font-size:11px;">+ Add</button>
          <button class="btn btn-sm btn-primary" onclick="app.reDownload('${proj.id}','${esc(proj.name)}')" style="padding:6px 10px;font-size:11px;">&#11015; DL</button>
        </div>
      </div>
    `;
    container.appendChild(div);
  });
}

// Re-download a previously created ZIP
async function reDownload(projectId, projectName) {
  showToast('Loading ZIP from storage...', 'info');
  const blob = await loadProjectBlob(projectId);
  if (blob) {
    const safe = san(projectName).replace(/\s+/g,'_') + '.zip';
    saveAs(blob, safe);
    showToast('ZIP downloaded!', 'success');
  } else {
    showToast('ZIP not found in storage. Re-organize to create new.', 'error');
  }
}

// Add more files to an existing project
async function addToProject(projectId, projectName) {
  state.projectName = projectName;
  $('#projectName').value = projectName;
  // Pre-fill existing photos from this project if available
  const existing = state.projects.find(p => p.id === projectId);
  if (existing) {
    showToast(`Select more files to add to "${projectName}"...`, 'info');
  }
  // Trigger file picker
  setTimeout(() => triggerAddMore(), 100);
}

// ===================== DASHBOARD =====================
function renderDashboard() {
  const total = state.projects.reduce((a,p) => a + (p.fileCount || p.photos + p.videos || 0), 0);
  const vids = state.projects.reduce((a,p) => a + (p.videos || 0), 0);
  const thisMo = state.projects
    .filter(p => p.date.startsWith(new Date().toISOString().slice(0,7)))
    .reduce((a,p) => a + (p.fileCount || p.photos + p.videos || 0), 0);

  $('#dashFiles').textContent = total.toLocaleString();
  $('#dashVideos').textContent = vids.toLocaleString();
  $('#dashCameras').textContent = state.cameras.length;
  $('#dashProjects').textContent = state.projects.length;

  // Camera list
  const camList = $('#cameraList');
  camList.innerHTML = '';
  if (!state.cameras.length) {
    camList.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text2);font-size:13px;">No cameras yet. Import photos to see your gear.</div>';
    return;
  }
  state.cameras.forEach(cam => {
    const wear = Math.min(100, Math.round((cam.shutterCount / 150000) * 100));
    const wearColor = cam.shutterCount > 120000 ? 'var(--vermilion)' : cam.shutterCount > 80000 ? 'var(--wood)' : 'var(--moss)';
    const div = document.createElement('div');
    div.className = 'camera-card';
    div.innerHTML = `
      <div class="camera-header">
        <div class="camera-icon" style="background:${cam.color}15;color:${cam.color};">&#128247;</div>
        <div style="flex:1;min-width:0;">
          <div class="camera-name">${esc(cam.nickname || cam.model)}</div>
          <div class="camera-model">${esc(cam.model)}</div>
        </div>
      </div>
      <div class="camera-stats">
        <div class="camera-stat"><div class="camera-stat-val" style="color:${cam.color};">${cam.shutterCount.toLocaleString()}</div><div class="camera-stat-label">Shutter</div></div>
        <div class="camera-stat"><div class="camera-stat-val">${cam.importedFiles.toLocaleString()}</div><div class="camera-stat-label">Files</div></div>
        <div class="camera-stat"><div class="camera-stat-val" style="color:${wearColor};">${wear}%</div><div class="camera-stat-label">Wear</div></div>
      </div>
      <div class="wear-bar"><div class="wear-fill" style="width:${wear}%;background:${wearColor};"></div></div>
      <div style="margin-top:8px;"><input type="text" placeholder="Nickname..." value="${esc(cam.nickname)}"
        style="font-size:12px;padding:6px 10px;" onchange="app.setNickname('${cam.id}',this.value)"></div>`;
    camList.appendChild(div);
  });
}

function setNickname(id, nick) {
  const cam = state.cameras.find(c => c.id === id);
  if (cam) { cam.nickname = nick; saveState(); renderDashboard(); showToast('Saved', 'success'); }
}

// ===================== SETTINGS =====================
function setupPresets() {
  const list = $('#presetList');
  list.innerHTML = '';
  Object.entries(PRESETS).forEach(([key, preset]) => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary btn-block';
    btn.style.cssText = 'margin-bottom:8px;text-align:left;justify-content:flex-start;';
    btn.innerHTML = `<span style="flex:1;"><strong>${preset.name}</strong><br><span style="font-size:11px;color:var(--text2);">${preset.primary} / ${preset.secondary}</span></span>`;
    btn.onclick = () => {
      state.primary = preset.primary; state.secondary = preset.secondary;
      syncSelects(); updateTreePreview(); updatePresetBadge(); saveState();
      showToast(`Preset: ${preset.name}`, 'success');
    };
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
    if (p) {
      const parsed = JSON.parse(p);
      state.projects = parsed.map(pr => ({ photos: 0, videos: 0, fileCount: 0, ...pr }));
    }
    const pr = localStorage.getItem('photoOrg_v2_primary');
    if (pr) { state.primary = pr; syncSelects(); }
    const s = localStorage.getItem('photoOrg_v2_secondary');
    if (s) { state.secondary = s; syncSelects(); }
  } catch (e) {}
}

// ===================== UTILS =====================
function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(0) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
  return (b/1073741824).toFixed(1) + ' GB';
}
function showToast(msg, type) {
  const c = $('#toastContainer');
  const d = document.createElement('div');
  d.className = `toast ${type}`;
  d.textContent = msg;
  c.appendChild(d);
  setTimeout(() => d.remove(), 3000);
}

// ===================== APP =====================
const app = {
  selectAll, deselectAll, organize, resetAll, setNickname,
  triggerAddMore, reDownload, addToProject, renderProjectHistory,
};
window.app = app;
document.addEventListener('DOMContentLoaded', init);
