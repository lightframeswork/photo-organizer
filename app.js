/**
 * Photo Organizer - iOS/Web PWA
 * Client-side EXIF reading for photos, file-date for videos,
 * project-based organization, ZIP export
 * Supports: photos (RAW/JPEG) + videos (MP4/MOV/M4V)
 */

// ===================== STATE =====================
const state = {
  photos: [],          // { id, file, name, type: 'image'|'video', size, meta, thumb }
  selected: new Set(),
  cameras: [],         // { id, model, make, nickname, shutterCount, importedFiles, color }
  projects: [],        // { id, name, date, photos, videos, cameras, days }
  primary: 'date',
  secondary: 'camera',
  projectName: '',
  step: 'select',
};

const PRESETS = {
  default: { name: 'Project + Date + Camera', primary: 'date', secondary: 'camera' },
  date_only: { name: 'Date Only', primary: 'date', secondary: 'none' },
  camera_only: { name: 'Camera First', primary: 'camera', secondary: 'date' },
  location_first: { name: 'Location First', primary: 'location', secondary: 'date' },
  flat: { name: 'Flat Project', primary: 'none', secondary: 'none' },
};

const COLORS = {
  Leica: { gold: '#B8860B', muted: 'rgba(184,134,11,0.15)' },
  Fujifilm: { gold: '#A07850', muted: 'rgba(160,120,80,0.15)' },
  Nikon: { gold: '#FFD700', muted: 'rgba(255,215,0,0.15)' },
  Canon: { gold: '#DC143C', muted: 'rgba(220,20,60,0.15)' },
  Sony: { gold: '#5C7C9C', muted: 'rgba(92,124,156,0.15)' },
};

// Supported extensions
const IMAGE_EXTS = /\.(jpe?g|png|tiff?|bmp|webp|dng|raf|cr2|cr3|nef|arw|orf|rw2|raw)$/i;
const VIDEO_EXTS = /\.(mp4|mov|m4v|avi|mkv|wmv|flv|webm|mts|m2ts)$/i;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function init() {
  loadState();
  setupTabs();
  setupFileInput();
  setupGroupingControls();
  setupPresets();
  renderDashboard();
  updatePresetBadge();
}

function setupTabs() {
  $$('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.nav-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const name = tab.dataset.tab;
      ['import', 'dashboard', 'settings'].forEach(t => {
        $(`#tab-${t}`).classList.toggle('hidden', t !== name);
      });
      if (name === 'dashboard') renderDashboard();
      $('#bottomBar').classList.toggle('hidden', name !== 'import' || state.step !== 'config');
    });
  });
}

// ===================== FILE INPUT =====================
function setupFileInput() {
  $('#photoInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files).filter(f =>
      f.type.startsWith('image/') ||
      f.type.startsWith('video/') ||
      IMAGE_EXTS.test(f.name) ||
      VIDEO_EXTS.test(f.name)
    );
    if (!files.length) return;

    // Separate images and videos for stats
    const images = files.filter(f => f.type.startsWith('image/') || IMAGE_EXTS.test(f.name));
    const videos = files.filter(f => f.type.startsWith('video/') || VIDEO_EXTS.test(f.name));

    showStep('process');
    toast(`Reading ${files.length} files (${images.length} photos, ${videos.length} videos)...`, 'info');

    state.photos = [];
    const total = files.length;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const isVideo = file.type.startsWith('video/') || VIDEO_EXTS.test(file.name);
      updateProgress(Math.round(((i + 0.5) / total) * 50),
        isVideo ? `Reading video: ${file.name}...` : `Reading photo: ${file.name}...`);

      try {
        const meta = isVideo ? await readVideoMeta(file) : await readExif(file);
        state.photos.push({
          id: i,
          file,
          name: file.name,
          type: isVideo ? 'video' : 'image',
          size: formatSize(file.size),
          meta,
          thumb: null,
        });
      } catch (err) {
        state.photos.push({
          id: i,
          file,
          name: file.name,
          type: isVideo ? 'video' : 'image',
          size: formatSize(file.size),
          meta: makeUnknownMeta(),
          thumb: null,
        });
      }

      // Generate thumbnail
      try {
        if (isVideo) {
          state.photos[i].thumb = await generateVideoThumbnail(file);
        } else {
          state.photos[i].thumb = await generateThumbnail(file);
        }
      } catch (_) { /* ignore */ }
    }

    state.selected = new Set(state.photos.map(p => p.id));
    autoSuggestProjectName();
    showStep('config');
    renderPhotoGrid();
    updateTreePreview();
    updatePresetBadge();
    updateSelectedCount();
    $('#bottomBar').classList.remove('hidden');

    const imgCount = state.photos.filter(p => p.type === 'image').length;
    const vidCount = state.photos.filter(p => p.type === 'video').length;
    toast(`Loaded ${imgCount} photos, ${vidCount} videos`, 'success');
  });
}

