/* ============================================================
   ArboMap · export.js
   ------------------------------------------------------------
   Funções de exportação de dados (trilhas, waypoints, geometrias
   de desenho e ferramentas florestais) nos formatos GPX, GeoJSON,
   KML, CSV e um relatório PDF simples. Todas as exportações geram
   o arquivo inteiramente no navegador (sem servidor) e disparam
   o download via Blob + <a download>.
============================================================ */

const ArboExport = (() => {

  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  // --------------------------------------------------------
  // GPX
  // --------------------------------------------------------

  /** Constrói um GPX válido a partir de waypoints e/ou uma trilha (track). */
  function buildGPX({ waypoints = [], track = null }) {
    let gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="ArboMap" xmlns="http://www.topografix.com/GPX/1/1">\n`;

    waypoints.forEach(w => {
      gpx += `  <wpt lat="${w.lat}" lon="${w.lon}">\n`;
      if (w.ele != null) gpx += `    <ele>${w.ele}</ele>\n`;
      if (w.time) gpx += `    <time>${new Date(w.time).toISOString()}</time>\n`;
      gpx += `    <name>${escapeXML(w.name || 'Waypoint')}</name>\n`;
      if (w.desc) gpx += `    <desc>${escapeXML(w.desc)}</desc>\n`;
      gpx += `  </wpt>\n`;
    });

    if (track && track.points?.length) {
      gpx += `  <trk>\n    <name>Trilha ArboMap</name>\n    <trkseg>\n`;
      track.points.forEach(p => {
        gpx += `      <trkpt lat="${p.lat}" lon="${p.lon}">\n`;
        if (p.ele != null) gpx += `        <ele>${p.ele}</ele>\n`;
        gpx += `        <time>${new Date(p.time).toISOString()}</time>\n      </trkpt>\n`;
      });
      gpx += `    </trkseg>\n  </trk>\n`;
    }

    gpx += `</gpx>`;
    return gpx;
  }

  function escapeXML(str) {
    return String(str).replace(/[<>&'"]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', "'":'&apos;', '"':'&quot;' }[c]));
  }

  // --------------------------------------------------------
  // GeoJSON
  // --------------------------------------------------------

  function buildGeoJSON({ waypoints = [], track = null, shapes = null, forestry = null }) {
    const features = [];

    waypoints.forEach(w => features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [w.lon, w.lat] },
      properties: { name: w.name, description: w.desc, date: w.time ? new Date(w.time).toISOString() : null, kind: 'waypoint' },
    }));

    if (track?.points?.length) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: track.points.map(p => [p.lon, p.lat]) },
        properties: { kind: 'track', distanceM: track.distanceM, durationMs: track.durationMs, maxSpeedKmh: track.maxSpeedKmh },
      });
    }

    if (shapes?.features) features.push(...shapes.features);
    if (forestry?.features) features.push(...forestry.features);

    return { type: 'FeatureCollection', features };
  }

  // --------------------------------------------------------
  // KML (via tokml, a partir do GeoJSON já montado)
  // --------------------------------------------------------

  function buildKML(geojson) {
    return tokml(geojson, { name: 'name', description: 'description' });
  }

  // --------------------------------------------------------
  // CSV (waypoints)
  // --------------------------------------------------------

  function buildCSV(waypoints) {
    const header = 'nome,latitude,longitude,data,descricao\n';
    const rows = waypoints.map(w =>
      [w.name, w.lat, w.lon, w.time ? new Date(w.time).toISOString() : '', (w.desc || '').replace(/,/g, ';')].join(',')
    );
    return header + rows.join('\n');
  }

  // --------------------------------------------------------
  // Ponto de entrada único: coleta os dados atuais e exporta
  // --------------------------------------------------------

  async function exportAll(format) {
    const waypoints = await ArboOffline.getAll('waypoints');
    const shapesRec = await ArboOffline.get('shapes', 'drawn-shapes');
    const forestryRec = await ArboOffline.get('forestry', 'forestry-features');
    const tracks = await ArboOffline.getAll('tracks');
    const lastTrack = tracks[tracks.length - 1] || null;

    const geojson = buildGeoJSON({
      waypoints, track: lastTrack, shapes: shapesRec?.geojson, forestry: forestryRec?.geojson,
    });

    switch (format) {
      case 'gpx':
        downloadBlob(buildGPX({ waypoints, track: lastTrack }), 'arbomap_dados.gpx', 'application/gpx+xml');
        break;
      case 'geojson':
        downloadBlob(JSON.stringify(geojson, null, 2), 'arbomap_dados.geojson', 'application/geo+json');
        break;
      case 'kml':
        downloadBlob(buildKML(geojson), 'arbomap_dados.kml', 'application/vnd.google-earth.kml+xml');
        break;
      case 'csv':
        downloadBlob(buildCSV(waypoints), 'arbomap_waypoints.csv', 'text/csv');
        break;
      case 'pdf':
        await exportPDFReport(waypoints, lastTrack);
        break;
    }
  }

  async function exportTrack(format) {
    const track = ArboGPS.getCurrentTrack();
    if (!track.points.length) { ArboApp.toast('Nenhuma trilha gravada ainda.', 'error'); return; }
    if (format === 'gpx') downloadBlob(buildGPX({ track }), 'trilha.gpx', 'application/gpx+xml');
    if (format === 'geojson') downloadBlob(JSON.stringify(buildGeoJSON({ track }), null, 2), 'trilha.geojson', 'application/geo+json');
    if (format === 'kml') downloadBlob(buildKML(buildGeoJSON({ track })), 'trilha.kml', 'application/vnd.google-earth.kml+xml');
  }

  /**
   * Gera um PDF simples (relatório de campo) com a lista de waypoints
   * e um resumo da trilha, usando a própria API de canvas + PDF.js não
   * é adequada para *gerar* PDF (é um leitor); por isso montamos o PDF
   * manualmente em um canvas e o exportamos como imagem embutida em um
   * PDF mínimo, ou — de forma mais simples e robusta — geramos um HTML
   * imprimível e acionamos a impressão do navegador ("Salvar como PDF"),
   * que é suportado nativamente em todos os navegadores-alvo.
   */
  async function exportPDFReport(waypoints, track) {
    const win = window.open('', '_blank');
    const rows = waypoints.map(w => `<tr><td>${w.name || ''}</td><td>${w.lat.toFixed(6)}</td><td>${w.lon.toFixed(6)}</td><td>${w.time ? new Date(w.time).toLocaleString('pt-BR') : ''}</td></tr>`).join('');
    win.document.write(`
      <html><head><title>Relatório ArboMap</title>
      <style>
        body{ font-family: sans-serif; padding:24px; color:#111; }
        h1{ color:#2d6a4f; } table{ width:100%; border-collapse:collapse; margin-top:16px; }
        th,td{ border:1px solid #ccc; padding:6px 8px; font-size:13px; text-align:left; }
        th{ background:#eef2ec; }
      </style></head><body>
      <h1>Relatório de Campo — ArboMap</h1>
      <p>Gerado em ${new Date().toLocaleString('pt-BR')}</p>
      ${track ? `<p><b>Trilha:</b> ${(track.distanceM/1000).toFixed(2)} km percorridos</p>` : ''}
      <h3>Waypoints (${waypoints.length})</h3>
      <table><thead><tr><th>Nome</th><th>Lat</th><th>Lon</th><th>Data</th></tr></thead><tbody>${rows}</tbody></table>
      <script>window.onload = () => window.print();</script>
      </body></html>`);
    win.document.close();
  }

  return { exportAll, exportTrack, buildGPX, buildGeoJSON, buildKML, buildCSV };
})();
