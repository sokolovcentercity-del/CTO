// FILE_MARKER: ACTMEDIA-20260626-1528-v3

const PHOTO_TARGET_BYTES = 160 * 1024;
const PHOTO_MAX_BYTES = 200 * 1024;
const PHOTO_MAX_DIMENSION = 1600;
const PHOTO_MIN_QUALITY = 0.45;

const VIDEO_TARGET_BYTES = 3 * 1024 * 1024;
const VIDEO_MAX_BYTES = 5 * 1024 * 1024;
const VIDEO_MAX_DIMENSION = 960;
const VIDEO_FPS = 24;
const VIDEO_MIN_BITRATE = 450_000;
const VIDEO_MAX_BITRATE = 1_200_000;
const VIDEO_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

const DEFAULT_API_BASE = 'https://mto-cto.falcon28.ru/api/';

function getApiBase() {
  return DEFAULT_API_BASE;
}

function buildApiUrl(params) {
  const url = new URL(getApiBase());
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });
  return url.toString();
}

async function parseJsonSafe(response) {
  const raw = await response.text();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(raw || `HTTP ${response.status}`);
  }
}

function sanitizeBaseName(name, fallback = 'file') {
  const raw = String(name || '').trim().replace(/\.[^.]+$/, '');
  const safe = raw.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  return safe || fallback;
}

function isGenericUploadName(name) {
  const value = String(name || '').trim().toLowerCase();
  return !value || ['file', 'blob', 'image', 'photo', 'video', 'attachment'].includes(value);
}

function buildUploadName(preparedFile, originalFile, kind) {
  const preparedName = String(preparedFile?.name || '').trim();
  const originalName = String(originalFile?.name || '').trim();

  if (preparedName && !isGenericUploadName(preparedName)) return preparedName;
  if (originalName && !isGenericUploadName(originalName)) return originalName;

  if (kind === 'photo') return 'photo.jpg';
  if (kind === 'video') return 'video.webm';
  return 'file';
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(blob);
  });
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Не удалось открыть изображение'));
    img.src = src;
  });
}

async function drawImageToCanvas(file, maxDimension = PHOTO_MAX_DIMENSION) {
  const dataUrl = await readBlobAsDataUrl(file);
  const img = await loadImageElement(dataUrl);
  const canvas = document.createElement('canvas');

  let { width, height } = img;
  const largest = Math.max(width, height);
  if (largest > maxDimension) {
    const scale = maxDimension / largest;
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }

  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return canvas;
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Не удалось сжать изображение'));
      },
      'image/jpeg',
      quality,
    );
  });
}

async function compressPhotoFile(file) {
  if (!(file instanceof File)) return file;
  if (!String(file.type || '').startsWith('image/')) return file;
  if (file.size <= PHOTO_TARGET_BYTES) return file;

  try {
    let maxDimension = PHOTO_MAX_DIMENSION;
    let bestBlob = null;

    for (let scaleStep = 0; scaleStep < 4; scaleStep += 1) {
      const canvas = await drawImageToCanvas(file, maxDimension);

      for (const quality of [0.82, 0.74, 0.68, 0.6, PHOTO_MIN_QUALITY]) {
        const blob = await canvasToBlob(canvas, quality);
        if (!bestBlob || blob.size < bestBlob.size) bestBlob = blob;
        if (blob.size <= PHOTO_TARGET_BYTES) {
          bestBlob = blob;
          break;
        }
      }

      if (bestBlob && bestBlob.size <= PHOTO_MAX_BYTES) break;
      maxDimension = Math.max(900, Math.round(maxDimension * 0.82));
    }

    if (!bestBlob || bestBlob.size >= file.size) return file;

    const compressedName = `${sanitizeBaseName(file.name, 'photo')}.jpg`;
    return new File([bestBlob], compressedName, {
      type: 'image/jpeg',
      lastModified: Date.now(),
    });
  } catch (err) {
    console.warn('photo compression skipped:', err);
    return file;
  }
}

function pickSupportedVideoMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  return VIDEO_MIME_CANDIDATES.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function getScaledVideoSize(video) {
  let width = Number(video.videoWidth || 0);
  let height = Number(video.videoHeight || 0);
  if (!width || !height) return { width: 0, height: 0 };

  const largest = Math.max(width, height);
  if (largest > VIDEO_MAX_DIMENSION) {
    const scale = VIDEO_MAX_DIMENSION / largest;
    width = Math.max(2, Math.round(width * scale));
    height = Math.max(2, Math.round(height * scale));
  }

  width = width % 2 === 0 ? width : width - 1;
  height = height % 2 === 0 ? height : height - 1;
  return { width: Math.max(2, width), height: Math.max(2, height) };
}

function loadVideoElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.src = url;

    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    };

    video.onloadedmetadata = () => resolve({ video, cleanup });
    video.onerror = () => {
      cleanup();
      reject(new Error('Не удалось открыть видео'));
    };
  });
}

async function attachVideoAudioTrack(video, stream) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;

  try {
    const audioContext = new AudioCtx();
    const source = audioContext.createMediaElementSource(video);
    const destination = audioContext.createMediaStreamDestination();
    source.connect(destination);
    const [track] = destination.stream.getAudioTracks();
    if (track) stream.addTrack(track);
    return { audioContext, source, destination };
  } catch (err) {
    console.warn('video audio track attach skipped:', err);
    return null;
  }
}

async function compressVideoFile(file) {
  if (!(file instanceof File)) return file;
  if (!String(file.type || '').startsWith('video/')) return file;
  if (file.size <= VIDEO_TARGET_BYTES) return file;
  if (typeof MediaRecorder === 'undefined') return file;

  const mimeType = pickSupportedVideoMimeType();
  if (!mimeType) return file;

  let loaded = null;
  let audioBundle = null;
  let animationFrameId = 0;

  try {
    loaded = await loadVideoElement(file);
    const { video } = loaded;
    const { width, height } = getScaledVideoSize(video);
    if (!width || !height || !Number.isFinite(video.duration) || video.duration <= 0) {
      return file;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return file;

    const stream = canvas.captureStream(VIDEO_FPS);
    audioBundle = await attachVideoAudioTrack(video, stream);

    const targetBitrate = Math.max(
      VIDEO_MIN_BITRATE,
      Math.min(VIDEO_MAX_BITRATE, Math.round((VIDEO_TARGET_BYTES * 8) / Math.max(video.duration, 1))),
    );

    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: targetBitrate,
    });

    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };

    const stopPromise = new Promise((resolve, reject) => {
      recorder.onerror = () => reject(recorder.error || new Error('Не удалось сжать видео'));
      recorder.onstop = () => resolve();
    });

    const drawFrame = () => {
      if (video.paused || video.ended) return;
      ctx.drawImage(video, 0, 0, width, height);
      animationFrameId = requestAnimationFrame(drawFrame);
    };

    recorder.start(1000);
    const playResult = video.play();
    if (playResult && typeof playResult.then === 'function') {
      await playResult;
    }
    drawFrame();

    await new Promise((resolve) => {
      video.onended = () => resolve();
    });

    cancelAnimationFrame(animationFrameId);
    if (recorder.state !== 'inactive') recorder.stop();
    await stopPromise;

    const blob = new Blob(chunks, { type: mimeType });
    if (!blob.size || blob.size >= file.size) return file;
    if (blob.size > VIDEO_MAX_BYTES) return file;

    const compressedName = `${sanitizeBaseName(file.name, 'video')}.webm`;
    return new File([blob], compressedName, {
      type: blob.type || 'video/webm',
      lastModified: Date.now(),
    });
  } catch (err) {
    console.warn('video compression skipped:', err);
    return file;
  } finally {
    cancelAnimationFrame(animationFrameId);
    if (loaded?.video) {
      try { loaded.video.pause(); } catch {}
    }
    if (audioBundle?.audioContext) {
      try { await audioBundle.audioContext.close(); } catch {}
    }
    loaded?.cleanup?.();
  }
}

async function prepareActMediaFile(file, kind) {
  if (kind === 'photo') return compressPhotoFile(file);
  if (kind === 'video') return compressVideoFile(file);
  return file;
}

function buildLocalMediaRecord(file, uploadName, kind) {
  return readBlobAsDataUrl(file).then((dataUrl) => ({
    id: `local_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`,
    kind,
    originalName: uploadName,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size || 0,
    uploadedAt: new Date().toISOString(),
    dataUrl,
    storageMode: 'local',
  }));
}

export function getActMediaPreviewUrl(media) {
  if (media?.dataUrl) return media.dataUrl;
  if (media?.id) return buildApiUrl({ action: 'download_act_media', id: media.id });
  return '';
}

export function getActMediaDownloadUrl(media) {
  if (media?.dataUrl) return media.dataUrl;
  if (media?.id) return buildApiUrl({ action: 'download_act_media', id: media.id, download: 1 });
  return '';
}

export async function uploadActMedia(file, kind = 'attachment') {
  const preparedFile = await prepareActMediaFile(file, kind);
  const uploadName = buildUploadName(preparedFile, file, kind);
  return buildLocalMediaRecord(preparedFile, uploadName, kind);
}

export async function deleteActMedia(mediaId) {
  if (!mediaId || String(mediaId).startsWith('local_')) {
    return { ok: true, local: true };
  }

  const response = await fetch(buildApiUrl({ action: 'delete_act_media' }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: mediaId }),
  });

  const data = await parseJsonSafe(response);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data;
}
