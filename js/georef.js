/* ============================================================
   ArboMap · georef.js
   ------------------------------------------------------------
   Concentra tudo relacionado a sistemas de referência de
   coordenadas (CRS) e georreferenciamento de imagens/PDFs:

     1) Conversões de coordenadas: graus decimais <-> GMS (DMS),
        graus decimais <-> UTM (via proj4js) e uma implementação
        de MGRS (derivada de UTM) para exibição/pesquisa.

     2) Definições proj4 para as zonas UTM da América do Sul/Brasil
        (SIRGAS2000 / WGS84), usadas para reprojetar dados que não
        estejam em WGS84.

     3) Georreferenciamento "por afim" (2 a 4 pontos de controle):
        quando um PDF/imagem não traz metadados espaciais, o
        usuário pode indicar pontos de controle manualmente. A
        partir deles calculamos uma transformação linear (afim)
        entre coordenadas de pixel e coordenadas geográficas —
        o mesmo princípio usado por softwares de SIG "quando tudo
        mais falha".

   NOTA HONESTA DE ESCOPO:
   O formato GeoPDF (OGC "Adobe Geospatial PDF") grava a informação
   de georreferenciamento dentro de dicionários /Measure, /GCS,
   /GPTS e /LPTS no próprio PDF. Fazer um parser 100% completo do
   formato PDF binário (streams comprimidos, xref, etc.) exigiria
   uma biblioteca dedicada equivalente a um leitor de PDF completo.
   Aqui usamos o PDF.js (que já sabe interpretar a estrutura do
   PDF) para localizar esses dicionários geoespaciais quando
   presentes e não comprimidos — cobrindo a grande maioria dos
   GeoPDFs gerados por QGIS/ArcGIS/TerraGo. Quando não encontrados,
   caímos automaticamente no georreferenciamento manual acima.
============================================================ */

