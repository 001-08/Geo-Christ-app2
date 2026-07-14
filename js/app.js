/* ============================================================
   ArboMap · app.js
   ------------------------------------------------------------
   Ponto de entrada da aplicação. Responsável por:
     - Inicializar todos os módulos na ordem correta.
     - Controlar a interface: menu lateral, painéis deslizantes,
       modais, tema claro/escuro, splash screen, toasts.
     - CRUD de waypoints (criar, editar, anexar foto/áudio, excluir).
     - Pesquisa (por coordenada, nome ou waypoint).
     - Carregar/salvar as configurações do usuário.
============================================================ */

const ArboApp = (() => {

  const settings = {
    coordFormat: 'dd',
    units: 'metric',
    gpsAccuracy: 15,
    lang: 'pt-BR',
  };

  let currentEditingFeature = null; // waypoint (ou árvore) em edição no modal genérico
  let pendingPhotoDataUrl = null;
  let pendingAudioDataUrl = null;
  let mediaRecorder = null;

  // ------------------------------------------------------------
  // Inicialização
  // ------------------------------------------------------------

  async function init() {
    await loadSettings();

    ArboOffline.registerServiceWorker();
    ArboOffline.watchConnectionStatus();

    ArboMap.init();
    ArboDrawing.init();
    ArboGPS.startWatching();

    wireTopBar();
    wireSideMenu();
    wireBottomBar();
    wirePanels();
    wireModals();
    wireGPSButtons();
    wireWaypointUI();
    wireSearch();
    wireExportButtons();
    wireSettingsUI();
    wireFileInput();

    await renderWaypointsList();
    await refreshStorageInfo();

    // Remove a splash screen assim que tudo estiver pronto.
    setTimeout(() => {
      const splash = document.getElementById('splash-screen');
      splash.style.opacity = '0';
      setTimeout(() => splash.remove(), 500);
    }, 600);
  }

  // ------------------------------------------------------------
  // Configurações (persistidas)
  // ------------------------------------------------------------

  async function loadSettings() {
    const saved = await ArboOffline.get('settings', 'user-settings');
    if (saved) Object.assign(settings, saved);
    document.body.dataset.theme = saved?.theme || 'dark';
  }

  async function saveSettings() {
    await ArboOffline.save('settings', 'user-settings', { ...settings, theme: document.body.dataset.theme });
  }

  function wireSettingsUI() {
    document.getElementById('cfg-coord-format').value = settings.coordFormat;
    document.getElementById('cfg-units').value = settings.units;
    document.getElementById('cfg-lang').value = settings.lang;
    document.getElementById('cfg-gps-accuracy').value = settings.gpsAccuracy;

    document.getElementById('btn-save-settings').addEventListener('click', async () => {
      settings.coordFormat = document.getElementById('cfg-coord-format').value;
      settings.units = document.getElementById('cfg-units').value;
      settings.lang = document.getElementById('cfg-lang').value;
      settings.gpsAccuracy = Number(document.getElementById('cfg-gps-accuracy').value);
      await saveSettings();
      toast('Configurações salvas.', 'success');
      document.getElementById('modal-settings').classList.add('hidden');
    });
  }

  // ------------------------------------------------------------
  // Barra superior: tema, menu, tela cheia
  // ------------------------------------------------------------

  function wireTopBar() {
    document.getElementById('btn-theme').addEventListener('click', async () => {
      const isDark = document.body.dataset.theme === 'dark';
      document.body.dataset.theme = isDark ? 'light' : 'dark';
      document.getElementById('btn-theme').innerHTML = isDark
        ? '<i class="bi bi-sun-fill"></i>' : '<i class="bi bi-moon-stars-fill"></i>';
      await saveSettings();
    });
  }

  function wireSideMenu() {
    const menu = document.getElementById('side-menu');
    const backdrop = document.getElementById('side-menu-backdrop');
    document.getElementById('btn-menu').addEventListener('click', () => {
      menu.classList.remove('hidden'); backdrop.classList.remove('hidden');
    });
    document.getElementById('btn-close-menu').addEventListener('click', closeMenu);
    backdrop.addEventListener('click', closeMenu);
    function closeMenu() { menu.classList.add('hidden'); backdrop.classList.add('hidden'); }

    document.getElementById('basemap-select').addEventListener('change', (e) => ArboMap.setBasemap(e.target.value));

    document.getElementById('modal-storage') && document.querySelector('[data-action="open-storage"]')?.addEventListener('click', () => {
      document.getElementById('modal-storage').classList.remove('hidden');
      refreshStorageInfo();
    });
    document.querySelector('[data-action="open-settings"]').addEventListener('click', () => {
      document.getElementById('modal-settings').classList.remove('hidden');
    });

    // Botões de carregamento de arquivo no menu lateral.
    const fileActions = {
      'load-geopdf': { accept: '.pdf', handler: ArboLoaders.loadGeoPDF },
      'load-geotiff': { accept: '.tif,.tiff', handler: ArboLoaders.loadGeoTIFF },
      'load-image': { accept: '.jpg,.jpeg,.png', handler: ArboLoaders.loadPlainImage },
      'load-mbtiles': { accept: '.mbtiles', handler: ArboLoaders.loadMBTiles },
      'load-gpx': { accept: '.gpx', handler: (f) => ArboLoaders.loadGPXorKML(f, 'gpx') },
      'load-kml': { accept: '.kml', handler: (f) => ArboLoaders.loadGPXorKML(f, 'kml') },
      'load-geojson': { accept: '.geojson,.json', handler: ArboLoaders.loadGeoJSON },
      'load-shapefile': { accept: '.zip', handler: ArboLoaders.loadShapefile },
    };
    document.querySelectorAll('.menu-item[data-action]').forEach(btn => {
      const action = fileActions[btn.dataset.action];
      if (!action) return;
      btn.addEventListener('click', () => {
        const input = document.getElementById('file-input');
        input.accept = action.accept;
        input.onchange = async () => {
          if (!input.files.length) return;
          try {
            await action.handler(input.files[0]);
            await refreshStorageInfo();
          } catch (err) {
            console.error(err);
            toast(`Erro ao carregar arquivo: ${err.message}`, 'error');
          }
          input.value = '';
        };
        input.click();
        closeMenu();
      });
    });
  }

  function wireFileInput() {
    // input global já conectado acima; mantido por clareza estrutural.
  }

  /** Registra uma camada carregada na lista visível do menu lateral, com botões de zoom/remover. */
  function registerLayerInMenu(id, name, kind, layerRef) {
    const ul = document.getElementById('layers-list');
    if (ul.querySelector('.empty-hint')) ul.innerHTML = '';
    const li = document.createElement('li');
    li.innerHTML = `<span><i class="bi bi-layers"></i> ${name}</span>
      <span class="layer-actions">
        <button data-act="zoom" title="Ir para"><i class="bi bi-crosshair"></i></button>
        <button data-act="remove" title="Remover"><i class="bi bi-trash"></i></button>
      </span>`;
    li.querySelector('[data-act="zoom"]').addEventListener('click', () => {
      if (layerRef.getBounds) ArboMap.getMap().fitBounds(layerRef.getBounds());
    });
    li.querySelector('[data-act="remove"]').addEventListener('click', () => {
      ArboMap.removeOverlay(id);
      li.remove();
      if (!ul.children.length) ul.innerHTML = '<li class="empty-hint">Nenhuma camada carregada</li>';
    });
    ul.appendChild(li);
  }

  // ------------------------------------------------------------
  // Barra inferior + painéis deslizantes
  // ------------------------------------------------------------

  function wireBottomBar() {
    document.querySelectorAll('.bottom-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const panelId = btn.dataset.panel;
        const panel = document.getElementById(panelId);
        const isOpen = !panel.classList.contains('hidden');
        document.querySelectorAll('.side-panel').forEach(p => p.classList.add('hidden'));
        document.querySelectorAll('.bottom-item').forEach(b => b.classList.remove('active'));
        if (!isOpen) { panel.classList.remove('hidden'); btn.classList.add('active'); }
      });
    });
  }

  function wirePanels() {
    document.querySelectorAll('.panel-close').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.target.closest('.side-panel').classList.add('hidden');
        document.querySelectorAll('.bottom-item').forEach(b => b.classList.remove('active'));
      });
    });
  }

  function wireModals() {
    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', (e) => e.target.closest('.modal-overlay').classList.add('hidden'));
    });
    document.getElementById('btn-clear-storage').addEventListener('click', async () => {
      if (confirm('Isso apagará TODOS os dados salvos (waypoints, trilhas, camadas, geometrias). Continuar?')) {
        await ArboOffline.clearAll();
        toast('Dados offline apagados. Recarregue a página.', 'success');
      }
    });
  }

  // ------------------------------------------------------------
  // GPS: botão de centralizar + gravação de trilha
  // ------------------------------------------------------------

  function wireGPSButtons() {
    document.getElementById('btn-locate').addEventListener('click', ArboGPS.centerOnUser);
    document.getElementById('btn-track-start').addEventListener('click', ArboGPS.startTrack);
    document.getElementById('btn-track-pause').addEventListener('click', ArboGPS.pauseTrack);
    document.getElementById('btn-track-stop').addEventListener('click', ArboGPS.stopTrack);
    document.querySelectorAll('.export-track').forEach(btn =>
      btn.addEventListener('click', () => ArboExport.exportTrack(btn.dataset.format)));
  }

  function wireExportButtons() {
    document.querySelectorAll('.export-all').forEach(btn =>
      btn.addEventListener('click', () => ArboExport.exportAll(btn.dataset.format)));
  }

  // ------------------------------------------------------------
  // Waypoints (CRUD completo, com foto/áudio)
  // ------------------------------------------------------------

  function wireWaypointUI() {
    document.getElementById('btn-new-waypoint').addEventListener('click', () => {
      const pos = ArboGPS.getLastPosition();
      if (!pos) { toast('Aguardando sinal de GPS…', 'error'); return; }
      openFeatureModal({ id: null, name: `Waypoint ${new Date().toLocaleTimeString('pt-BR')}`, lat: pos.lat, lon: pos.lon, time: Date.now() });
    });

    document.getElementById('feat-photo-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      pendingPhotoDataUrl = await fileToDataURL(file);
      const img = document.getElementById('feat-photo-preview');
      img.src = pendingPhotoDataUrl; img.classList.remove('hidden');
    });

    document.getElementById('btn-record-audio').addEventListener('click', toggleAudioRecording);

    document.getElementById('btn-save-feature').addEventListener('click', saveFeatureFromModal);
    document.getElementById('btn-delete-feature').addEventListener('click', deleteFeatureFromModal);
  }

  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  async function toggleAudioRecording() {
    const btn = document.getElementById('btn-record-audio');
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const chunks = [];
        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
        mediaRecorder.onstop = async () => {
          const blob = new Blob(chunks, { type: 'audio/webm' });
          pendingAudioDataUrl = await blobToDataURL(blob);
          const audioEl = document.getElementById('feat-audio-preview');
          audioEl.src = pendingAudioDataUrl; audioEl.classList.remove('hidden');
          stream.getTracks().forEach(t => t.stop());
        };
        mediaRecorder.start();
        btn.innerHTML = '<i class="bi bi-stop-circle"></i> Parar gravação';
      } catch (err) {
        toast('Não foi possível acessar o microfone.', 'error');
      }
    } else {
      mediaRecorder.stop();
      btn.innerHTML = '<i class="bi bi-mic"></i> Gravar áudio';
    }
  }

  function blobToDataURL(blob) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.readAsDataURL(blob);
    });
  }

  function openFeatureModal(feature) {
    currentEditingFeature = feature;
    pendingPhotoDataUrl = feature.photo || null;
    pendingAudioDataUrl = feature.audio || null;

    document.getElementById('modal-feature-title').textContent = feature.id ? 'Editar waypoint' : 'Novo waypoint';
    document.getElementById('feat-name').value = feature.name || '';
    document.getElementById('feat-desc').value = feature.desc || '';
    document.getElementById('feat-coords').textContent = ArboGeoref.formatCoords(feature.lat, feature.lon, settings.coordFormat);
    document.getElementById('feat-date').textContent = new Date(feature.time || Date.now()).toLocaleString('pt-BR');

    const img = document.getElementById('feat-photo-preview');
    if (pendingPhotoDataUrl) { img.src = pendingPhotoDataUrl; img.classList.remove('hidden'); } else { img.classList.add('hidden'); }
    const audioEl = document.getElementById('feat-audio-preview');
    if (pendingAudioDataUrl) { audioEl.src = pendingAudioDataUrl; audioEl.classList.remove('hidden'); } else { audioEl.classList.add('hidden'); }

    document.getElementById('btn-delete-feature').style.display = feature.id ? 'inline-flex' : 'none';
    document.getElementById('modal-feature').classList.remove('hidden');
  }

  async function saveFeatureFromModal() {
    const id = currentEditingFeature.id || ArboOffline.uid('wpt');
    const record = {
      name: document.getElementById('feat-name').value || 'Waypoint',
      desc: document.getElementById('feat-desc').value,
      lat: currentEditingFeature.lat,
      lon: currentEditingFeature.lon,
      time: currentEditingFeature.time || Date.now(),
      photo: pendingPhotoDataUrl,
      audio: pendingAudioDataUrl,
    };
    await ArboOffline.save('waypoints', id, record);
    document.getElementById('modal-feature').classList.add('hidden');
    await renderWaypointsList();
    toast('Waypoint salvo.', 'success');
  }

  async function deleteFeatureFromModal() {
    if (currentEditingFeature.id) {
      await ArboOffline.remove('waypoints', currentEditingFeature.id);
      await renderWaypointsList();
    }
    document.getElementById('modal-feature').classList.add('hidden');
  }

  const waypointMarkers = {};

  async function renderWaypointsList() {
    const list = await ArboOffline.getAll('waypoints');
    const ul = document.getElementById('waypoints-list');
    ul.innerHTML = '';
    if (!list.length) { ul.innerHTML = '<li class="empty-hint">Nenhum waypoint criado</li>'; }

    // Limpa marcadores antigos do mapa e recria (fonte da verdade = IndexedDB).
    Object.values(waypointMarkers).forEach(m => ArboMap.getMap().removeLayer(m));

    list.forEach(w => {
      const li = document.createElement('li');
      li.innerHTML = `<span><i class="bi bi-geo-alt-fill"></i> ${w.name}</span>
        <span class="layer-actions"><button data-act="edit"><i class="bi bi-pencil"></i></button>
        <button data-act="goto"><i class="bi bi-crosshair"></i></button></span>`;
      li.querySelector('[data-act="edit"]').addEventListener('click', () => openFeatureModal(w));
      li.querySelector('[data-act="goto"]').addEventListener('click', () => ArboMap.getMap().setView([w.lat, w.lon], 17));
      ul.appendChild(li);

      const marker = L.marker([w.lat, w.lon]).addTo(ArboMap.getMap()).bindPopup(
        `<b>${w.name}</b><br>${w.desc || ''}${w.photo ? `<br><img src="${w.photo}" style="max-width:160px;border-radius:6px;margin-top:6px">` : ''}`
      );
      marker.on('click', () => openFeatureModal(w));
      waypointMarkers[w.id] = marker;
    });
  }

  // ------------------------------------------------------------
  // Pesquisa (coordenadas, waypoint, nome)
  // ------------------------------------------------------------

  function wireSearch() {
    const input = document.getElementById('search-input');
    input.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const query = input.value.trim();
      if (!query) return;

      // 1) Tenta interpretar como coordenada "lat, lon".
      const coordMatch = query.match(/^\s*(-?\d+\.?\d*)\s*[,;]\s*(-?\d+\.?\d*)\s*$/);
      if (coordMatch) {
        const lat = Number(coordMatch[1]), lon = Number(coordMatch[2]);
        ArboMap.getMap().setView([lat, lon], 16);
        L.marker([lat, lon]).addTo(ArboMap.getMap()).bindPopup('Resultado da pesquisa').openPopup();
        return;
      }

      // 2) Procura por nome entre os waypoints salvos.
      const waypoints = await ArboOffline.getAll('waypoints');
      const found = waypoints.find(w => w.name.toLowerCase().includes(query.toLowerCase()));
      if (found) {
        ArboMap.getMap().setView([found.lat, found.lon], 17);
        waypointMarkers[found.id]?.openPopup();
        return;
      }

      toast('Nenhum resultado encontrado para a pesquisa.', 'error');
    });
  }

  // ------------------------------------------------------------
  // Armazenamento offline (info no modal)
  // ------------------------------------------------------------

  async function refreshStorageInfo() {
    const { usageMB, quotaMB } = await ArboOffline.estimateUsage();
    const el = document.getElementById('storage-info');
    if (el) el.textContent = `Uso estimado: ${usageMB} MB de ${quotaMB} MB disponíveis neste dispositivo.`;
  }

  // ------------------------------------------------------------
  // Toasts (notificações rápidas)
  // ------------------------------------------------------------

  function toast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  return { init, settings, toast, registerLayerInMenu, saveSettings };
})();

// Inicializa a aplicação assim que o DOM estiver pronto.
document.addEventListener('DOMContentLoaded', () => {
  ArboApp.init().catch(err => {
    console.error('[ArboMap] Erro na inicialização:', err);
    ArboApp.toast('Erro ao iniciar a aplicação. Veja o console para detalhes.', 'error');
  });
});
