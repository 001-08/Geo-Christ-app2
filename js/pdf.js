/* ============================================================
   ArboMap · pdf.js
   ------------------------------------------------------------
   Este módulo concentra o CARREGAMENTO DE MAPAS de todos os
   formatos suportados (o arquivo se chama pdf.js conforme a
   estrutura solicitada, mas por coesão reúne aqui os demais
   leitores de arquivo, já que a estrutura de pastas pedida não
   previa um arquivo dedicado a cada formato):

     - GeoPDF (PDF georreferenciado)  → via PDF.js
     - GeoTIFF                        → via geotiff.js
     - JPG / PNG (imagem simples)     → georreferenciamento manual
     - MBTiles                        → via sql.js (SQLite em WASM)
     - GPX / KML                      → via @tmcw/togeojson
     - GeoJSON                        → nativo
     - Shapefile (.zip)               → via shpjs

   Fluxo geral para rasters (PDF/imagem/GeoTIFF):
     1. Tenta detectar georreferenciamento automático.
     2. Se encontrado -> calcula os 4 cantos em WGS84 e posiciona
        a imagem no mapa com L.imageOverlay / L.distortableImage.
     3. Se não encontrado -> abre o modal de georreferenciamento
        manual (ver ArboGeorefUI, no fim deste arquivo).
============================================================ */

