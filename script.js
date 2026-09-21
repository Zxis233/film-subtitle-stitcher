const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const els = {
  fileInput: $("#fileInput"),
  downloadBtn: $("#downloadBtn"),
  projectMeta: $("#projectMeta"),
  canvasMeta: $("#canvasMeta"),
  previewCanvas: $("#previewCanvas"),
  outputError: $("#outputError"),
  emptyState: $("#emptyState"),
  dropZone: $("#dropZone"),
  timeline: $("#timeline"),
  timelineMeta: $("#timelineMeta"),
  firstCropBottom: $("#firstCropBottom"),
  firstCropBottomNum: $("#firstCropBottomNum"),
  cropTop: $("#cropTop"),
  cropTopNum: $("#cropTopNum"),
  cropBottom: $("#cropBottom"),
  cropBottomNum: $("#cropBottomNum"),
  cropReadout: $("#cropReadout"),
  useBottomPreset: $("#useBottomPreset"),
  gapSize: $("#gapSize"),
  watermarkEnabled: $("#watermarkEnabled"),
  watermarkOptions: $("#watermarkOptions"),
  watermarkText: $("#watermarkText"),
  watermarkFont: $("#watermarkFont"),
  customFontName: $("#customFontName"),
  addCustomFont: $("#addCustomFont"),
  watermarkSize: $("#watermarkSize"),
  colorR: $("#colorR"),
  colorG: $("#colorG"),
  colorB: $("#colorB"),
  colorA: $("#colorA"),
  positionGrid: $("#positionGrid"),
  watermarkOffsetX: $("#watermarkOffsetX"),
  watermarkOffsetY: $("#watermarkOffsetY"),
  autoSize: $("#autoSize"),
  outputWidth: $("#outputWidth"),
  outputHeight: $("#outputHeight"),
  lockRatio: $("#lockRatio"),
  outputFormat: $("#outputFormat"),
  outputQuality: $("#outputQuality"),
};

const state = {
  images: [],
  firstCropBottom: 100,
  cropTop: 70,
  cropBottom: 96,
  direction: "vertical",
  gapSize: 0,
  rawSize: { width: 0, height: 0 },
  watermark: {
    enabled: false,
    text: "film subtitle cut",
    font: "Arial, Helvetica, sans-serif",
    size: 28,
    r: 255,
    g: 255,
    b: 255,
    a: 0.72,
    position: "bottom-right",
    offsetX: 24,
    offsetY: 24,
  },
  autoSize: true,
  lockRatio: true,
  format: "image/png",
  quality: 0.92,
};

let dragImageId = null;
let renderFrame = 0;
let idCounter = 0;
const CUSTOM_FONTS_KEY = "filmsubcut.customFonts";
// Application budgets, not guarantees of available browser/device memory.
// Allow for the RGBA canvas plus two working copies during rendering/export.
const OUTPUT_LIMITS = Object.freeze({
  maxSide: 16384,
  maxPixels: 16000000,
  maxWorkingBytes: 192 * 1024 * 1024,
  bytesPerPixel: 12,
});
let exportInProgress = false;
let importQueue = Promise.resolve();
const PREVIEW_LIMITS = Object.freeze({ maxSide: 2048, maxPixels: 2000000 });

function getOutputSizeError({ width, height }) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    return "输出尺寸无效，请输入有效的正整数宽高。";
  }
  const pixels = width * height;
  const preview = getPreviewSize({ width, height });
  const estimatedBytes = pixels * OUTPUT_LIMITS.bytesPerPixel + preview.width * preview.height * 4;
  if (width > OUTPUT_LIMITS.maxSide || height > OUTPUT_LIMITS.maxSide ||
    pixels > OUTPUT_LIMITS.maxPixels || estimatedBytes > OUTPUT_LIMITS.maxWorkingBytes) {
    return `输出尺寸 ${width} × ${height} 超出安全限制：单边最多 16384 像素、总计最多 1600 万像素。请关闭自动尺寸并减小宽高，或减少图片数量。`;
  }
  return "";
}

