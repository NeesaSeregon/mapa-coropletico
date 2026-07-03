# Documentación técnica — Mapa Coroplético España

Aplicación web que dibuja un mapa coroplético interactivo de España (estilo RTVE
Elecciones), con datos de población a tres niveles administrativos: comunidades
autónomas, provincias y municipios.

## 1. Qué hace

- Muestra un mapa SVG de España con la proyección cónica compuesta que usa
  RTVE (Canarias reubicada bajo la Península, en un recuadro con borde
  punteado).
- Tres modos de vista, seleccionables con botones: **Provincias**,
  **Comunidades Autónomas** y **Municipios**.
- Cada región se colorea según su población, con una escala de color
  cuantílica (7 clases, tonos de azul).
- Al pasar el ratón sobre una región aparece un tooltip con su nombre y
  población. Al hacer clic se abre un panel inferior con el nombre de la
  zona seleccionada.
- Zoom y pan con la rueda/arrastre del ratón, y un botón "Reset zoom".
- La vista de municipios (~8.213 polígonos) carga sus datos de forma perezosa
  (solo al seleccionar esa pestaña) y se renderiza sobre `<canvas>` en lugar
  de SVG por rendimiento.

## 2. Stack tecnológico

| Pieza | Elección | Motivo |
|---|---|---|
| Framework | Angular 21 (standalone components, signals) | Base del proyecto, sin NgModules |
| Visualización | D3.js v7 | Proyección geográfica, escalas de color, zoom, quadtree |
| Proyección | `d3-composite-projections` → `geoConicConformalSpain` | Composición Península + Canarias como hace RTVE |
| Datos cartográficos | `es-atlas` (topología IGN oficial, formato TopoJSON) | Un único paquete cubre provincias, comunidades y municipios |
| Formato de malla | `topojson-client` | Convierte TopoJSON → GeoJSON y genera las mallas de fronteras compartidas (`mesh`) |
| Estilos | SCSS por componente | Convención Angular estándar |
| Testing | Vitest (vía `ng test`) | Configurado por el CLI, sin tests propios todavía |

No hay backend: es una SPA 100% cliente que sirve JSON estáticos desde `public/assets/`.

## 3. Estructura del proyecto

```
mapa-coropletico/
├── public/assets/
│   ├── provinces.json              # TopoJSON: provincias + comunidades (es-atlas)
│   ├── municipalities.json         # TopoJSON: ~8.213 municipios (1.8 MB)
│   ├── provincias-poblacion.json   # { "Cádiz": 1261420, ... }
│   ├── comunidades-poblacion.json  # { "Andalucía": ..., ... }
│   ├── municipios-poblacion.json   # { "04001": 1234, ... } (código INE → habitantes)
│   ├── pobmun25.xlsx               # Fuente original INE (padrón municipal 2025)
│   └── poblacion, provincias y comunidades.xlsx  # Fuente original INE (agregados)
├── src/
│   ├── main.ts                     # bootstrap de la SPA
│   ├── app/
│   │   ├── app.ts / app.html / app.scss   # Shell: cabecera + <app-mapa>
│   │   ├── app.config.ts                  # Providers globales (error listeners)
│   │   └── components/mapa/
│   │       ├── mapa.ts             # Toda la lógica D3 (single component, ~615 líneas)
│   │       ├── mapa.html           # Controles + contenedor del SVG/canvas
│   │       └── mapa.scss
```

No hay servicios, pipes ni módulos adicionales: toda la lógica vive en
`MapaComponent`. Los `.xlsx` en `public/assets` son la fuente original de
datos del INE; no hay un script de conversión en el repo — los `.json` de
población parecen haberse generado manualmente/puntualmente a partir de ellos
(no hay pipeline reproducible todavía, ver §7).

## 4. `MapaComponent`: arquitectura interna