function makeUnknownMeta() {
  return { camera: 'Unknown', cameraMake: '', lens: '', focalLength: '', aperture: '', iso: '', date: '', shutterCount: 0, serial: '', gps: '' };
}

// ===================== PHOTO EXIF =====================
async function readExif(file) {
  const buffer = await file.arrayBuffer();
  const tags = ExifReader.load(buffer);

  const make = (tags['Make']?.description || '').trim();
  const model = (tags['Model']?.description || '').trim();
  const camera = `${make} ${model}`.trim() || 'Unknown';
  const serial = tags['SerialNumber']?.description || '';
  const lens = tags['LensModel']?.description || tags['Lens']?.description || '';

  const focal = tags['FocalLength']?.description || '';
  const focalNum = parseFloat(focal) || 0;
  const aperture = tags['FNumber']?.description || '';
  const iso = tags['ISOSpeedRatings']?.description || '';

  let date = extractDate(tags['DateTimeOriginal']?.description || '');

  let shutterCount = 0;
  const scTags = ['ImageCount', 'ShutterCount', 'TotalShutterReleases', 'ImageCount2'];
  for (const t of scTags) {
    if (tags[t]) { shutterCount = parseInt(tags[t].description) || 0; break; }
  }

  let gps = '';
  if (tags['GPSLatitude'] && tags['GPSLongitude']) {
    gps = `${tags['GPSLatitude'].description}, ${tags['GPSLongitude'].description}`;
  }

  // Track camera
  const camKey = serial || camera;
  let cam = state.cameras.find(c => c.id === camKey);
  if (!cam && camera !== 'Unknown') {
    const makeKey = Object.keys(COLORS).find(k => make.toLowerCase().includes(k.toLowerCase())) || 'default';
    const c = COLORS[makeKey] || COLORS.Sony;
    cam = { id: camKey, model: camera, make, nickname: '', shutterCount, importedFiles: 0, color: c.gold };
    state.cameras.push(cam);
  }
  if (cam) {
    cam.importedFiles++;
    if (shutterCount > cam.shutterCount) cam.shutterCount = shutterCount;
  }

  return { camera, cameraMake: make, lens, focalLength: focalNum ? `${Math.round(focalNum)}mm` : '', aperture: aperture ? `f/${aperture}` : '', iso, date, shutterCount, serial, gps };
}