function showOutputError(message) {
  // Release the previous backing store and prevent exporting a stale preview.
  els.previewCanvas.width = 0;
  els.previewCanvas.height = 0;
  els.previewCanvas.classList.remove("visible");
  els.emptyState.classList.add("hidden");
  els.outputError.textContent = message;
  els.outputError.classList.remove("hidden");
  els.downloadBtn.disabled = true;
  els.canvasMeta.textContent = "无法生成预览";
  updateMeta();
  return false;
}

function makeId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  idCounter += 1;
  return `img-${Date.now()}-${idCounter}`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function readNumber(input, fallback) {
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionForMime(mime) {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "png";
}

function normalizeFontName(name) {
  return name.trim().replace(/\s+/g, " ");
}

function fontValueForName(name) {
  const escapedName = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escapedName}", sans-serif`;
}

function getStoredCustomFonts() {
  try {
    const fonts = JSON.parse(localStorage.getItem(CUSTOM_FONTS_KEY) || "[]");
    return Array.isArray(fonts) ? fonts.map(normalizeFontName).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function saveStoredCustomFonts(fonts) {
  try {
    localStorage.setItem(CUSTOM_FONTS_KEY, JSON.stringify(fonts));
  } catch {
    // The font is still available for this page session if storage is blocked.
  }
}

function addCustomFontOption(name, { persist = false, select = false } = {}) {
  const normalizedName = normalizeFontName(name);
  if (!normalizedName) return false;

  const existing = Array.from(els.watermarkFont.options).find((option) => {
    const optionName = option.dataset.fontName || option.textContent;
    return normalizeFontName(optionName).toLowerCase() === normalizedName.toLowerCase();
  });

  if (existing) {
    if (select) els.watermarkFont.value = existing.value;
    return false;
  }

  const option = document.createElement("option");
  option.value = fontValueForName(normalizedName);
  option.textContent = `自定义：${normalizedName}`;
  option.dataset.customFont = "true";
  option.dataset.fontName = normalizedName;
  els.watermarkFont.appendChild(option);

  if (select) els.watermarkFont.value = option.value;
  if (persist) {
    const fonts = getStoredCustomFonts();
    const hasFont = fonts.some((font) => font.toLowerCase() === normalizedName.toLowerCase());
    if (!hasFont) saveStoredCustomFonts([...fonts, normalizedName]);
  }

  return true;
}

function loadCustomFonts() {
  getStoredCustomFonts().forEach((font) => addCustomFontOption(font));
}

function addCustomFontFromInput() {
  const name = normalizeFontName(els.customFontName.value);
  if (!name) return;

  addCustomFontOption(name, { persist: true, select: true });
  els.customFontName.value = "";
  scheduleRender();
}

function updateCropInputs() {
  state.firstCropBottom = clamp(state.firstCropBottom, 1, 100);
  state.cropTop = clamp(state.cropTop, 0, 99);
  state.cropBottom = clamp(state.cropBottom, 1, 100);
  if (state.cropBottom <= state.cropTop) {
    state.cropBottom = Math.min(100, state.cropTop + 1);
  }

  const firstBottom = Number(state.firstCropBottom.toFixed(1));
  const top = Number(state.cropTop.toFixed(1));
  const bottom = Number(state.cropBottom.toFixed(1));
  els.firstCropBottom.value = firstBottom;
  els.firstCropBottomNum.value = firstBottom;
  els.cropTop.value = top;
  els.cropTopNum.value = top;
  els.cropBottom.value = bottom;
  els.cropBottomNum.value = bottom;

  const first = state.images[0];
  const firstText = first
    ? `首张保留到 ${firstBottom}%（约 ${Math.round((first.height * state.firstCropBottom) / 100)}px）`
    : `首张保留到 ${firstBottom}%`;
  const reference = state.images[1];
  if (reference) {
    const y1 = Math.round((reference.height * state.cropTop) / 100);
    const y2 = Math.round((reference.height * state.cropBottom) / 100);
    els.cropReadout.textContent = `${firstText} · 后续字幕带：${top}% - ${bottom}%（第 2 张约 ${y1}px - ${y2}px）`;
  } else if (state.images.length === 1) {
    els.cropReadout.textContent = `${firstText} · 当前只有首张`;
  } else {
    els.cropReadout.textContent = `${firstText} · 后续图片字幕带：${top}% - ${bottom}%`;
  }
}

function updateSizeControls() {
  const disabled = state.autoSize;
  els.outputWidth.disabled = disabled;
  els.outputHeight.disabled = disabled;
  els.lockRatio.disabled = disabled;

  if (state.rawSize.width && state.rawSize.height) {
    if (disabled) {
      els.outputWidth.value = state.rawSize.width;
      els.outputHeight.value = state.rawSize.height;
    } else {
      if (!els.outputWidth.value) els.outputWidth.value = state.rawSize.width;
      if (!els.outputHeight.value) els.outputHeight.value = state.rawSize.height;
    }
  }
}

function updateFormatControls() {
  els.outputQuality.disabled = state.format === "image/png";
}

function updateWatermarkOptions() {
  els.watermarkOptions.hidden = !state.watermark.enabled;
}

function syncStateFromControls() {
  state.gapSize = Math.round(clamp(readNumber(els.gapSize, 0), 0, 200));
  state.watermark.enabled = els.watermarkEnabled.checked;
  updateWatermarkOptions();
  state.watermark.text = els.watermarkText.value;
  state.watermark.font = els.watermarkFont.value;
  state.watermark.size = Math.round(clamp(readNumber(els.watermarkSize, 28), 8, 160));
  state.watermark.r = Math.round(clamp(readNumber(els.colorR, 255), 0, 255));
  state.watermark.g = Math.round(clamp(readNumber(els.colorG, 255), 0, 255));
  state.watermark.b = Math.round(clamp(readNumber(els.colorB, 255), 0, 255));
  state.watermark.a = clamp(readNumber(els.colorA, 0.72), 0, 1);
  state.watermark.offsetX = Math.round(clamp(readNumber(els.watermarkOffsetX, 24), 0, 1000));
  state.watermark.offsetY = Math.round(clamp(readNumber(els.watermarkOffsetY, 24), 0, 1000));
  state.autoSize = els.autoSize.checked;
  state.lockRatio = els.lockRatio.checked;
  state.format = els.outputFormat.value;
  state.quality = clamp(readNumber(els.outputQuality, 0.92), 0.1, 1);
}

function scheduleRender() {
  if (renderFrame) cancelAnimationFrame(renderFrame);
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    syncStateFromControls();
    renderComposite();
  });
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      resolve({
        id: makeId(),
        name: file.name,
        size: file.size,
        url,
        img,
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`无法读取图片：${file.name}`));
    };

    img.src = url;
  });
}