Es un componente standalone sin dependencias de servicios externos. Toda la
lógica de D3 vive encapsulada aquí, siguiendo el patrón decidido para el
proyecto (ver memoria): la lógica del mapa queda contenida en un componente
Angular dedicado.

### 4.1 Estado (signals)

- `modoVista: Signal<'provincias' | 'comunidades' | 'municipios'>` — vista activa.
- `cargando: Signal<boolean>` — true mientras se cargan los datos de municipios.
- `zonaSeleccionada: Signal<string | null>` — región marcada por clic (alimenta el panel inferior).
- `mapListo` (privado) — se activa en `afterNextRender` para no intentar
  dibujar antes de que el `<div>` contenedor exista en el DOM.

Un único `effect()` reacciona a `modoVista` y dispara `renderizarMapa()`
cada vez que cambia el modo (una vez que `mapListo` es true).

### 4.2 Caches

Cada TopoJSON y cada JSON de población se piden una sola vez por sesión
(`topoCache`, `topoMunicipiosCache`, `pobMunicipiosCache`,
`pobProvinciasCache`, `pobComunidadesCache`) y se reutilizan al cambiar de
vista, evitando refetch.

### 4.3 Flujo de renderizado

`renderizarMapa(modo)` limpia el contenedor (elimina `<svg>`/`<canvas>`
previos) y despacha a una de dos rutas:

**a) Provincias / Comunidades — `renderizarNivel()`**
1. Carga (o reutiliza) `provinces.json` y el JSON de población correspondiente.
2. Extrae el `objects['provinces']` o `objects['autonomous_regions']` del
   mismo TopoJSON (un solo fichero cubre ambos niveles).
3. Construye la proyección con `geoConicConformalSpain().fitSize(...)`.
4. Dibuja, en este orden, sobre un `<g>` con zoom D3 aplicado:
   fondo de tierra → regiones coloreadas (con hover/click) → malla de
   fronteras internas → máscara de océano (evenodd, recorta cualquier
   relleno que se salga de la costa) → línea de costa → bordes discontinuos
   del recuadro de Canarias.

**b) Municipios — `renderizarMunicipios()`** (más compleja, optimizada para ~8.213 polígonos)
1. Carga perezosa de `municipalities.json` + `municipios-poblacion.json`
   (y también `provinces.json`, para encajar el `fitSize` con el contorno
   provincial en vez del de municipios, y así mantener el mismo encuadre
   entre vistas).
2. Repara anillos con orientación invertida (`repararGiroAnillos`) antes de
   proyectar: un artefacto de simplificación del TopoJSON puede hacer que
   d3-geo interprete un polígono como "todo el globo menos esa área".
3. En vez de miles de `<path>` SVG, los rellenos se pintan en un único
   `<canvas>` (`Path2D` precalculado por municipio, cacheado para no
   reproyectar geometría en cada frame de zoom).
4. Los redibujados de canvas por zoom/pan se coalescen a un máximo de uno
   por frame vía `requestAnimationFrame`.
5. El hover se resuelve con un **quadtree D3** sobre los centroides
   (búsqueda O(log n) del candidato más cercano) confirmado con
   `ctx.isPointInPath` sobre su `Path2D` exacto — preciso a cualquier nivel
   de zoom, sin radio de tolerancia fijo.
6. El municipio bajo el cursor se resalta con un único `<path>` SVG
   superpuesto (más claro + contorno oscuro), evitando tocar el canvas para
   el highlight.
7. Un `<rect>` transparente cubre todo el SVG y concentra los listeners de
   mousemove/click, delegando la detección al quadtree.

### 4.4 Rendimiento: fuera de la zona de Angular

Todos los listeners de alta frecuencia (zoom, mousemove sobre regiones o
sobre el overlay de municipios) se registran dentro de
`ngZone.runOutsideAngular(...)`. Angular no dispara change detection en cada
movimiento de ratón; solo se vuelve a entrar en la zona (`ngZone.run(...)`)
cuando de verdad cambia estado de Angular (clic → `zonaSeleccionada`). El
tooltip se actualiza manipulando el DOM directamente (`el.textContent`,
`el.style.left/top`), no con signals, por el mismo motivo.

