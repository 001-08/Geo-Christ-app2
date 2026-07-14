/* ============================================================
   ArboMap · offline.js
   ------------------------------------------------------------
   Responsável por TODA a persistência local da aplicação:
     - Configuração de "stores" separados do LocalForage (que usa
       IndexedDB por baixo dos panos, com fallback para WebSQL/
       localStorage em navegadores antigos).
     - Salvamento automático (autosave) de waypoints, trilhas,
       geometrias desenhadas e camadas carregadas.
     - Registro do Service Worker (cache de app-shell e mapas).
     - Utilitários de import/export do "banco" local completo.

   Por que LocalForage? Porque camadas raster grandes (GeoTIFF,
   MBTiles, imagens) podem passar de várias dezenas/centenas de MB.
   O localStorage tem limite de ~5-10MB; IndexedDB não tem esse
   teto prático, por isso é o backend usado aqui.
============================================================ */

const ArboOffline = (() => {

  // Cada "store" do LocalForage funciona como uma tabela isolada.
  const stores = {
    waypoints: localforage.createInstance({ name: 'arbomap', storeName: 'waypoints' }),
    tracks:    localforage.createInstance({ name: 'arbomap', storeName: 'tracks' }),
    shapes:    localforage.createInstance({ name: 'arbomap', storeName: 'shapes' }),      // desenhos livres
    forestry:  localforage.createInstance({ name: 'arbomap', storeName: 'forestry' }),    // talhões/árvores/parcelas
    layers:    localforage.createInstance({ name: 'arbomap', storeName: 'layers' }),      // metadados de camadas carregadas
    rasters:   localforage.createInstance({ name: 'arbomap', storeName: 'rasters' }),     // bytes de PDFs/imagens/GeoTIFF/MBTiles
    settings:  localforage.createInstance({ name: 'arbomap', storeName: 'settings' }),
  };

  /** Gera um ID único simples (suficiente para uso local, não distribuído). */
  function uid(prefix = 'id') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /** Salva um registro genérico em um store, com timestamp de atualização. */
  async function save(storeName, id, data) {
    const record = { ...data, id, _updatedAt: Date.now() };
    await stores[storeName].setItem(id, record);
    return record;
  }

  async function remove(storeName, id) {
    await stores[storeName].removeItem(id);
  }

  async function getAll(storeName) {
    const items = [];
    await stores[storeName].iterate((value) => { items.push(value); });
    // Ordena por data de criação/atualização para exibição estável.
    return items.sort((a, b) => (a._updatedAt || 0) - (b._updatedAt || 0));
  }

  async function get(storeName, id) {
    return stores[storeName].getItem(id);
  }

  async function clearAll() {
    for (const name of Object.keys(stores)) {
      await stores[name].clear();
    }
  }

  /** Estima o uso total de armazenamento (quando a API do navegador suporta). */
  async function estimateUsage() {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      return { usageMB: (usage / (1024 * 1024)).toFixed(1), quotaMB: (quota / (1024 * 1024)).toFixed(1) };
    }
    return { usageMB: '?', quotaMB: '?' };
  }

  /** Registra o Service Worker responsável pelo cache do app-shell (funcionamento offline). */
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('service-worker.js')
          .then(() => console.log('[ArboMap] Service Worker registrado com sucesso.'))
          .catch((err) => console.warn('[ArboMap] Falha ao registrar Service Worker:', err));
      });
    }
  }

  /** Monitora o estado online/offline e atualiza o indicador na barra superior. */
  function watchConnectionStatus() {
    const badge = document.getElementById('conn-status');
    function update() {
      const online = navigator.onLine;
      badge.classList.toggle('online', online);
      badge.innerHTML = online
        ? '<i class="bi bi-wifi"></i> Online'
        : '<i class="bi bi-wifi-off"></i> Offline';
    }
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
  }

  return {
    stores, uid, save, remove, getAll, get, clearAll,
    estimateUsage, registerServiceWorker, watchConnectionStatus,
  };
})();