function addFiles(fileList) {
  const files = Array.from(fileList).filter((file) => file.type.startsWith("image/"));
  // Snapshot FileList before clearing the input; queue batches in invocation order.
  els.fileInput.value = "";
  if (!files.length) return;
  const batch = importQueue.then(() => importFiles(files));
  importQueue = batch.catch(() => {});
  return batch;
}

async function importFiles(files) {
  els.projectMeta.textContent = "正在读取图片...";
  try {
    const results = await Promise.allSettled(files.map(loadImageFile));
    const loaded = [];
    const failedNames = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        loaded.push(result.value);
      } else {
        failedNames.push(files[index].name);
      }
    });

    if (loaded.length) {
      state.images.push(...loaded);
      renderTimeline();
      scheduleRender();
    } else {
      updateMeta();
    }

    if (failedNames.length) {
      window.alert(`成功导入 ${loaded.length} 张，失败 ${failedNames.length} 张。以下图片无法读取：\n${failedNames.join("\n")}`);
    }
  } catch (error) {
    window.alert(error.message);
    updateMeta();
  }
}

function removeImage(id) {
  const index = state.images.findIndex((item) => item.id === id);
  if (index === -1) return;
  const [removed] = state.images.splice(index, 1);
  URL.revokeObjectURL(removed.url);
  renderTimeline();
  scheduleRender();
}

function moveImage(id, delta) {
  const index = state.images.findIndex((item) => item.id === id);
  const nextIndex = index + delta;
  if (index === -1 || nextIndex < 0 || nextIndex >= state.images.length) return;
  const [item] = state.images.splice(index, 1);
  state.images.splice(nextIndex, 0, item);
  renderTimeline();
  scheduleRender();
}