// ===================== VIDEO METADATA =====================
async function readVideoMeta(file) {
  // Videos don't have EXIF in ExifReader, so we use file metadata
  let date = '';

  // Try to extract date from filename (common patterns)
  const nameDate = extractDateFromFilename(file.name);
  if (nameDate) {
    date = nameDate;
  } else if (file.lastModified) {
    // Fall back to file modification date
    const d = new Date(file.lastModified);
    date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  // Try to detect camera from filename patterns
  let camera = 'Video';
  const lowerName = file.name.toLowerCase();
  if (lowerName.includes('gopro')) camera = 'GoPro';
  else if (lowerName.includes('dji')) camera = 'DJI';
  else if (lowerName.includes('insta')) camera = 'Insta360';
  else if (lowerName.includes('iphone')) camera = 'iPhone';
  else if (lowerName.includes('pixel')) camera = 'Pixel';
  else if (lowerName.includes('sony')) camera = 'Sony';
  else if (lowerName.includes('fuji') || lowerName.includes('xt-')) camera = 'Fujifilm';
  else if (lowerName.includes('leica')) camera = 'Leica';

  return { camera, cameraMake: '', lens: '', focalLength: '', aperture: '', iso: '', date, shutterCount: 0, serial: '', gps: '' };
}

function extractDateFromFilename(filename) {
  // Match patterns like: IMG_20240315_123456, 2024-03-15, VID_20240315
  const patterns = [
    /(\d{4})[\-_]?(\d{2})[\-_]?(\d{2})/,           // 2024-03-15 or 20240315
    /IMG_[EP]?(\d{4})(\d{2})(\d{2})_/,               // IMG_20240315_
    /VID_?(\d{4})(\d{2})(\d{2})/,                     // VID_20240315
    /(20\d{2})(\d{2})(\d{2})/,                         // 20240315 anywhere
  ];
  for (const re of patterns) {
    const m = filename.match(re);
    if (m && m[1] && m[2] && m[3]) {
      const year = parseInt(m[1]);
      if (year >= 2000 && year <= 2035) {
        return `${m[1]}-${m[2]}-${m[3]}`;
      }
    }
  }
  return null;
}

function extractDate(dateStr) {
  if (!dateStr || dateStr.length < 10) return '';
  const parts = dateStr.split(/[:\s]/);
  return `${parts[0]}-${parts[1]}-${parts[2]}`;
}

// ===================== THUMBNAILS =====================
async function generateThumbnail(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 150;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 200, 150);
      resolve(canvas.toDataURL('image/jpeg', 0.6));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

async function generateVideoThumbnail(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.playsInline = true;
    video.muted = true;
    video.crossOrigin = 'anonymous';

    video.onloadedmetadata = () => {
      // Seek to 1 second or 10% of duration
      video.currentTime = Math.min(1, video.duration * 0.1);
    };

    video.onseeked = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 150;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, 200, 150);

      // Draw play indicator overlay
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath();
      ctx.arc(100, 75, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'white';
      ctx.beginPath();
      ctx.moveTo(94, 65);
      ctx.lineTo(94, 85);
      ctx.lineTo(112, 75);
      ctx.closePath();
      ctx.fill();

      resolve(canvas.toDataURL('image/jpeg', 0.6));
      URL.revokeObjectURL(video.src);
    };

    video.onerror = () => {
      URL.revokeObjectURL(video.src);
      reject(new Error('Video thumbnail failed'));
    };

    video.src = URL.createObjectURL(file);
  });
}

// ===================== PROJECT NAME =====================
function autoSuggestProjectName() {
  const allMedia = state.photos;
  const dates = allMedia.map(p => p.meta.date).filter(d => d).sort();
  const cameras = [...new Set(allMedia.map(p => p.meta.camera).filter(c => c && c !== 'Unknown'))];

  if (!dates.length) {
    state.projectName = `Import ${new Date().toISOString().slice(0, 10)}`;
  } else {
    const start = dates[0];
    const end = dates[dates.length - 1];
    let name = start === end ? start : `${start} to ${end}`;
    if (cameras.length === 1) name += ` (${cameras[0]})`;
    else if (cameras.length > 1) name += ` (${cameras.length} cameras)`;
    state.projectName = name;
  }
  $('#projectName').value = state.projectName;
}

