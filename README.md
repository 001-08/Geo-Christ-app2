# ArboMap

Aplicação web (PWA) para navegação em campo com mapas georreferenciados, voltada para
engenharia florestal. Funciona em desktop, tablet e smartphone, e continua operando
offline após o primeiro carregamento.

## Como testar localmente

Como o app usa Service Worker e módulos ES6, ele precisa ser servido via HTTP (não abra
o `index.html` direto com `file://`). Exemplo simples:

```bash
cd arbomap
python3 -m http.server 8080
# depois abra http://localhost:8080 no navegador
```

Para instalar como PWA: abra no Chrome/Edge (desktop ou Android) e use "Instalar app"
na barra de endereço, ou "Adicionar à tela inicial" no Safari (iOS).

## Estrutura

```
index.html          Estrutura de toda a interface (barras, painéis, modais)
css/style.css        Tema claro/escuro, layout responsivo
js/app.js            Orquestração geral, UI, waypoints, configurações, busca
js/map.js            Mapa Leaflet, camadas base, HUD (bússola/escala/coordenadas)
js/gps.js            Geolocalização em tempo real e gravação de trilha
js/georef.js         Conversão de coordenadas (UTM/MGRS/DMS) e transformação afim
js/pdf.js            Carregamento de GeoPDF/GeoTIFF/imagens/MBTiles/GPX/KML/GeoJSON/Shapefile
js/drawing.js        Ferramentas de desenho, medição e Engenharia Florestal
js/export.js         Exportação GPX/GeoJSON/KML/CSV/PDF
js/offline.js        IndexedDB (LocalForage), Service Worker, autosave
manifest.json        Metadados do PWA
service-worker.js    Cache do app-shell e tiles para uso offline
assets/icons/        Ícones do PWA
```

## O que funciona de verdade

- Mapa com pan/zoom, 3 bases (OSM, satélite Esri, OpenTopoMap) + modo "sem base".
- GPS em tempo real (posição, precisão, velocidade, altitude, direção, horário),
  com botão de centralizar e círculo de precisão.
- Gravação de trilha (iniciar/pausar/continuar/finalizar) com distância, tempo,
  velocidade média/máxima, e exportação em GPX/GeoJSON/KML.
- Waypoints com nome, descrição, foto (câmera do dispositivo), áudio, data e
  coordenadas — tudo salvo automaticamente no IndexedDB.
- Ferramentas de desenho (ponto/linha/polígono/círculo/retângulo) com cálculo
  automático de área/perímetro/comprimento via Turf.js.
- Aba "Engenharia Florestal": talhões (área/perímetro), declividade entre dois
  pontos, marcação de parcelas e árvores com numeração automática, e medição
  de distância entre árvores.
- Importação de GPX, KML, GeoJSON e Shapefile (.zip) — convertidos para camadas
  Leaflet reais.
- Importação de GeoTIFF com leitura de metadados de projeção (via geotiff.js)
  e reprojeção para WGS84 quando o EPSG é reconhecido.
- Importação de MBTiles lendo o SQLite embutido diretamente no navegador
  (via sql.js/WebAssembly), sem precisar de servidor.
- Exportação geral em GPX, GeoJSON, KML, CSV e um relatório para PDF (via
  impressão do navegador).
- PWA instalável, funcionamento offline via Service Worker + IndexedDB,
  modo claro/escuro, menu lateral, barra inferior, barra superior.

## Limitações conhecidas (honestidade de escopo)

1. **GeoPDF**: o parser lê os dicionários `/GPTS` e `/LPTS` (padrão OGC Geospatial
   PDF) quando estão em texto não comprimido no arquivo — cobre a maioria dos
   GeoPDFs gerados por QGIS/ArcGIS/TerraGo. PDFs com esses dicionários dentro de
   *object streams* comprimidos não são detectados automaticamente; nesse caso
   o app abre o **georreferenciamento manual** (2+ pontos de controle), que é o
   mesmo recurso que aplicativos como o Avenza oferecem quando a detecção falha.
2. **MGRS**: a implementação é simplificada (suficiente para leitura/navegação
   em campo), não é uma biblioteca MGRS certificada para uso legal.
3. **Rotação do mapa**: aplicada via transformação CSS (não há rotação nativa
   de tiles sem um plugin pesado adicional); funciona bem para orientação visual.
4. **Exportação em PDF**: usa a função de impressão do navegador ("Salvar como
   PDF"), por ser a forma mais robusta e leve de gerar PDF 100% no cliente.
5. **Mapas > 500MB**: o navegador consegue armazenar isso via IndexedDB (o
   limite depende do espaço livre em disco do dispositivo, não da aplicação),
   mas a *renderização* de rasters muito grandes deve, sempre que possível,
   usar MBTiles/tiles (carregamento sob demanda) em vez de uma única imagem
   gigante, que é mais pesada para o navegador desenhar de uma vez.
6. As bibliotecas (Leaflet, PDF.js, Turf.js, proj4, geotiff.js, sql.js, shpjs,
   togeojson, tokml) são carregadas via CDN. O Service Worker as armazena em
   cache após o primeiro carregamento para uso offline subsequente.