function reorderImage(id, targetIndex) {
  const fromIndex = state.images.findIndex((item) => item.id === id);
  if (fromIndex === -1) return;
  const [item] = state.images.splice(fromIndex, 1);
  const normalizedIndex = fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
  state.images.splice(clamp(normalizedIndex, 0, state.images.length), 0, item);
  renderTimeline();
  scheduleRender();
}

function renderTimeline() {
  els.timeline.innerHTML = "";

  state.images.forEach((item, index) => {
    const thumb = document.createElement("article");
    thumb.className = "thumb";
    thumb.draggable = true;
    thumb.dataset.id = item.id;

    const image = document.createElement("img");
    image.src = item.url;
    image.alt = item.name;

    const name = document.createElement("div");
    name.className = "thumb-name";
    name.title = item.name;
    name.textContent = `${index + 1}. ${item.name}`;

    const meta = document.createElement("div");
    meta.className = "thumb-meta";
    const firstMode = state.firstCropBottom >= 100 ? "完整" : `保留 ${Number(state.firstCropBottom.toFixed(1))}%`;
    const modeLabel = index === 0 ? firstMode : "裁剪";
    meta.textContent = `${item.width}x${item.height} · ${modeLabel} · ${formatBytes(item.size)}`;

    const actions = document.createElement("div");
    actions.className = "thumb-actions";
    actions.innerHTML = `
      <button type="button" data-action="left" aria-label="前移">←</button>
      <button type="button" data-action="right" aria-label="后移">→</button>
      <button type="button" data-action="remove" aria-label="删除">×</button>
    `;

    thumb.append(image, name, meta, actions);
    els.timeline.appendChild(thumb);
  });

  updateMeta();
}

function computeSlices() {
  return state.images.map((item, index) => {
    if (index === 0) {
      const sh = clamp(Math.round((item.height * state.firstCropBottom) / 100), 1, item.height);
      return {
        item,
        sx: 0,
        sy: 0,
        sw: item.width,
        sh,
      };
    }

    const y1 = Math.round((item.height * state.cropTop) / 100);
    const y2 = Math.round((item.height * state.cropBottom) / 100);
    const sy = clamp(y1, 0, item.height - 1);
    const sh = clamp(y2 - y1, 1, item.height - sy);
    return {
      item,
      sx: 0,
      sy,
      sw: item.width,
      sh,
    };
  });
}

function measureRawSize(slices) {
  if (!slices.length) return { width: 0, height: 0 };
  const gapTotal = state.gapSize * Math.max(0, slices.length - 1);

  if (state.direction === "horizontal") {
    return {
      width: slices.reduce((sum, slice) => sum + slice.sw, 0) + gapTotal,
      height: Math.max(...slices.map((slice) => slice.sh)),
    };
  }

  return {
    width: Math.max(...slices.map((slice) => slice.sw)),
    height: slices.reduce((sum, slice) => sum + slice.sh, 0) + gapTotal,
  };
}

function resolveOutputSize(rawSize) {
  if (!rawSize.width || !rawSize.height) return { width: 0, height: 0 };
  if (state.autoSize) return rawSize;

  let width = Math.round(readNumber(els.outputWidth, rawSize.width));
  let height = Math.round(readNumber(els.outputHeight, rawSize.height));

  if (state.lockRatio) {
    const aspect = rawSize.width / rawSize.height;
    if (document.activeElement === els.outputHeight) {
      width = Math.max(1, Math.round(height * aspect));
      els.outputWidth.value = width;
    } else {
      height = Math.max(1, Math.round(width / aspect));
      els.outputHeight.value = height;
    }
  }

  return { width, height };
}

function drawSlices(ctx, slices, rawSize, outputSize) {
  const scaleX = outputSize.width / rawSize.width;
  const scaleY = outputSize.height / rawSize.height;
  let cursor = 0;

  for (const slice of slices) {
    if (state.direction === "horizontal") {
      const rawX = cursor;
      const rawY = (rawSize.height - slice.sh) / 2;
      ctx.drawImage(
        slice.item.img,
        slice.sx,
        slice.sy,
        slice.sw,
        slice.sh,
        rawX * scaleX,
        rawY * scaleY,
        slice.sw * scaleX,
        slice.sh * scaleY,
      );
      cursor += slice.sw + state.gapSize;
    } else {
      const rawX = (rawSize.width - slice.sw) / 2;
      const rawY = cursor;
      ctx.drawImage(
        slice.item.img,
        slice.sx,
        slice.sy,
        slice.sw,
        slice.sh,
        rawX * scaleX,
        rawY * scaleY,
        slice.sw * scaleX,
        slice.sh * scaleY,
      );
      cursor += slice.sh + state.gapSize;
    }
  }
}

