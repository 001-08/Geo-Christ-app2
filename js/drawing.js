/* ============================================================
   ArboMap · drawing.js
   ------------------------------------------------------------
   Ferramentas de desenho (ponto, linha, polígono, círculo,
   retângulo), medição de distância/área com Turf.js, e as
   ferramentas específicas da aba "Engenharia Florestal":
   talhões, declividade, parcelas, árvores (com numeração
   automática) e distância entre árvores.
============================================================ */

const ArboDrawing = (() => {

  let map;
  let drawnItems;        // FeatureGroup com todas as geometrias "genéricas"
  let forestryItems;     // FeatureGroup com talhões/parcelas/árvores
  let activeDrawer = null;
  let treeCounter = 0;
  let selectedTreesForDistance = [];

  function init() {
    map = ArboMap.getMap();
    drawnItems = new L.FeatureGroup().addTo(map);
    forestryItems = new L.FeatureGroup().addTo(map);

    map.on(L.Draw.Event.CREATED, onShapeCreated);

    wireToolButtons();
    wireMeasureButtons();
    wireForestryButtons();
    loadPersistedShapes();
  }

  // --------------------------------------------------------
  // Ferramentas genéricas de desenho
  // --------------------------------------------------------

  const drawHandlers = {
    marker: () => new L.Draw.Marker(map),
    polyline: () => new L.Draw.Polyline(map, { shapeOptions: { color: '#ff7a1a' } }),
    polygon: () => new L.Draw.Polygon(map, { shapeOptions: { color: '#ff7a1a' } }),
    circle: () => new L.Draw.Circle(map, { shapeOptions: { color: '#ff7a1a' } }),
    rectangle: () => new L.Draw.Rectangle(map, { shapeOptions: { color: '#ff7a1a' } }),
  };

  function wireToolButtons() {
    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = btn.dataset.tool;
        document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));

        if (tool === 'edit') {
          new L.EditToolbar.Edit(map, { featureGroup: drawnItems }).enable();
          return;
        }
        if (tool === 'delete') {
          if (confirm('Remover todas as geometrias desenhadas?')) {
            drawnItems.clearLayers();
            persistShapes();
            renderShapesList();
          }
          return;
        }
        btn.classList.add('active');
        if (activeDrawer) activeDrawer.disable();
        activeDrawer = drawHandlers[tool]();
        activeDrawer.enable();
      });
    });
  }

  async function onShapeCreated(e) {
    const layer = e.layer;
    drawnItems.addLayer(layer);
    annotateShape(layer, e.layerType);
    await persistShapes();
    renderShapesList();
  }

  /** Calcula e exibe área/perímetro/comprimento automaticamente ao criar uma geometria. */
  function annotateShape(layer, type) {
    const geojson = layer.toGeoJSON();
    let label = '';

    if (type === 'polygon' || type === 'rectangle') {
      const areaM2 = turf.area(geojson);
      const perimKm = turf.length(turf.polygonToLine(geojson), { units: 'kilometers' });
      label = `Área: ${formatArea(areaM2)} • Perímetro: ${formatLength(perimKm * 1000)}`;
    } else if (type === 'circle') {
      const radius = layer.getRadius();
      const areaM2 = Math.PI * radius * radius;
      label = `Raio: ${radius.toFixed(1)} m • Área: ${formatArea(areaM2)}`;
    } else if (type === 'polyline') {
      const lengthKm = turf.length(geojson, { units: 'kilometers' });
      label = `Comprimento: ${formatLength(lengthKm * 1000)}`;
    } else if (type === 'marker') {
      label = `Ponto: ${layer.getLatLng().lat.toFixed(6)}, ${layer.getLatLng().lng.toFixed(6)}`;
    }
    layer.bindPopup(label);
    layer._arbomapLabel = label;
    layer._arbomapType = type;
  }

  function renderShapesList() {
    const ul = document.getElementById('shapes-list');
    ul.innerHTML = '';
    const layers = drawnItems.getLayers();
    if (!layers.length) { ul.innerHTML = '<li class="empty-hint">Nenhuma geometria</li>'; return; }
    layers.forEach((layer, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span><i class="bi bi-shapes"></i> ${layer._arbomapType || 'forma'} ${i + 1} — ${layer._arbomapLabel || ''}</span>
        <span class="layer-actions"><button data-i="${i}"><i class="bi bi-crosshair"></i></button></span>`;
      li.querySelector('button').addEventListener('click', () => map.fitBounds(layer.getBounds ? layer.getBounds() : layer.getLatLng().toBounds(50)));
      ul.appendChild(li);
    });
  }

  async function persistShapes() {
    const featureCollection = { type: 'FeatureCollection', features: drawnItems.getLayers().map(l => {
      const f = l.toGeoJSON();
      f.properties = { ...f.properties, label: l._arbomapLabel, type: l._arbomapType };
      return f;
    }) };
    await ArboOffline.save('shapes', 'drawn-shapes', { geojson: featureCollection });
  }

  async function loadPersistedShapes() {
    const saved = await ArboOffline.get('shapes', 'drawn-shapes');
    if (saved?.geojson?.features?.length) {
      L.geoJSON(saved.geojson, {
        style: { color: '#ff7a1a' },
        onEachFeature: (feature, layer) => {
          layer._arbomapLabel = feature.properties?.label;
          layer._arbomapType = feature.properties?.type;
          if (layer._arbomapLabel) layer.bindPopup(layer._arbomapLabel);
          drawnItems.addLayer(layer);
        },
      });
      renderShapesList();
    }
    await loadPersistedForestry();
  }

  // --------------------------------------------------------
  // Medição rápida (distância / área) sem manter a geometria
  // --------------------------------------------------------

  function wireMeasureButtons() {
    document.getElementById('btn-measure-dist').addEventListener('click', () => startMeasure('polyline', formatLength, 'kilometers'));
    document.getElementById('btn-measure-area').addEventListener('click', () => startMeasure('polygon', formatArea, null));
  }

  function startMeasure(type, formatter, turfUnits) {
    if (activeDrawer) activeDrawer.disable();
    activeDrawer = drawHandlers[type]();
    activeDrawer.enable();

    const handler = (e) => {
      const geojson = e.layer.toGeoJSON();
      const box = document.getElementById('measure-result');
      box.classList.remove('hidden');
      if (type === 'polygon') {
        box.textContent = `Área: ${formatArea(turf.area(geojson))}`;
      } else {
        box.textContent = `Distância: ${formatLength(turf.length(geojson, { units: 'kilometers' }) * 1000)}`;
      }
      map.removeLayer(e.layer); // medição temporária: não fica salva como geometria permanente
      map.off(L.Draw.Event.CREATED, handler);
    };
    map.on(L.Draw.Event.CREATED, handler);
  }

  function formatLength(m) {
    const unit = ArboApp.settings.units;
    if (unit === 'imperial') {
      const ft = m * 3.28084;
      return ft < 5280 ? `${ft.toFixed(1)} ft` : `${(ft / 5280).toFixed(2)} mi`;
    }
    return m < 1000 ? `${m.toFixed(1)} m` : `${(m / 1000).toFixed(3)} km`;
  }

  function formatArea(m2) {
    const unit = ArboApp.settings.units;
    if (unit === 'imperial') return `${(m2 / 4046.86).toFixed(3)} ac`;
    return m2 < 10000 ? `${m2.toFixed(1)} m²` : `${(m2 / 10000).toFixed(3)} ha`;
  }

  // --------------------------------------------------------
  // Engenharia Florestal
  // --------------------------------------------------------

  function wireForestryButtons() {
    document.getElementById('btn-talhao-desenhar').addEventListener('click', drawTalhao);
    document.getElementById('btn-declividade').addEventListener('click', measureDeclividade);
    document.getElementById('btn-marcar-parcela').addEventListener('click', () => markForestryPoint('parcela'));
    document.getElementById('btn-marcar-arvore').addEventListener('click', () => markForestryPoint('arvore'));
    document.getElementById('btn-dist-arvores').addEventListener('click', measureTreeDistances);
  }

  /** Talhão = polígono com cálculo de área (ha) e perímetro. */
  function drawTalhao() {
    if (activeDrawer) activeDrawer.disable();
    activeDrawer = new L.Draw.Polygon(map, { shapeOptions: { color: '#4caf6f', weight: 3 } });
    activeDrawer.enable();

    const handler = async (e) => {
      const layer = e.layer;
      const geojson = layer.toGeoJSON();
      const areaM2 = turf.area(geojson);
      const perimKm = turf.length(turf.polygonToLine(geojson), { units: 'kilometers' });
      const label = `Talhão — Área: ${formatArea(areaM2)} | Perímetro: ${formatLength(perimKm * 1000)}`;
      layer.bindPopup(label);
      layer._arbomapLabel = label;
      layer._arbomapType = 'talhao';
      forestryItems.addLayer(layer);

      document.getElementById('talhao-result').classList.remove('hidden');
      document.getElementById('talhao-result').textContent = label;

      await persistForestry();
      map.off(L.Draw.Event.CREATED, handler);
    };
    map.on(L.Draw.Event.CREATED, handler);
  }

  /**
   * Declividade entre 2 pontos: pede ao usuário a diferença de
   * elevação (ou usa GPS/altitude quando disponível) e calcula a
   * declividade (%) e o ângulo em graus a partir da distância
   * horizontal medida no mapa (fórmula padrão de engenharia:
   * declividade% = (desnível / distância horizontal) × 100).
   */
  function measureDeclividade() {
    if (activeDrawer) activeDrawer.disable();
    activeDrawer = new L.Draw.Polyline(map, { shapeOptions: { color: '#ffd166' }, maxPoints: 2 });
    activeDrawer.enable();

    const handler = async (e) => {
      const geojson = e.layer.toGeoJSON();
      const distM = turf.length(geojson, { units: 'kilometers' }) * 1000;
      const desnivel = Number(prompt('Diferença de elevação entre os dois pontos (metros):', '0'));
      const declividadePct = distM > 0 ? (desnivel / distM) * 100 : 0;
      const anguloGraus = Math.atan(desnivel / distM) * (180 / Math.PI);

      const label = `Distância horizontal: ${formatLength(distM)} | Desnível: ${desnivel} m | Declividade: ${declividadePct.toFixed(1)}% (${anguloGraus.toFixed(1)}°)`;
      e.layer.bindPopup(label);
      e.layer._arbomapLabel = label;
      e.layer._arbomapType = 'declividade';
      forestryItems.addLayer(e.layer);

      document.getElementById('declividade-result').classList.remove('hidden');
      document.getElementById('declividade-result').textContent = label;

      await persistForestry();
      map.off(L.Draw.Event.CREATED, handler);
    };
    map.on(L.Draw.Event.CREATED, handler);
  }

  /** Marca um ponto de parcela ou árvore (com numeração automática opcional). */
  function markForestryPoint(kind) {
    if (activeDrawer) activeDrawer.disable();
    activeDrawer = new L.Draw.Marker(map);
    activeDrawer.enable();

    const handler = async (e) => {
      const layer = e.layer;
      let label;
      if (kind === 'arvore') {
        const auto = document.getElementById('chk-auto-numero').checked;
        treeCounter += 1;
        const numero = auto ? treeCounter : prompt('Número/identificação da árvore:', treeCounter);
        label = `Árvore #${numero}`;
        layer._treeNumber = numero;
        layer.bindTooltip(String(numero), { permanent: true, direction: 'top', className: 'tree-label' });
      } else {
        const nome = prompt('Identificação da parcela:', `Parcela ${forestryItems.getLayers().length + 1}`);
        label = nome || 'Parcela';
      }
      layer.bindPopup(label);
      layer._arbomapLabel = label;
      layer._arbomapType = kind;
      forestryItems.addLayer(layer);

      renderTreesList();
      await persistForestry();
      map.off(L.Draw.Event.CREATED, handler);
    };
    map.on(L.Draw.Event.CREATED, handler);
  }

  function renderTreesList() {
    const ul = document.getElementById('arvores-list');
    ul.innerHTML = '';
    const trees = forestryItems.getLayers().filter(l => l._arbomapType === 'arvore');
    trees.forEach((layer) => {
      const li = document.createElement('li');
      li.innerHTML = `<span><i class="bi bi-tree-fill"></i> ${layer._arbomapLabel}</span>`;
      ul.appendChild(li);
    });
  }

  /** Mede a distância entre as duas últimas árvores marcadas (seleção por clique). */
  function measureTreeDistances() {
    const trees = forestryItems.getLayers().filter(l => l._arbomapType === 'arvore');
    if (trees.length < 2) {
      ArboApp.toast('Marque ao menos 2 árvores antes de medir a distância.', 'error');
      return;
    }
    const box = document.getElementById('arvores-result');
    box.classList.remove('hidden');
    let text = '';
    for (let i = 0; i < trees.length - 1; i++) {
      const a = trees[i].getLatLng(), b = trees[i + 1].getLatLng();
      const d = map.distance(a, b);
      text += `Árvore #${trees[i]._treeNumber} → #${trees[i + 1]._treeNumber}: ${formatLength(d)}\n`;
    }
    box.textContent = text;
  }

  async function persistForestry() {
    const featureCollection = { type: 'FeatureCollection', features: forestryItems.getLayers().map(l => {
      const f = l.toGeoJSON();
      f.properties = { ...f.properties, label: l._arbomapLabel, type: l._arbomapType, treeNumber: l._treeNumber };
      return f;
    }) };
    await ArboOffline.save('forestry', 'forestry-features', { geojson: featureCollection });
  }

  async function loadPersistedForestry() {
    const saved = await ArboOffline.get('forestry', 'forestry-features');
    if (saved?.geojson?.features?.length) {
      L.geoJSON(saved.geojson, {
        style: { color: '#4caf6f' },
        onEachFeature: (feature, layer) => {
          layer._arbomapLabel = feature.properties?.label;
          layer._arbomapType = feature.properties?.type;
          layer._treeNumber = feature.properties?.treeNumber;
          if (layer._arbomapType === 'arvore') {
            treeCounter = Math.max(treeCounter, Number(layer._treeNumber) || 0);
            layer.bindTooltip(String(layer._treeNumber), { permanent: true, direction: 'top', className: 'tree-label' });
          }
          if (layer._arbomapLabel) layer.bindPopup(layer._arbomapLabel);
          forestryItems.addLayer(layer);
        },
      });
      renderTreesList();
    }
  }

  function getDrawnItems() { return drawnItems; }
  function getForestryItems() { return forestryItems; }

  return { init, getDrawnItems, getForestryItems, formatArea, formatLength };
})();
