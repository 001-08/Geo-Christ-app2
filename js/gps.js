/* ============================================================
   ArboMap · gps.js
   ------------------------------------------------------------
   Usa a API HTML5 Geolocation (navigator.geolocation.watchPosition)
   para exibir posição em tempo real e gravar trilhas GPS, com
   estatísticas de distância, tempo e velocidade — tudo salvo
   automaticamente (autosave) via ArboOffline para nunca perder
   dados em caso de fechamento inesperado do navegador.
============================================================ */

const ArboGPS = (() => {

  let watchId = null;
  let lastPosition = null;
  let userMarker = null;
  let accuracyCircle = null;

  // Estado da gravação de trilha.
  const track = {
    recording: false,
    paused: false,
    points: [],          // [{lat, lon, ele, time, speed}]
    distanceM: 0,
    startTime: null,
    elapsedBeforePause: 0,
    maxSpeedKmh: 0,
    timerHandle: null,
    id: null,
  };

  /** Inicia o monitoramento contínuo de posição. */
  function startWatching() {
    if (!('geolocation' in navigator)) {
      ArboApp.toast('Este dispositivo não suporta geolocalização.', 'error');
      return;
    }
    watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true, maximumAge: 1000, timeout: 15000,
    });
  }

  function onError(err) {
    console.warn('[ArboMap] Erro de GPS:', err.message);
  }

  function onPosition(pos) {
    const { latitude, longitude, accuracy, altitude, speed, heading } = pos.coords;

    // Filtra leituras com precisão pior que a configurada pelo usuário.
    const maxAcc = ArboApp.settings.gpsAccuracy || 15;
    if (accuracy > maxAcc * 3) {
      // Mesmo fora da tolerância "boa", ainda exibimos, mas sinalizamos.
    }

    lastPosition = { lat: latitude, lon: longitude, accuracy, altitude, speed, heading, time: Date.now() };
    updateHUD(lastPosition);
    updateMapMarker(lastPosition);

    if (track.recording && !track.paused) {
      addTrackPoint(lastPosition);
    }
  }

  function updateHUD(p) {
    document.getElementById('gps-lat').textContent = p.lat.toFixed(6);
    document.getElementById('gps-lon').textContent = p.lon.toFixed(6);
    document.getElementById('gps-acc').textContent = `${p.accuracy.toFixed(0)} m`;
    document.getElementById('gps-alt').textContent = p.altitude != null ? `${p.altitude.toFixed(0)} m` : '--';
    document.getElementById('gps-speed').textContent = p.speed != null ? `${(p.speed * 3.6).toFixed(1)} km/h` : '--';
    document.getElementById('gps-heading').textContent = p.heading != null ? `${p.heading.toFixed(0)}°` : '--';
    document.getElementById('gps-time').textContent = new Date(p.time).toLocaleTimeString('pt-BR');

    const format = ArboApp.settings.coordFormat;
    document.querySelector('#coord-gps span').textContent =
      `GPS: ${ArboGeoref.formatCoords(p.lat, p.lon, format)} (±${p.accuracy.toFixed(0)}m)`;
  }

  /** Desenha/atualiza o marcador de posição do usuário e o círculo de precisão. */
  function updateMapMarker(p) {
    const map = ArboMap.getMap();
    const latlng = [p.lat, p.lon];
    if (!userMarker) {
      const icon = L.divIcon({
        className: 'user-position-icon',
        html: '<div style="width:16px;height:16px;border-radius:50%;background:#ff7a1a;border:3px solid white;box-shadow:0 0 6px rgba(0,0,0,.5)"></div>',
        iconSize: [16, 16],
      });
      userMarker = L.marker(latlng, { icon, zIndexOffset: 1000 }).addTo(map);
      accuracyCircle = L.circle(latlng, { radius: p.accuracy, color: '#ff7a1a', weight: 1, fillOpacity: 0.08 }).addTo(map);
    } else {
      userMarker.setLatLng(latlng);
      accuracyCircle.setLatLng(latlng).setRadius(p.accuracy);
    }
  }

  /** Centraliza o mapa na posição atual do usuário ("Centralizar em minha localização"). */
  function centerOnUser() {
    if (!lastPosition) {
      ArboApp.toast('Aguardando sinal de GPS…', 'error');
      return;
    }
    ArboMap.getMap().setView([lastPosition.lat, lastPosition.lon], 17, { animate: true });
  }

  // -------------------- Trilha (tracking) --------------------

  let trackLine = null;

  function startTrack() {
    track.recording = true;
    track.paused = false;
    track.points = [];
    track.distanceM = 0;
    track.maxSpeedKmh = 0;
    track.startTime = Date.now();
    track.elapsedBeforePause = 0;
    track.id = ArboOffline.uid('track');

    if (trackLine) ArboMap.getMap().removeLayer(trackLine);
    trackLine = L.polyline([], { color: '#ff7a1a', weight: 4 }).addTo(ArboMap.getMap());

    track.timerHandle = setInterval(updateTrackTimer, 1000);

    document.getElementById('btn-track-start').disabled = true;
    document.getElementById('btn-track-pause').disabled = false;
    document.getElementById('btn-track-stop').disabled = false;
    ArboApp.toast('Gravação de trilha iniciada.', 'success');
  }

  function pauseTrack() {
    track.paused = !track.paused;
    document.getElementById('btn-track-pause').innerHTML = track.paused
      ? '<i class="bi bi-play-fill"></i> Continuar'
      : '<i class="bi bi-pause-fill"></i> Pausar';
  }

  async function stopTrack() {
    track.recording = false;
    clearInterval(track.timerHandle);

    // Salva a trilha finalizada no armazenamento offline (autosave).
    if (track.points.length > 1) {
      await ArboOffline.save('tracks', track.id, {
        points: track.points,
        distanceM: track.distanceM,
        durationMs: Date.now() - track.startTime,
        maxSpeedKmh: track.maxSpeedKmh,
        createdAt: track.startTime,
      });
      ArboApp.toast('Trilha salva no dispositivo.', 'success');
    }

    document.getElementById('btn-track-start').disabled = false;
    document.getElementById('btn-track-pause').disabled = true;
    document.getElementById('btn-track-stop').disabled = true;
    document.getElementById('btn-track-pause').innerHTML = '<i class="bi bi-pause-fill"></i> Pausar';
  }

  function addTrackPoint(p) {
    const prev = track.points[track.points.length - 1];
    if (prev) {
      const d = ArboMap.getMap().distance
        ? ArboMap.getMap().distance([prev.lat, prev.lon], [p.lat, p.lon])
        : haversine(prev.lat, prev.lon, p.lat, p.lon);
      track.distanceM += d;
    }
    const speedKmh = p.speed != null ? p.speed * 3.6 : 0;
    track.maxSpeedKmh = Math.max(track.maxSpeedKmh, speedKmh);
    track.points.push({ lat: p.lat, lon: p.lon, ele: p.altitude, time: p.time, speed: speedKmh });

    trackLine.addLatLng([p.lat, p.lon]);
    updateTrackStatsDisplay();
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function updateTrackTimer() {
    updateTrackStatsDisplay();
  }

  function updateTrackStatsDisplay() {
    const elapsedMs = track.recording ? (Date.now() - track.startTime) : 0;
    const h = String(Math.floor(elapsedMs / 3600000)).padStart(2, '0');
    const m = String(Math.floor((elapsedMs % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((elapsedMs % 60000) / 1000)).padStart(2, '0');
    document.getElementById('track-time').textContent = `${h}:${m}:${s}`;
    document.getElementById('track-dist').textContent = formatDistance(track.distanceM);
    const avgKmh = elapsedMs > 0 ? (track.distanceM / 1000) / (elapsedMs / 3600000) : 0;
    document.getElementById('track-avg').textContent = `${avgKmh.toFixed(1)} km/h`;
    document.getElementById('track-max').textContent = `${track.maxSpeedKmh.toFixed(1)} km/h`;
  }

  function formatDistance(m) {
    return m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(2)} km`;
  }

  function getCurrentTrack() { return track; }
  function getLastPosition() { return lastPosition; }

  return {
    startWatching, centerOnUser, startTrack, pauseTrack, stopTrack,
    getCurrentTrack, getLastPosition, formatDistance,
  };
})();