function drawWatermark(ctx, outputSize, rasterScale = 1) {
  const wm = state.watermark;
  const text = wm.text.trim();
  if (!wm.enabled || !text) return;

  const [vertical, horizontal] = wm.position.split("-");
  const x =
    horizontal === "left"
      ? wm.offsetX
      : horizontal === "right"
        ? outputSize.width - wm.offsetX
        : outputSize.width / 2 + wm.offsetX;
  const y =
    vertical === "top"
      ? wm.offsetY
      : vertical === "bottom"
        ? outputSize.height - wm.offsetY
        : outputSize.height / 2 + wm.offsetY;

  ctx.save();
  ctx.font = `700 ${wm.size}px ${wm.font}`;
  ctx.fillStyle = `rgba(${wm.r}, ${wm.g}, ${wm.b}, ${wm.a})`;
  ctx.textAlign = horizontal === "left" ? "left" : horizontal === "right" ? "right" : "center";
  ctx.textBaseline = vertical === "top" ? "top" : vertical === "bottom" ? "bottom" : "middle";
  ctx.shadowColor = "rgba(0, 0, 0, 0.36)";
  ctx.shadowBlur = Math.max(2, Math.round(wm.size / 8)) * rasterScale;
  ctx.shadowOffsetY = Math.max(1, Math.round(wm.size / 18)) * rasterScale;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function getPreviewSize({ width, height }) {
  const scale = Math.min(1, PREVIEW_LIMITS.maxSide / width, PREVIEW_LIMITS.maxSide / height,
    Math.sqrt(PREVIEW_LIMITS.maxPixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

function paintComposite(canvas, slices, rawSize, outputSize, rasterSize = outputSize) {
  canvas.width = 0;
  canvas.height = 0;
  canvas.width = rasterSize.width;
  canvas.height = rasterSize.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  const scaleX = rasterSize.width / outputSize.width;
  const scaleY = rasterSize.height / outputSize.height;
  ctx.scale(scaleX, scaleY);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, outputSize.width, outputSize.height);
  drawSlices(ctx, slices, rawSize, outputSize);
  drawWatermark(ctx, outputSize, Math.min(scaleX, scaleY));
}

function renderComposite() {
  updateCropInputs();
  updateFormatControls();

  const canvas = els.previewCanvas;
  els.outputError.classList.add("hidden");

  if (!state.images.length) {
    canvas.width = 0;
    canvas.height = 0;
    canvas.classList.remove("visible");
    els.emptyState.classList.remove("hidden");
    els.downloadBtn.disabled = true;
    els.canvasMeta.textContent = "等待导入";
    els.projectMeta.textContent = "未导入图片";
    els.timelineMeta.textContent = "0 张";
    return false;
  }

  const slices = computeSlices();
  const rawSize = measureRawSize(slices);
  state.rawSize = rawSize;
  updateSizeControls();

  const outputSize = resolveOutputSize(rawSize);
  const sizeError = getOutputSizeError(outputSize);
  if (sizeError) return showOutputError(sizeError);

  try {
    paintComposite(canvas, slices, rawSize, outputSize, getPreviewSize(outputSize));
  } catch {
    return showOutputError("浏览器无法绘制此尺寸的图片，请减小输出尺寸或减少图片数量。");
  }

  canvas.classList.add("visible");
  els.emptyState.classList.add("hidden");
  els.downloadBtn.disabled = exportInProgress;
  els.canvasMeta.textContent = `${outputSize.width}x${outputSize.height} · ${state.direction === "vertical" ? "纵向" : "横向"}`;
  updateMeta();
  return true;
}

function updateMeta() {
  const count = state.images.length;
  els.timelineMeta.textContent = `${count} 张`;
  if (!count) {
    els.projectMeta.textContent = "未导入图片";
    return;
  }

  const first = state.images[0];
  const sourceInfo = first ? `${first.width}x${first.height}` : "";
  els.projectMeta.textContent = `${count} 张图片 · 首张 ${sourceInfo}`;
}

function downloadCanvas() {
  if (!state.images.length || exportInProgress) return;
  syncStateFromControls();
  if (!renderComposite()) return;
  exportInProgress = true;
  els.downloadBtn.disabled = true;
  const exportCanvas = document.createElement("canvas");
  const finishExport = () => {
    exportCanvas.width = 0;
    exportCanvas.height = 0;
    exportInProgress = false;
    els.downloadBtn.disabled = !state.images.length || !els.outputError.classList.contains("hidden");
  };

  const mime = state.format;
  const quality = mime === "image/png" ? undefined : state.quality;
  try {
    const slices = computeSlices();
    const rawSize = measureRawSize(slices);
    const outputSize = resolveOutputSize(rawSize);
    const sizeError = getOutputSizeError(outputSize);
    if (sizeError) throw new Error(sizeError);
    paintComposite(exportCanvas, slices, rawSize, outputSize);
    exportCanvas.toBlob(
      (blob) => {
        finishExport();
        if (!blob) {
          window.alert("导出失败，可能是尺寸过大或可用内存不足。请减小输出尺寸或更换格式后重试。");
          return;
        }

        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        link.href = url;
        link.download = `subtitle-stitch-${stamp}.${extensionForMime(blob.type)}`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      },
      mime,
      quality,
    );
  } catch {
    finishExport();
    window.alert("导出失败，请减小输出尺寸或更换格式后重试。");
  }
}

function setCrop(top, bottom) {
  state.cropTop = top;
  state.cropBottom = bottom;
  updateCropInputs();
  scheduleRender();
}

function setFirstCropBottom(bottom) {
  state.firstCropBottom = bottom;
  updateCropInputs();
  renderTimeline();
  scheduleRender();
}

function setDirection(direction) {
  state.direction = direction;
  $$(".segment").forEach((button) => {
    button.classList.toggle("active", button.dataset.direction === direction);
  });
  els.outputWidth.value = "";
  els.outputHeight.value = "";
  scheduleRender();
}

function setWatermarkPosition(position) {
  state.watermark.position = position;
  $$("#positionGrid button").forEach((button) => {
    button.classList.toggle("active", button.dataset.pos === position);
  });
  scheduleRender();
}

function syncDimensionFromWidth() {
  if (!state.lockRatio || !state.rawSize.width || !state.rawSize.height) return;
  const width = readNumber(els.outputWidth, state.rawSize.width);
  els.outputHeight.value = Math.max(1, Math.round(width / (state.rawSize.width / state.rawSize.height)));
}

function syncDimensionFromHeight() {
  if (!state.lockRatio || !state.rawSize.width || !state.rawSize.height) return;
  const height = readNumber(els.outputHeight, state.rawSize.height);
  els.outputWidth.value = Math.max(1, Math.round(height * (state.rawSize.width / state.rawSize.height)));
}

els.fileInput.addEventListener("change", (event) => addFiles(event.target.files));
els.downloadBtn.addEventListener("click", downloadCanvas);
els.useBottomPreset.addEventListener("click", () => setCrop(72, 100));
els.addCustomFont.addEventListener("click", addCustomFontFromInput);
els.customFontName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addCustomFontFromInput();
  }
});