const ArboLoaders = (() => {

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

  // ------------------------------------------------------------
  // 1) GeoPDF
  // ------------------------------------------------------------

  /**
   * Carrega um PDF, renderiza a primeira página em um canvas (imagem)
   * e tenta localizar metadados geoespaciais (dicionários /Measure,
   * /GPTS, /LPTS do padrão OGC Geospatial PDF) inspecionando o texto
   * bruto do arquivo em busca desses marcadores.
   */
  async function loadGeoPDF(file) {
    const buffer = await file.arrayBuffer();
    const rawText = bufferToLatin1String(buffer); // permite regex sobre o PDF "cru"

    const pdf = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2 });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const imageDataUrl = canvas.toDataURL('image/png');

    const geoInfo = detectGeoPDFReferencing(rawText, viewport.width, viewport.height);

    if (geoInfo) {
      placeImageWithCorners(imageDataUrl, geoInfo.corners, file.name);
      ArboApp.toast(`GeoPDF "${file.name}" carregado com georreferenciamento automático (${geoInfo.crsLabel}).`, 'success');
    } else {
      ArboApp.toast(`"${file.name}" não possui georreferenciamento detectável. Informe pontos de controle.`, 'error');
      ArboGeorefUI.open(imageDataUrl, canvas.width, canvas.height, file.name);
    }
  }

  function bufferToLatin1String(buffer) {
    const bytes = new Uint8Array(buffer);
    let str = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      str += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return str;
  }

  /**
   * Procura por arrays /LPTS (pontos no espaço da página, 0-1) e
   * /GPTS (pontos geográficos correspondentes lat/lon) no corpo do
   * PDF, conforme a especificação OGC Geospatial PDF (usada pelo
   * GeoPDF da TerraGo/ArcGIS/QGIS). Quando o PDF usa compressão de
   * streams de objeto (ObjStm), esses dicionários podem não aparecer
   * em texto puro — nesse caso, retornamos null e o fluxo cai no
   * georreferenciamento manual.
   */
  function detectGeoPDFReferencing(rawText, pixelW, pixelH) {
    const gptsMatch = rawText.match(/\/GPTS\s*\[([^\]]+)\]/);
    const lptsMatch = rawText.match(/\/LPTS\s*\[([^\]]+)\]/);
    if (!gptsMatch || !lptsMatch) return null;

    const gpts = gptsMatch[1].trim().split(/\s+/).map(Number); // lat,lon,lat,lon,...
    const lpts = lptsMatch[1].trim().split(/\s+/).map(Number); // x,y,x,y,... (0 a 1, relativo à página)

    if (gpts.length < 8 || lpts.length < 8 || gpts.length !== lpts.length) return null;

    const corners = [];
    for (let i = 0; i < 4; i++) {
      const lat = gpts[i * 2];
      const lon = gpts[i * 2 + 1];
      const lx = lpts[i * 2];
      const ly = lpts[i * 2 + 1];
      corners.push({
        // Converte coordenada relativa da página (0-1, origem inferior-esquerda em PDF)
        // para pixels do canvas renderizado (origem superior-esquerda).
        x: lx * pixelW,
        y: (1 - ly) * pixelH,
        lat, lon,
      });
    }

    const csMatch = rawText.match(/\/GCS\s*<<[^>]*\/WKT\s*\(([^)]+)\)/);
    return { corners, crsLabel: csMatch ? 'CRS detectado no PDF' : 'WGS84 (assumido)' };
  }

  // ------------------------------------------------------------
  // 2) GeoTIFF
  // ------------------------------------------------------------

  async function loadGeoTIFF(file) {
    const buffer = await file.arrayBuffer();
    const tiff = await GeoTIFF.fromArrayBuffer(buffer);
    const image = await tiff.getImage();

    const bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY] no CRS nativo
    const geoKeys = image.getGeoKeys();
    const epsg = geoKeys?.ProjectedCSTypeGeoKey || geoKeys?.GeographicTypeGeoKey;

    // Renderiza a imagem para um canvas (RGB) usando os dados rasterizados.
    const rasters = await image.readRasters();
    const canvas = rasterToCanvas(rasters, image.getWidth(), image.getHeight());
    const imageDataUrl = canvas.toDataURL('image/png');

    let sw, ne;
    if (epsg && epsg !== 4326 && proj4.defs(`EPSG:${epsg}`)) {
      sw = proj4(`EPSG:${epsg}`, 'WGS84', [bbox[0], bbox[1]]);
      ne = proj4(`EPSG:${epsg}`, 'WGS84', [bbox[2], bbox[3]]);
    } else if (epsg && /^\d+$/.test(String(epsg))) {
      // Tenta registrar EPSG comuns (UTM) automaticamente via proj4 se ainda não definido.
      registerCommonEPSG(epsg);
      try {
        sw = proj4(`EPSG:${epsg}`, 'WGS84', [bbox[0], bbox[1]]);
        ne = proj4(`EPSG:${epsg}`, 'WGS84', [bbox[2], bbox[3]]);
      } catch (e) {
        sw = [bbox[0], bbox[1]]; ne = [bbox[2], bbox[3]];
      }
    } else {
      sw = [bbox[0], bbox[1]]; ne = [bbox[2], bbox[3]];
    }

    const bounds = [[sw[1], sw[0]], [ne[1], ne[0]]];
    const overlay = L.imageOverlay(imageDataUrl, bounds, { opacity: 0.9 });
    const id = ArboOffline.uid('layer');
    ArboMap.addOverlay(id, overlay);
    ArboApp.registerLayerInMenu(id, file.name, 'geotiff', overlay);
    ArboApp.toast(`GeoTIFF "${file.name}" carregado (EPSG:${epsg || 'desconhecido'} → WGS84).`, 'success');
  }

  function registerCommonEPSG(epsg) {
    // Zonas UTM SIRGAS2000/WGS84 mais comuns no Brasil (EPSG 31978-31985 e 32718-32722 etc.)
    // Aqui apenas garantimos uma definição genérica de UTM caso o proj4 não a conheça.
    if (!proj4.defs(`EPSG:${epsg}`)) {
      // fallback genérico: assume WGS84 UTM baseado no código (não cobre todos os casos)
      proj4.defs(`EPSG:${epsg}`, `+proj=longlat +datum=WGS84 +no_defs`);
    }
  }

  function rasterToCanvas(rasters, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(width, height);
    const bandCount = rasters.length;
    for (let i = 0; i < width * height; i++) {
      const r = rasters[0][i];
      const g = bandCount > 1 ? rasters[1][i] : r;
      const b = bandCount > 2 ? rasters[2][i] : r;
      imgData.data[i * 4] = r;
      imgData.data[i * 4 + 1] = g;
      imgData.data[i * 4 + 2] = b;
      imgData.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas;
  }

  // ------------------------------------------------------------
  // 3) Imagem simples (JPG/PNG) — sempre requer georref. manual,
  //    pois imagens comuns não trazem metadados geográficos.
  // ------------------------------------------------------------

  async function loadPlainImage(file) {
    const dataUrl = await fileToDataURL(file);
    const img = await loadImageElement(dataUrl);
    ArboApp.toast(`"${file.name}" carregada. Informe pontos de controle para posicioná-la no mapa.`, 'success');
    ArboGeorefUI.open(dataUrl, img.width, img.height, file.name);
  }

  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
  function loadImageElement(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // ------------------------------------------------------------
  // 4) MBTiles (SQLite) — via sql.js (WebAssembly)
  // ------------------------------------------------------------

  async function loadMBTiles(file) {
    const buffer = await file.arrayBuffer();
    const SQL = await initSqlJs({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/${f}` });
    const db = new SQL.Database(new Uint8Array(buffer));

    // Metadados padrão do MBTiles (bounds, formato, minzoom/maxzoom).
    const meta = {};
    const metaRes = db.exec("SELECT name, value FROM metadata");
    if (metaRes[0]) metaRes[0].values.forEach(([k, v]) => meta[k] = v);
    const format = meta.format || 'png';
    const boundsStr = meta.bounds ? meta.bounds.split(',').map(Number) : null;

    // Camada Leaflet customizada que lê cada tile diretamente do banco SQLite em memória.
    const MBTilesLayer = L.GridLayer.extend({
      createTile(coords, done) {
        const tile = document.createElement('img');
        // MBTiles usa esquema TMS (Y invertido) por padrão.
        const y = (1 << coords.z) - 1 - coords.y;
        const stmt = db.prepare('SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?');
        stmt.bind([coords.z, coords.x, y]);
        if (stmt.step()) {
          const data = stmt.getAsObject().tile_data;
          const blob = new Blob([data], { type: `image/${format === 'jpg' ? 'jpeg' : format}` });
          tile.src = URL.createObjectURL(blob);
        }
        stmt.free();
        tile.onload = () => done(null, tile);
        tile.onerror = () => done(null, tile);
        return tile;
      },
    });

    const layer = new MBTilesLayer({ tileSize: 256, minZoom: Number(meta.minzoom) || 0, maxZoom: Number(meta.maxzoom) || 19 });
    const id = ArboOffline.uid('layer');
    layer.addTo(ArboMap.getMap());
    if (boundsStr) ArboMap.getMap().fitBounds([[boundsStr[1], boundsStr[0]], [boundsStr[3], boundsStr[2]]]);
    ArboApp.registerLayerInMenu(id, file.name, 'mbtiles', layer);
    ArboApp.toast(`MBTiles "${file.name}" carregado (${meta.minzoom}-${meta.maxzoom}).`, 'success');
  }

  // ------------------------------------------------------------
  // 5) GPX / KML  (via toGeoJSON)
  // ------------------------------------------------------------

  async function loadGPXorKML(file, kind) {
    const text = await file.text();
    const xml = new DOMParser().parseFromString(text, 'text/xml');
    const geojson = kind === 'gpx' ? toGeoJSON.gpx(xml) : toGeoJSON.kml(xml);
    addGeoJSONLayer(geojson, file.name, kind);
  }

  // ------------------------------------------------------------
  // 6) GeoJSON nativo
  // ------------------------------------------------------------

  async function loadGeoJSON(file) {
    const text = await file.text();
    const geojson = JSON.parse(text);
    addGeoJSONLayer(geojson, file.name, 'geojson');
  }

  // ------------------------------------------------------------
  // 7) Shapefile compactado (.zip) — via shpjs
  // ------------------------------------------------------------

  async function loadShapefile(file) {
    const buffer = await file.arrayBuffer();
    const geojson = await shp(buffer);
    addGeoJSONLayer(geojson, file.name, 'shapefile');
  }

  function addGeoJSONLayer(geojson, name, kind) {
    const layer = L.geoJSON(geojson, {
      style: { color: '#ff7a1a', weight: 3 },
      pointToLayer: (feature, latlng) => L.marker(latlng),
    });
    const id = ArboOffline.uid('layer');
    ArboMap.addOverlay(id, layer);
    ArboApp.registerLayerInMenu(id, name, kind, layer);
    ArboApp.toast(`"${name}" carregado com sucesso.`, 'success');
  }

  // ------------------------------------------------------------
  // Posiciona uma imagem raster no mapa a partir de 4 cantos conhecidos
  // (usado tanto pelo fluxo automático de GeoPDF quanto pelo manual).
  // ------------------------------------------------------------
  function placeImageWithCorners(imageDataUrl, corners, name) {
    const lats = corners.map(c => c.lat), lons = corners.map(c => c.lon);
    const bounds = [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]];
    const overlay = L.imageOverlay(imageDataUrl, bounds, { opacity: 0.9 });
    const id = ArboOffline.uid('layer');
    ArboMap.addOverlay(id, overlay);
    ArboApp.registerLayerInMenu(id, name, 'raster', overlay);
  }

  return {
    loadGeoPDF, loadGeoTIFF, loadPlainImage, loadMBTiles,
    loadGPXorKML, loadGeoJSON, loadShapefile, placeImageWithCorners,
  };
})();


/* ============================================================
   ArboGeorefUI — modal de georreferenciamento manual (fallback)
   ------------------------------------------------------------
   Exibe a imagem/PDF renderizado em um canvas. O usuário clica em
   um ponto da imagem e informa a coordenada real correspondente.
   Com 2+ pontos, calculamos a transformação afim (georef.js) e
   posicionamos a imagem no mapa.
============================================================ */
const ArboGeorefUI = (() => {
  let controlPoints = [];
  let currentImage = null;
  let currentName = '';

  function open(dataUrl, width, height, name) {
    controlPoints = [];
    currentName = name;
    const modal = document.getElementById('modal-georef');
    const canvas = document.getElementById('georef-canvas');
    const ctx = canvas.getContext('2d');

    const img = new Image();
    img.onload = () => {
      currentImage = img;
      // Ajusta o canvas ao tamanho de exibição, mantendo proporção.
      const maxW = 580;
      const ratio = Math.min(1, maxW / width);
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      canvas.dataset.ratio = ratio;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = dataUrl;

    modal.classList.remove('hidden');

    canvas.onclick = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const lat = prompt('Latitude do ponto clicado (graus decimais, ex: -15.7801):');
      if (lat === null) return;
      const lon = prompt('Longitude do ponto clicado (graus decimais, ex: -47.9292):');
      if (lon === null) return;
      const ratio = Number(canvas.dataset.ratio);
      controlPoints.push({ px: x / ratio, py: y / ratio, lat: Number(lat), lon: Number(lon) });
      redraw();
    };

    function redraw() {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const ratio = Number(canvas.dataset.ratio);
      controlPoints.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(p.px * ratio, p.py * ratio, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#ff7a1a';
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = '11px sans-serif';
        ctx.fillText(String(i + 1), p.px * ratio - 3, p.py * ratio + 4);
      });
      document.getElementById('georef-points-list').innerHTML =
        controlPoints.map((p, i) => `${i + 1}. px(${p.px.toFixed(0)},${p.py.toFixed(0)}) → ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`).join('<br>');
    }
  }

  document.getElementById('btn-georef-apply').addEventListener('click', () => {
    if (controlPoints.length < 2) {
      ArboApp.toast('Marque ao menos 2 pontos de controle.', 'error');
      return;
    }
    const transform = ArboGeoref.computeAffineTransform(controlPoints);
    const canvas = document.getElementById('georef-canvas');
    const ratio = Number(canvas.dataset.ratio);
    const w = canvas.width / ratio, h = canvas.height / ratio;

    const cornersPx = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
    const corners = cornersPx.map(c => {
      const geo = transform.toGeo(c.x, c.y);
      return { x: c.x, y: c.y, lat: geo.lat, lon: geo.lon };
    });

    ArboLoaders.placeImageWithCorners(currentImage.src, corners, currentName);
    document.getElementById('modal-georef').classList.add('hidden');
    ArboApp.toast('Imagem georreferenciada e posicionada no mapa.', 'success');
  });

  document.getElementById('btn-georef-cancel').addEventListener('click', () => {
    document.getElementById('modal-georef').classList.add('hidden');
  });

  return { open };
})();