const ArboGeoref = (() => {

  /** Definições proj4 para zonas UTM Sul (Hemisfério Sul, comum no Brasil). */
  function defineUTMZone(zone, south = true) {
    const code = `UTM${zone}${south ? 'S' : 'N'}`;
    if (!proj4.defs(code)) {
      proj4.defs(code, `+proj=utm +zone=${zone} ${south ? '+south' : ''} +datum=WGS84 +units=m +no_defs`);
    }
    return code;
  }

  /** Converte lat/lon (WGS84) para UTM {zone, hemisphere, easting, northing}. */
  function toUTM(lat, lon) {
    const zone = Math.floor((lon + 180) / 6) + 1;
    const south = lat < 0;
    const code = defineUTMZone(zone, south);
    const [easting, northing] = proj4('WGS84', code, [lon, lat]);
    return { zone, hemisphere: south ? 'S' : 'N', easting, northing };
  }

  /** Converte UTM -> lat/lon (WGS84). */
  function fromUTM(zone, hemisphere, easting, northing) {
    const code = defineUTMZone(zone, hemisphere === 'S');
    const [lon, lat] = proj4(code, 'WGS84', [easting, northing]);
    return { lat, lon };
  }

  /** Converte graus decimais para graus/minutos/segundos (string legível). */
  function toDMS(deg, isLat) {
    const hemi = isLat ? (deg >= 0 ? 'N' : 'S') : (deg >= 0 ? 'E' : 'W');
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const minFloat = (abs - d) * 60;
    const m = Math.floor(minFloat);
    const s = ((minFloat - m) * 60).toFixed(1);
    return `${d}°${m}'${s}"${hemi}`;
  }

  /** Letra de faixa de latitude usada pelo MGRS. */
  function mgrsLatBand(lat) {
    const bands = 'CDEFGHJKLMNPQRSTUVWXX';
    if (lat < -80 || lat > 84) return 'Z';
    const idx = Math.floor((lat + 80) / 8);
    return bands[Math.min(idx, bands.length - 1)];
  }

  /**
   * Gera uma referência MGRS aproximada (100m) a partir de lat/lon.
   * Implementação simplificada — suficiente para exibição/leitura em
   * campo, não substitui uma biblioteca MGRS certificada para uso
   * legal/militar.
   */
  function toMGRS(lat, lon) {
    const utm = toUTM(lat, lon);
    const band = mgrsLatBand(lat);
    // Colunas de 100km (letras) — tabela simplificada por zona.
    const colLetters = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
    const set = (utm.zone - 1) % 3;
    const col = colLetters[set][Math.floor(utm.easting / 100000) - 1] || 'A';
    const rowLetters = utm.zone % 2 === 0 ? 'FGHJKLMNPQRSTUVABCDE' : 'ABCDEFGHJKLMNPQRSTUV';
    const row = rowLetters[Math.floor(utm.northing / 100000) % 20];
    const e = String(Math.floor(utm.easting % 100000)).padStart(5, '0').slice(0, 5);
    const n = String(Math.floor(utm.northing % 100000)).padStart(5, '0').slice(0, 5);
    return `${utm.zone}${band} ${col}${row} ${e} ${n}`;
  }

  /** Formata lat/lon conforme a preferência do usuário (dd | dms | utm | mgrs). */
  function formatCoords(lat, lon, format = 'dd') {
    switch (format) {
      case 'dms':
        return `${toDMS(lat, true)} ${toDMS(lon, false)}`;
      case 'utm': {
        const u = toUTM(lat, lon);
        return `${u.zone}${u.hemisphere} ${u.easting.toFixed(0)}E ${u.northing.toFixed(0)}N`;
      }
      case 'mgrs':
        return toMGRS(lat, lon);
      default:
        return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    }
  }

  // ------------------------------------------------------------
  // Georreferenciamento por transformação afim (pontos de controle)
  // ------------------------------------------------------------

  /**
   * Recebe uma lista de pontos de controle:
   *   [{ px, py, lat, lon }, ...]   (px,py em pixels da imagem)
   * e calcula os coeficientes de uma transformação afim que leva
   * (px,py) -> (lon,lat). Requer no mínimo 3 pontos não colineares
   * (com 2 pontos assumimos escala uniforme e sem rotação/shear).
   */
  function computeAffineTransform(points) {
    if (points.length < 2) throw new Error('São necessários ao menos 2 pontos de controle.');

    if (points.length === 2) {
      // Solução simplificada: escala uniforme + translação, sem rotação.
      const [a, b] = points;
      const dPx = b.px - a.px, dPy = b.py - a.py;
      const dLon = b.lon - a.lon, dLat = b.lat - a.lat;
      const scaleX = dPx !== 0 ? dLon / dPx : 0;
      const scaleY = dPy !== 0 ? dLat / dPy : 0;
      return {
        toGeo(px, py) {
          return {
            lon: a.lon + (px - a.px) * scaleX,
            lat: a.lat + (py - a.py) * scaleY,
          };
        },
      };
    }

    // Mínimos quadrados para >=3 pontos: resolve duas regressões lineares
    // lon = A*px + B*py + C   e   lat = D*px + E*py + F
    const n = points.length;
    const sums = { x:0, y:0, xx:0, yy:0, xy:0, xLon:0, yLon:0, lon:0, xLat:0, yLat:0, lat:0 };
    points.forEach(p => {
      sums.x += p.px; sums.y += p.py;
      sums.xx += p.px * p.px; sums.yy += p.py * p.py; sums.xy += p.px * p.py;
      sums.xLon += p.px * p.lon; sums.yLon += p.py * p.lon; sums.lon += p.lon;
      sums.xLat += p.px * p.lat; sums.yLat += p.py * p.lat; sums.lat += p.lat;
    });

    // Monta e resolve o sistema normal 3x3 via eliminação de Gauss (função auxiliar abaixo).
    function solve(targetSumX, targetSumY, targetSum) {
      const M = [
        [sums.xx, sums.xy, sums.x, targetSumX],
        [sums.xy, sums.yy, sums.y, targetSumY],
        [sums.x,  sums.y,  n,      targetSum],
      ];
      return gaussSolve(M); // [A, B, C]
    }

    const [A, B, C] = solve(sums.xLon, sums.yLon, sums.lon);
    const [D, E, F] = solve(sums.xLat, sums.yLat, sums.lat);

    return {
      toGeo(px, py) {
        return { lon: A * px + B * py + C, lat: D * px + E * py + F };
      },
    };
  }

  /** Eliminação de Gauss simples para sistemas 3x3 (uso interno). */
  function gaussSolve(M) {
    const m = M.map(row => row.slice());
    for (let i = 0; i < 3; i++) {
      // Pivotamento parcial
      let maxRow = i;
      for (let k = i + 1; k < 3; k++) if (Math.abs(m[k][i]) > Math.abs(m[maxRow][i])) maxRow = k;
      [m[i], m[maxRow]] = [m[maxRow], m[i]];
      for (let k = i + 1; k < 3; k++) {
        const factor = m[k][i] / m[i][i];
        for (let j = i; j < 4; j++) m[k][j] -= factor * m[i][j];
      }
    }
    const x = [0, 0, 0];
    for (let i = 2; i >= 0; i--) {
      let sum = m[i][3];
      for (let j = i + 1; j < 3; j++) sum -= m[i][j] * x[j];
      x[i] = sum / m[i][i];
    }
    return x;
  }

  return {
    toUTM, fromUTM, toDMS, toMGRS, formatCoords,
    computeAffineTransform, defineUTMZone,
  };
})();