els.firstCropBottom.addEventListener("input", () =>
  setFirstCropBottom(readNumber(els.firstCropBottom, state.firstCropBottom)),
);
els.firstCropBottomNum.addEventListener("input", () =>
  setFirstCropBottom(readNumber(els.firstCropBottomNum, state.firstCropBottom)),
);
els.cropTop.addEventListener("input", () => setCrop(readNumber(els.cropTop, state.cropTop), state.cropBottom));
els.cropTopNum.addEventListener("input", () => setCrop(readNumber(els.cropTopNum, state.cropTop), state.cropBottom));
els.cropBottom.addEventListener("input", () => setCrop(state.cropTop, readNumber(els.cropBottom, state.cropBottom)));
els.cropBottomNum.addEventListener("input", () => setCrop(state.cropTop, readNumber(els.cropBottomNum, state.cropBottom)));

$$(".segment").forEach((button) => {
  button.addEventListener("click", () => setDirection(button.dataset.direction));
});

[
  els.gapSize,
  els.watermarkEnabled,
  els.watermarkText,
  els.watermarkFont,
  els.watermarkSize,
  els.colorR,
  els.colorG,
  els.colorB,
  els.colorA,
  els.watermarkOffsetX,
  els.watermarkOffsetY,
  els.outputFormat,
  els.outputQuality,
].forEach((control) => {
  control.addEventListener("input", scheduleRender);
  control.addEventListener("change", scheduleRender);
});