// ===================== GROUPING CONTROLS =====================
function setupGroupingControls() {
  $('#primaryGroup').addEventListener('change', (e) => {
    state.primary = e.target.value;
    updateTreePreview();
    updatePresetBadge();
  });
  $('#secondaryGroup').addEventListener('change', (e) => {
    state.secondary = e.target.value;
    updateTreePreview();
    updatePresetBadge();
  });
  $('#projectName').addEventListener('input', (e) => {
    state.projectName = e.target.value;
    updateTreePreview();
  });

  $('#defaultPrimary').addEventListener('change', (e) => {
    state.primary = e.target.value;
    $('#primaryGroup').value = e.target.value;
    updateTreePreview();
    updatePresetBadge();
    saveState();
  });
  $('#defaultSecondary').addEventListener('change', (e) => {
    state.secondary = e.target.value;
    $('#secondaryGroup').value = e.target.value;
    updateTreePreview();
    updatePresetBadge();
    saveState();
  });
}

function updatePresetBadge() {
  let match = 'custom';
  for (const [key, p] of Object.entries(PRESETS)) {
    if (p.primary === state.primary && p.secondary === state.secondary) {
      match = key;
      break;
    }
  }
  const badge = $('#presetBadge');
  if (match !== 'custom') {
    badge.textContent = `Preset: ${PRESETS[match].name}`;
    badge.style.color = 'var(--indigo)';
    badge.style.background = 'rgba(92,124,156,0.1)';
  } else {
    badge.textContent = `Custom: ${state.primary} / ${state.secondary}`;
    badge.style.color = 'var(--text2)';
    badge.style.background = 'rgba(232,226,217,0.05)';
  }
}

// ===================== TREE PREVIEW =====================
function updateTreePreview() {
  const selected = state.photos.filter(p => state.selected.has(p.id));
  const project = state.projectName || 'Project';
  const lines = [`<span class="folder">${escapeHtml(project)}/</span>`];

  if (state.primary === 'date') {
    const dates = [...new Set(selected.map(p => p.meta.date).filter(d => d))].sort();
    for (const date of dates) {
      lines.push(`  <span class="indent">\u2514\u2500\u2500</span> <span class="folder">${date}/</span>`);
      const dayMedia = selected.filter(p => p.meta.date === date);
      if (state.secondary === 'camera') {
        const cams = [...new Set(dayMedia.map(p => p.meta.camera))];
        for (let ci = 0; ci < cams.length; ci++) {
          const isLast = ci === cams.length - 1;
          lines.push(`  <span class="indent">    ${isLast ? '\u2514\u2500\u2500' : '\u251c\u2500\u2500'}</span> <span class="folder">${escapeHtml(cams[ci])}/</span>`);
          dayMedia.filter(p => p.meta.camera === cams[ci]).slice(0, 2).forEach(f =>
            lines.push(`  <span class="indent">    ${isLast ? '    ' : '\u2502   '}\u251c\u2500\u2500</span> <span class="file">${escapeHtml(f.name)}</span>`)
          );
          const more = dayMedia.filter(p => p.meta.camera === cams[ci]).length - 2;
          if (more > 0) lines.push(`  <span class="indent">    ${isLast ? '    ' : '\u2502   '}\u2514\u2500\u2500</span> <span class="file">+${more} more</span>`);
        }
      } else {
        dayMedia.slice(0, 3).forEach(f =>
          lines.push(`  <span class="indent">    \u251c\u2500\u2500</span> <span class="file">${escapeHtml(f.name)}</span>`)
        );
        if (dayMedia.length > 3) lines.push(`  <span class="indent">    \u2514\u2500\u2500</span> <span class="file">+${dayMedia.length - 3} more</span>`);
      }
    }
  } else if (state.primary === 'camera') {
    const cams = [...new Set(selected.map(p => p.meta.camera).filter(c => c !== 'Unknown'))];
    for (const cam of cams) {
      lines.push(`  <span class="indent">\u2514\u2500\u2500</span> <span class="folder">${escapeHtml(cam)}/</span>`);
      const camMedia = selected.filter(p => p.meta.camera === cam);
      if (state.secondary === 'date') {
        const dates = [...new Set(camMedia.map(p => p.meta.date))].sort();
        for (const date of dates) {
          lines.push(`  <span class="indent">    \u251c\u2500\u2500</span> <span class="folder">${date}/</span>`);
          camMedia.filter(p => p.meta.date === date).slice(0, 2).forEach(f =>
            lines.push(`  <span class="indent">    \u2502   \u251c\u2500\u2500</span> <span class="file">${escapeHtml(f.name)}</span>`)
          );
        }
      } else {
        camMedia.slice(0, 4).forEach(f =>
          lines.push(`  <span class="indent">    \u251c\u2500\u2500</span> <span class="file">${escapeHtml(f.name)}</span>`)
        );
        if (camMedia.length > 4) lines.push(`  <span class="indent">    \u2514\u2500\u2500</span> <span class="file">+${camMedia.length - 4} more</span>`);
      }
    }
  } else {
    selected.slice(0, 8).forEach(f =>
      lines.push(`  <span class="indent">\u251c\u2500\u2500</span> <span class="file">${escapeHtml(f.name)}</span>`)
    );
    if (selected.length > 8) lines.push(`  <span class="indent">\u2514\u2500\u2500</span> <span class="file">+${selected.length - 8} more</span>`);
  }

  $('#treePreview').innerHTML = lines.join('\n');

  const imgCount = selected.filter(p => p.type === 'image').length;
  const vidCount = selected.filter(p => p.type === 'video').length;
  const counts = [];
  counts.push(`${selected.length} files`);
  if (imgCount) counts.push(`${imgCount} photos`);
  if (vidCount) counts.push(`${vidCount} videos`);
  counts.push(`${[...new Set(selected.map(p => p.meta.date))].filter(d => d).length} days`);
  counts.push(`${[...new Set(selected.map(p => p.meta.camera))].filter(c => c !== 'Unknown').length} sources`);
  $('#photoCount').textContent = counts.join(' \u00b7 ');
}

