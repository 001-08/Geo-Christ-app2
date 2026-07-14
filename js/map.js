/* ============================================================
   ArboMap · map.js
   ------------------------------------------------------------
   Inicializa o mapa Leaflet, gerencia camadas base (OSM, satélite,
   topográfico), e implementa o HUD sobreposto ao mapa:
   bússola/rotação, escala, coordenadas do cursor e zoom.
============================================================ */

const ArboMap = (() => {

  let map;
  let currentRotation = 0;     // graus, para o efeito visual de rotação do mapa
  const overlayLayers = {};    // camadas carregadas pelo usuário (id -> leaflet layer)

  const basemaps = {
    osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 19,
    }),
    satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri', maxZoom: 19,
    }),
    topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap', maxZoom: 17,
    }),
  };
  let activeBasemap = null;

  /** Inicializa o mapa Leaflet centralizado no Brasil (visão geral). */
  function init() {
    map = L.map('map', {
      zoomControl: false,          // usamos botões próprios no HUD
      attributionControl: true,
      rotate: false,               // rotação é simulada via CSS (ver setRotation)
      center: [-15.78, -47.93],
      zoom: 5,
      worldCopyJump: true,
    });

    setBasemap('osm');

    // Escala nativa do Leaflet, reposicionada dentro do nosso HUD.
    const scale = L.control.scale({ position: 'bottomright', metric: true, imperial: false });
    scale.addTo(map);
    document.getElementById('scale-box').appendChild(scale.getContainer());

    wireCursorCoordinates();
    wireZoomButtons();
    wireCompass();
    wireFullscreen();

    return map;
  }

  function getMap() { return map; }

  /** Troca a camada base ativa. */
  function setBasemap(key) {
    if (activeBasemap) map.removeLayer(activeBasemap);
    if (key === 'none') { activeBasemap = null; return; }
    activeBasemap = basemaps[key];
    activeBasemap.addTo(map);
    activeBasemap.bringToBack();
  }

  /** Adiciona uma camada de overlay (mapa carregado, trilha, etc.) com um ID único. */
  function addOverlay(id, layer, { fitBounds = true } = {}) {
    overlayLayers[id] = layer;
    layer.addTo(map);
    if (fitBounds && layer.getBounds) {
      try { map.fitBounds(layer.getBounds(), { maxZoom: 18 }); } catch (e) { /* geometria sem bounds válidos */ }
    }
    return layer;
  }

  function removeOverlay(id) {
    if (overlayLayers[id]) {
      map.removeLayer(overlayLayers[id]);
      delete overlayLayers[id];
    }
  }

  function getOverlay(id) { return overlayLayers[id]; }

  /** Atualiza o chip de coordenadas conforme o cursor se move sobre o mapa. */
  function wireCursorCoordinates() {
    const el = document.querySelector('#coord-cursor span');
    map.on('mousemove', (e) => {
      const format = ArboApp.settings.coordFormat;
      el.textContent = ArboGeoref.formatCoords(e.latlng.lat, e.latlng.lng, format);
    });
  }

  function wireZoomButtons() {
    document.getElementById('btn-zoom-in').addEventListener('click', () => map.zoomIn());
    document.getElementById('btn-zoom-out').addEventListener('click', () => map.zoomOut());
  }

  /** Rotação do mapa: como o Leaflet-core não roda tiles nativamente sem plugin
   *  pesado, aplicamos uma rotação visual via CSS no container de tiles/overlays,
   *  suficiente para orientação em campo (efeito "modo bússola"). */
  function setRotation(deg) {
    currentRotation = deg;
    const pane = map.getPane('mapPane');
    pane.style.transformOrigin = 'center center';
    pane.style.transform = `${pane.style.transform.replace(/rotate\([^)]*\)/, '')} rotate(${deg}deg)`;
    document.getElementById('compass-svg').style.transform = `rotate(${-deg}deg)`;
  }

  function wireCompass() {
    document.getElementById('btn-rotate-reset').addEventListener('click', () => setRotation(0));

    // Se o dispositivo tiver sensor de orientação (bússola do celular), usa-o
    // para girar a agulha da bússola (não o mapa, para não confundir a navegação).
    window.addEventListener('deviceorientationabsolute', handleOrientation, true);
    window.addEventListener('deviceorientation', handleOrientation, true);
  }

  function handleOrientation(e) {
    if (e.absolute === false && e.webkitCompassHeading === undefined) return;
    const heading = e.webkitCompassHeading !== undefined ? e.webkitCompassHeading : (360 - e.alpha);
    if (typeof heading === 'number' && !Number.isNaN(heading)) {
      document.getElementById('compass-svg').style.transform = `rotate(${-heading}deg)`;
    }
  }

  function wireFullscreen() {
    document.getElementById('btn-fullscreen').addEventListener('click', () => {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
      else document.exitFullscreen?.();
    });
  }

  return {
    init, getMap, setBasemap, addOverlay, removeOverlay, getOverlay,
    setRotation, get rotation() { return currentRotation; },
  };
})();