els.autoSize.addEventListener("change", () => {
  state.autoSize = els.autoSize.checked;
  if (!state.autoSize && state.rawSize.width && state.rawSize.height) {
    els.outputWidth.value = state.rawSize.width;
    els.outputHeight.value = state.rawSize.height;
  }
  updateSizeControls();
  scheduleRender();
});

els.lockRatio.addEventListener("change", () => {
  state.lockRatio = els.lockRatio.checked;
  syncDimensionFromWidth();
  scheduleRender();
});

els.outputWidth.addEventListener("input", () => {
  syncStateFromControls();
  syncDimensionFromWidth();
  scheduleRender();
});

els.outputHeight.addEventListener("input", () => {
  syncStateFromControls();
  syncDimensionFromHeight();
  scheduleRender();
});

els.positionGrid.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-pos]");
  if (!button) return;
  setWatermarkPosition(button.dataset.pos);
});

els.timeline.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  const thumb = event.target.closest(".thumb");
  if (!button || !thumb) return;

  const id = thumb.dataset.id;
  if (button.dataset.action === "remove") removeImage(id);
  if (button.dataset.action === "left") moveImage(id, -1);
  if (button.dataset.action === "right") moveImage(id, 1);
});

els.timeline.addEventListener("dragstart", (event) => {
  const thumb = event.target.closest(".thumb");
  if (!thumb) return;
  dragImageId = thumb.dataset.id;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", dragImageId);
  requestAnimationFrame(() => thumb.classList.add("dragging"));
});

function clearDropIndicators() {
  $$(".thumb.drop-before, .thumb.drop-after").forEach((thumb) => thumb.classList.remove("drop-before", "drop-after"));
}

function getDropPlacement(event) {
  const thumb = event.target.closest(".thumb");
  if (!thumb) {
    return { index: state.images.length, thumb: els.timeline.lastElementChild, after: true };
  }
  const rect = thumb.getBoundingClientRect();
  const after = event.clientX > rect.left + rect.width / 2;
  const index = state.images.findIndex((item) => item.id === thumb.dataset.id);
  return { index: index + (after ? 1 : 0), thumb, after };
}

els.timeline.addEventListener("dragover", (event) => {
  if (!dragImageId) return;
  event.preventDefault();
  clearDropIndicators();
  const { thumb, after } = getDropPlacement(event);
  if (thumb && thumb.dataset.id !== dragImageId) {
    thumb.classList.add(after ? "drop-after" : "drop-before");
  }
});

els.timeline.addEventListener("drop", (event) => {
  if (!dragImageId) return;
  event.preventDefault();

  const { index } = getDropPlacement(event);
  clearDropIndicators();
  reorderImage(dragImageId, index);
  dragImageId = null;
});

els.timeline.addEventListener("dragleave", (event) => {
  if (!els.timeline.contains(event.relatedTarget)) clearDropIndicators();
});

els.timeline.addEventListener("dragend", () => {
  dragImageId = null;
  $$(".thumb").forEach((thumb) => thumb.classList.remove("dragging", "drop-before", "drop-after"));
});

["dragenter", "dragover"].forEach((name) => {
  els.dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    els.dropZone.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((name) => {
  els.dropZone.addEventListener(name, () => {
    els.dropZone.classList.remove("dragging");
  });
});

els.dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  addFiles(event.dataTransfer.files);
});

window.addEventListener("beforeunload", () => {
  state.images.forEach((item) => URL.revokeObjectURL(item.url));
});

loadCustomFonts();
updateCropInputs();
updateFormatControls();
updateWatermarkOptions();
renderTimeline();
renderComposite();