function escapeHtml(t) {
  const d = document.createElement('div');
  d.textContent = t;
  return d.innerHTML;
}

// ===================== PHOTO GRID =====================
function renderPhotoGrid() {
  const grid = $('#photoGrid');
  grid.innerHTML = '';

  state.photos.forEach(photo => {
    const div = document.createElement('div');
    div.className = `photo-card ${state.selected.has(photo.id) ? 'selected' : ''}`;
    div.onclick = () => togglePhoto(photo.id);

    const thumb = photo.thumb
      ? `<img src="${photo.thumb}" alt="">`
      : (photo.type === 'video' ? '<div class="placeholder">\ud83c\udfa5</div>' : '<div class="placeholder">\ud83d\udcf7</div>');

    const camColor = photo.meta.cameraMake === 'Leica' ? 'var(--gold)' : photo.meta.cameraMake === 'Fujifilm' ? 'var(--brown)' : 'var(--text2)';

    // Video badge
    const videoBadge = photo.type === 'video'
      ? '<div class="video-badge">\u25b6</div>'
      : '';

    // Show different info for videos vs photos
    const metaLines = photo.type === 'video'
      ? `<div class="photo-meta" style="color: var(--moss);">${escapeHtml(photo.meta.camera)}</div>
         <div class="photo-meta">${photo.size} \u00b7 ${photo.meta.date || 'No date'}</div>`
      : `<div class="photo-meta" style="color: ${camColor};">${escapeHtml(photo.meta.camera)}</div>
         <div class="photo-meta">${photo.meta.focalLength} ${photo.meta.aperture} \u00b7 ISO ${photo.meta.iso}</div>
         <div class="photo-meta">${photo.meta.date || 'No date'} \u00b7 SC: ${photo.meta.shutterCount || '?'}</div>`;

    div.innerHTML = `
      <div class="photo-thumb">${thumb}${videoBadge}</div>
      <div class="photo-check">\u2713</div>
      <div class="photo-info">
        <div class="photo-name">${escapeHtml(photo.name)}</div>
        ${metaLines}
      </div>
    `;
    grid.appendChild(div);
  });
}