### 4.5 Colores

- Provincias/Comunidades: `d3.scaleQuantile` con `d3.schemeBlues[7]`.
- Municipios: `d3.scaleQuantile` con un rango muestreado de
  `d3.interpolateBlues` entre 0.35 y 1.0, para evitar los azules casi
  blancos que se pierden contra el fondo del mapa.
- Regiones sin dato de población caen a un gris neutro (`#d0d0d0` /
  `#dce8f5`).

### 4.6 Identificación de regiones

- Provincias/Comunidades: `properties.name` (nombre oficial de es-atlas, ej.
  `"Valencia/València"`, `"Araba/Álava"`).
- Municipios: `feature.id`, código INE de 5 dígitos (con padding), del cual
  los 2 primeros dígitos dan el código de provincia — mapeado a nombre vía
  la tabla `codigosProvincias` embebida en el componente (usada también para
  mostrar la provincia en el tooltip de municipios sin dato de población).

## 5. Fuentes de datos

- **Cartografía**: paquete npm `es-atlas` (datos oficiales IGN), que trae
  `provinces.json` (provincias + comunidades autónomas en un mismo TopoJSON)
  y `municipalities.json`.
- **Población**: ficheros del INE (`pobmun25.xlsx` = padrón municipal;
  `poblacion, provincias y comunidades.xlsx` = agregados por provincia y
  CCAA), convertidos a los JSON planos que consume el componente. `xlsx`
  está en devDependencies, lo que sugiere que la conversión se hizo con un
  script/REPL puntual usando esa librería, no versionado en el repo.

## 6. Cómo ejecutar

```bash
npm install
npm start        # ng serve → http://localhost:4200
npm run build     # build de producción a dist/
npm test          # Vitest
```

## 7. Estado actual y huecos conocidos

- **Sin pipeline de datos reproducible**: los `.json` de población en
  `public/assets` no tienen un script versionado que los regenere desde los
  `.xlsx`. Si el INE publica una actualización, hoy tocaría regenerar los
  JSON a mano.
- **Sin tests propios**: `ng test` está configurado (Vitest) pero no hay
  specs de `MapaComponent` todavía.
- **`app.config.ts`** solo registra `provideBrowserGlobalErrorListeners()`;
  no hay routing ni HttpClient configurado (los JSON se cargan con
  `d3.json`, no con `HttpClient`).
- **Título fijo**: la cabecera dice "Población por provincia · 2023"
  aunque ahora hay tres modos de vista — desactualizado respecto al alcance
  actual.
- **Un solo componente concentra toda la lógica** (~615 líneas). Es
  deliberado según el patrón decidido para el proyecto (mapa como
  componente Angular dedicado que encapsula D3), pero si se añaden más
  métricas o niveles, convendría extraer los helpers de dibujo (fondo,
  costa, máscara océano, bordes inset) a un módulo D3 puro reutilizable.
- **Patrón de datos por métrica**: actualmente cada nivel solo pinta
  población. El objetivo declarado del proyecto es soportar múltiples
  métricas por región (ver memoria del proyecto) — eso todavía no está
  implementado como selector de métrica, solo como estructura de datos
  compatible.

## 8. Convenciones a mantener (para futuras iteraciones)

- Los datos se inyectan/cargan como JSON externo, nunca hardcodeados en el
  componente — así cambiar de fuente (INE, tiempo real, etc.) no toca la
  lógica de render.
- Cualquier interacción de alta frecuencia (hover, zoom, pan) debe ir fuera
  de `NgZone` y tocar el DOM directamente, no signals — es la única forma en
  que la vista de municipios rinde con miles de geometrías.
- Para conjuntos grandes de geometría (>1000 features), preferir `<canvas>`
  con `Path2D` cacheado sobre `<path>` SVG individuales.