function togglePhoto(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  renderPhotoGrid();
  updateTreePreview();
  updateSelectedCount();
}

function selectAll() {
  state.selected = new Set(state.photos.map(p => p.id));
  renderPhotoGrid();
  updateTreePreview();
  updateSelectedCount();
}

function deselectAll() {
  state.selected.clear();
  renderPhotoGrid();
  updateTreePreview();
  updateSelectedCount();
}

function updateSelectedCount() {
  const selected = state.photos.filter(p => state.selected.has(p.id));
  const imgs = selected.filter(p => p.type === 'image').length;
  const vids = selected.filter(p => p.type === 'video').length;
  const parts = [`${selected.length} selected`];
  if (imgs) parts.push(`${imgs} photos`);
  if (vids) parts.push(`${vids} videos`);
  $('#selectedCount').textContent = parts.join(' \u00b7 ');
}

// ===================== ORGANIZE =====================
async function organize() {
  const selected = state.photos.filter(p => state.selected.has(p.id));
  if (!selected.length) { toast('No files selected', 'error'); return; }

  $('#bottomBar').classList.add('hidden');
  showStep('process');

  const zip = new JSZip();
  const project = state.projectName || 'Project';
  const total = selected.length;

  for (let i = 0; i < selected.length; i++) {
    const item = selected[i];
    updateProgress(Math.round((i / total) * 100), `Adding ${item.name}...`);

    // Build path (same logic for photos and videos)
    let path = project;
    if (state.primary === 'date' && item.meta.date) {
      path += `/${item.meta.date}`;
      if (state.secondary === 'camera' && item.meta.camera !== 'Unknown') {
        path += `/${sanitize(item.meta.camera)}`;
      }
    } else if (state.primary === 'camera' && item.meta.camera !== 'Unknown') {
      path += `/${sanitize(item.meta.camera)}`;
      if (state.secondary === 'date' && item.meta.date) {
        path += `/${item.meta.date}`;
      }
    } else if (state.primary === 'location' && item.meta.gps) {
      path += `/${item.meta.gps.replace(/[,\s]/g, '_')}`;
    }

    const folder = zip.folder(path);
    const blob = await item.file.arrayBuffer();
    folder.file(item.name, blob);

    await new Promise(r => setTimeout(r, 10));
  }

  updateProgress(100, 'Creating ZIP file...');
  const content = await zip.generateAsync({ type: 'blob' });

  // Save project to history
  const imgCount = selected.filter(p => p.type === 'image').length;
  const vidCount = selected.filter(p => p.type === 'video').length;
  const projectEntry = {
    id: Date.now().toString(),
    name: project,
    date: new Date().toISOString().slice(0, 10),
    photos: imgCount,
    videos: vidCount,
    cameras: [...new Set(selected.map(p => p.meta.camera).filter(c => c !== 'Unknown'))],
    days: [...new Set(selected.map(p => p.meta.date).filter(d => d))].length,
  };
  state.projects.unshift(projectEntry);
  if (state.projects.length > 20) state.projects = state.projects.slice(0, 20);

  saveState();

  // Show done
  showStep('done');
  const parts = [`${imgCount} photos`, `${vidCount} videos`];
  $('#doneText').textContent = `${parts.join(' and ')} organized into "${project}" and ready for export.`;

  // Setup download
  const safeName = sanitize(project).replace(/\s+/g, '_') + '.zip';
  $('#downloadBtn').onclick = () => {
    saveAs(content, safeName);
    toast('ZIP downloaded! Open in Files app to save to cloud.', 'success');
  };

  toast('Organization complete!', 'success');
}

function sanitize(name) {
  return name.replace(/[<>"/\\|?*]/g, '_').replace(/\.{2,}/g, '.').trim().slice(0, 100) || 'Unknown';
}

// ===================== STEPS =====================
function showStep(step) {
  state.step = step;
  ['select', 'config', 'process', 'done'].forEach(s => {
    $(`#step-${s}`).classList.toggle('hidden', s !== step);
  });
  $('#bottomBar').classList.toggle('hidden', step !== 'config');
}

function updateProgress(pct, text) {
  $('#processBar').style.width = pct + '%';
  $('#processText').textContent = text;
}

function reset() {
  state.photos = [];
  state.selected.clear();
  state.step = 'select';
  $('#photoInput').value = '';
  showStep('select');
  $('#bottomBar').classList.add('hidden');
}

// ===================== DASHBOARD =====================
function renderDashboard() {
  const totalFiles = state.projects.reduce((a, p) => a + (p.photos || 0) + (p.videos || 0), 0);
  const totalVideos = state.projects.reduce((a, p) => a + (p.videos || 0), 0);
  const thisMonth = state.projects
    .filter(p => p.date.startsWith(new Date().toISOString().slice(0, 7)))
    .reduce((a, p) => a + (p.photos || 0) + (p.videos || 0), 0);

  $('#dashPhotos').textContent = totalFiles.toLocaleString();
  $('#dashVideos').textContent = totalVideos.toLocaleString();
  $('#dashCameras').textContent = state.cameras.length;
  $('#dashProjects').textContent = state.projects.length;

  // Cameras
  const camList = $('#cameraList');
  camList.innerHTML = '';
  if (!state.cameras.length) {
    camList.innerHTML = '<div style="text-align:center; padding:30px; color: var(--text2); font-size:13px;">No cameras detected yet. Import photos to see your gear.</div>';
  } else {
    state.cameras.forEach(cam => {
      const wearPct = Math.min(100, Math.round((cam.shutterCount / 150000) * 100));
      const wearColor = cam.shutterCount > 120000 ? 'var(--vermilion)' : cam.shutterCount > 80000 ? 'var(--wood)' : 'var(--moss)';

      const div = document.createElement('div');
      div.className = 'camera-card';
      div.innerHTML = `
        <div class="camera-header">
          <div class="camera-icon" style="background: ${cam.color}15; color: ${cam.color};">\ud83d\udcf7</div>
          <div style="flex:1; min-width:0;">
            <div class="camera-name">${escapeHtml(cam.nickname || cam.model)}</div>
            <div class="camera-model">${escapeHtml(cam.model)} \u00b7 ${cam.id.slice(0, 8)}...</div>
          </div>
        </div>
        <div class="camera-stats">
          <div class="camera-stat">
            <div class="camera-stat-val" style="color: ${cam.color};">${cam.shutterCount.toLocaleString()}</div>
            <div class="camera-stat-label">Shutter</div>
          </div>
          <div class="camera-stat">
            <div class="camera-stat-val" style="color: var(--text);">${cam.importedFiles.toLocaleString()}</div>
            <div class="camera-stat-label">Files</div>
          </div>
          <div class="camera-stat">
            <div class="camera-stat-val" style="color: ${wearColor};">${wearPct}%</div>
            <div class="camera-stat-label">Wear</div>
          </div>
        </div>
        <div class="wear-bar"><div class="wear-fill" style="width: ${wearPct}%; background: ${wearColor};"></div></div>
        <div style="margin-top: 8px;">
          <input type="text" placeholder="Nickname..." value="${escapeHtml(cam.nickname)}"
            style="font-size: 12px; padding: 6px 10px;"
            onchange="app.setNickname('${cam.id}', this.value)">
        </div>
      `;
      camList.appendChild(div);
    });
  }

  // Projects
  const projList = $('#projectList');
  projList.innerHTML = '';
  if (!state.projects.length) {
    projList.innerHTML = '<div style="text-align:center; padding:30px; color: var(--text2); font-size:13px;">No projects yet.</div>';
  } else {
    state.projects.slice(0, 10).forEach(proj => {
      const div = document.createElement('div');
      div.className = 'project-card';
      const parts = [];
      parts.push(`\ud83d\udcc5 ${proj.date}`);
      if (proj.photos) parts.push(`\ud83d\uddbc ${proj.photos} photos`);
      if (proj.videos) parts.push(`\ud83c\udfa5 ${proj.videos} videos`);
      parts.push(`\ud83d\udcc6 ${proj.days} day${proj.days > 1 ? 's' : ''}`);

      div.innerHTML = `
        <div class="project-name">${escapeHtml(proj.name)}</div>
        <div class="project-meta">
          ${parts.map(p => `<span>${p}</span>`).join('')}
        </div>
        <div class="project-tags">
          ${proj.cameras.map(c => `<span class="tag ${c.includes('Leica') ? 'tag-leica' : c.includes('Fuji') ? 'tag-fuji' : 'tag-indigo'}">${escapeHtml(c)}</span>`).join('')}
          <span class="tag tag-indigo">date/camera</span>
        </div>
      `;
      projList.appendChild(div);
    });
  }
}

function setNickname(id, nick) {
  const cam = state.cameras.find(c => c.id === id);
  if (cam) { cam.nickname = nick; saveState(); renderDashboard(); toast('Nickname saved', 'success'); }
}

// ===================== SETTINGS =====================
function setupPresets() {
  const list = $('#presetList');
  list.innerHTML = '';
  Object.entries(PRESETS).forEach(([key, preset]) => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary btn-block';
    btn.style.marginBottom = '8px';
    btn.style.textAlign = 'left';
    btn.style.justifyContent = 'flex-start';
    btn.innerHTML = `<span style="flex:1;"><strong>${preset.name}</strong><br><span style="font-size:11px; color: var(--text2);">${preset.primary} / ${preset.secondary}</span></span>`;
    btn.onclick = () => {
      state.primary = preset.primary;
      state.secondary = preset.secondary;
      $('#primaryGroup').value = preset.primary;
      $('#secondaryGroup').value = preset.secondary;
      $('#defaultPrimary').value = preset.primary;
      $('#defaultSecondary').value = preset.secondary;
      updateTreePreview();
      updatePresetBadge();
      saveState();
      toast(`Preset: ${preset.name}`, 'success');
    };
    list.appendChild(btn);
  });
}

// ===================== STORAGE =====================
function saveState() {
  try {
    localStorage.setItem('photoOrg_cameras', JSON.stringify(state.cameras));
    localStorage.setItem('photoOrg_projects', JSON.stringify(state.projects));
    localStorage.setItem('photoOrg_primary', state.primary);
    localStorage.setItem('photoOrg_secondary', state.secondary);
  } catch (e) { /* ignore */ }
}

function loadState() {
  try {
    const cams = localStorage.getItem('photoOrg_cameras');
    if (cams) state.cameras = JSON.parse(cams);
    const projs = localStorage.getItem('photoOrg_projects');
    if (projs) {
      const parsed = JSON.parse(projs);
      // Migrate old projects without video count
      state.projects = parsed.map(p => ({
        ...p,
        photos: p.photos || 0,
        videos: p.videos || 0,
      }));
    }
    const prim = localStorage.getItem('photoOrg_primary');
    if (prim) { state.primary = prim; $('#primaryGroup').value = prim; $('#defaultPrimary').value = prim; }
    const sec = localStorage.getItem('photoOrg_secondary');
    if (sec) { state.secondary = sec; $('#secondaryGroup').value = sec; $('#defaultSecondary').value = sec; }
  } catch (e) { /* ignore */ }
}

// ===================== UTILS =====================
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function toast(message, type = 'info') {
  const container = $('#toastContainer');
  const div = document.createElement('div');
  div.className = `toast ${type}`;
  div.textContent = message;
  container.appendChild(div);
  setTimeout(() => div.remove(), 3000);
}

// ===================== APP NAMESPACE =====================
const app = {
  selectAll, deselectAll, organize, reset, setNickname,
};
window.app = app;

// ===================== START =====================
document.addEventListener('DOMContentLoaded', init);
