import { Component, ElementRef, NgZone, signal, viewChild, afterNextRender, effect, inject } from '@angular/core';
import * as d3 from 'd3';
import * as topojson from 'topojson-client';
import { geoConicConformalSpain } from 'd3-composite-projections';
import type { Topology, GeometryCollection } from 'topojson-specification';

export type ModoVista = 'provincias' | 'comunidades' | 'municipios';

interface PropiedadesRegion {
  name: string;
}

// Record<string, ...> satisface la restricción Objects<GeoJsonProperties> de topojson-specification
type TopoGenerico = Topology<Record<string, GeometryCollection<PropiedadesRegion>>>;
type TopoProvincias = TopoGenerico;
type TopoMunicipios = TopoGenerico;

@Component({
  selector: 'app-mapa',
  templateUrl: './mapa.html',
  styleUrl: './mapa.scss'
})
export class MapaComponent {
  private contenedor = viewChild.required<ElementRef<HTMLDivElement>>('contenedor');
  private tooltipEl = viewChild.required<ElementRef<HTMLDivElement>>('tooltipEl');
  private readonly ngZone = inject(NgZone);

  modoVista = signal<ModoVista>('provincias');
  cargando = signal(false);
  zonaSeleccionada = signal<string | null>(null);

  private mapListo = signal(false);
  private topoCache: TopoProvincias | null = null;
  private topoMunicipiosCache: TopoMunicipios | null = null;
  private pobMunicipiosCache: Record<string, number> | null = null;
  private pobProvinciasCache: Record<string, number> | null = null;
  private pobComunidadesCache: Record<string, number> | null = null;
  private svgRef: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  private zoomBehavior: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;

  private readonly codigosProvincias: Record<string, string> = {
    '01': 'Araba/Álava',  '02': 'Albacete',          '03': 'Alacant/Alicante',
    '04': 'Almería',      '05': 'Ávila',              '06': 'Badajoz',
    '07': 'Illes Balears','08': 'Barcelona',          '09': 'Burgos',
    '10': 'Cáceres',      '11': 'Cádiz',              '12': 'Castelló/Castellón',
    '13': 'Ciudad Real',  '14': 'Córdoba',            '15': 'A Coruña',
    '16': 'Cuenca',       '17': 'Girona',             '18': 'Granada',
    '19': 'Guadalajara',  '20': 'Gipuzkoa',           '21': 'Huelva',
    '22': 'Huesca',       '23': 'Jaén',               '24': 'León',
    '25': 'Lleida',       '26': 'La Rioja',           '27': 'Lugo',
    '28': 'Madrid',       '29': 'Málaga',             '30': 'Murcia',
    '31': 'Navarra/Nafarroa', '32': 'Ourense',       '33': 'Asturias',
    '34': 'Palencia',     '35': 'Las Palmas',         '36': 'Pontevedra',
    '37': 'Salamanca',    '38': 'Santa Cruz de Tenerife', '39': 'Cantabria',
    '40': 'Segovia',      '41': 'Sevilla',            '42': 'Soria',
    '43': 'Tarragona',    '44': 'Teruel',             '45': 'Toledo',
    '46': 'Valencia/València', '47': 'Valladolid',   '48': 'Bizkaia',
    '49': 'Zamora',       '50': 'Zaragoza',           '51': 'Ceuta',
    '52': 'Melilla'
  };

  constructor() {
    afterNextRender(() => this.mapListo.set(true));
    effect(() => {
      const modo = this.modoVista();
      if (this.mapListo()) void this.renderizarMapa(modo);
    }, { allowSignalWrites: true });
  }

  cambiarModo(modo: ModoVista): void {
    this.zonaSeleccionada.set(null);
    this.ocultarTooltip();
    this.modoVista.set(modo);
  }

  resetearZoom(): void {
    if (this.svgRef && this.zoomBehavior) {
      this.svgRef.transition().duration(400)
        .call(this.zoomBehavior.transform, d3.zoomIdentity);
    }
  }

  // ── helpers privados ──────────────────────────────────────────────────────

  private posicionRelativa(event: MouseEvent): { x: number; y: number } {
    const rect = this.contenedor().nativeElement.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /**
   * Manipula el tooltip directamente por DOM (sin signals) para que seguir el
   * cursor en mousemove no dispare change detection de Angular en cada píxel:
   * con miles de paths de municipios en pantalla, eso es lo que causaba el lag.
   */
  private mostrarTooltip(texto: string, x: number, y: number): void {
    const el = this.tooltipEl().nativeElement;
    el.textContent = texto;
    el.style.left = `${x + 14}px`;
    el.style.top = `${y - 36}px`;
    el.style.display = 'block';
  }

  private ocultarTooltip(): void {
    this.tooltipEl().nativeElement.style.display = 'none';
  }

  private formatPoblacion(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M hab.`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k hab.`;
    return `${n} hab.`;
  }

  private readonly formatoMiles = new Intl.NumberFormat('es-ES');

  private formatPoblacionCompleta(n: number): string {
    return `${this.formatoMiles.format(n)} hab.`;
  }

  private crearEscalaColor(datos: Record<string, number>): d3.ScaleQuantile<string, never> {
    return d3.scaleQuantile<string>()
      .domain(Object.values(datos))
      .range([...d3.schemeBlues[7]]);
  }

  /**
   * Algunos municipios del topojson traen un anillo con el sentido de giro
   * invertido (probablemente un artefacto de la simplificación). d3-geo usa
   * convenciones esféricas y, ante un anillo invertido, lo interpreta como
   * "todo el globo menos ese área": el municipio se proyecta como un blob
   * gigante que tapa el resto del mapa dibujado antes que él. Se detecta
   * evaluando cada anillo de forma aislada (geoArea > π ⇒ girado al revés)
   * y se corrige anillo a anillo, no la geometría entera, porque un mismo
   * municipio puede tener un anillo bueno y otro malo (p.ej. multipolígonos
   * con un sliver degenerado junto al polígono real).
   */
  private repararGiroAnillos(geom: GeoJSON.Geometry): void {
    const anilloInvertido = (ring: GeoJSON.Position[]): boolean =>
      d3.geoArea({ type: 'Polygon', coordinates: [ring] }) > Math.PI;

    if (geom.type === 'Polygon') {
      geom.coordinates = geom.coordinates.map(r => anilloInvertido(r) ? [...r].reverse() : r);
    } else if (geom.type === 'MultiPolygon') {
      geom.coordinates = geom.coordinates.map(poly =>
        poly.map(r => anilloInvertido(r) ? [...r].reverse() : r)
      );
    }
  }

  private crearSvgBase(
    el: HTMLDivElement,
    ancho: number,
    alto: number,
    maxZoom: number,
    alZoom?: (transform: d3.ZoomTransform) => void
  ): {
    svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
    g: d3.Selection<SVGGElement, unknown, null, undefined>;
  } {
    // El fondo océano ya no se pinta con un <rect> del SVG (eso taparía el
    // canvas de municipios, que va debajo): lo pone el CSS de .mapa-contenedor.
    const svg = d3.select<HTMLDivElement, unknown>(el)
      .append<SVGSVGElement>('svg')
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('viewBox', `0 0 ${ancho} ${alto}`)
      .attr('preserveAspectRatio', 'xMidYMid meet');

    const g = svg.append('g');

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.8, maxZoom])
      .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        g.attr('transform', event.transform.toString());
        alZoom?.(event.transform);
      });

    // Fuera de la zona de Angular: el zoom/pan dispara este handler en cada
    // frame y no toca ningún estado de Angular, solo el DOM del SVG.
    this.ngZone.runOutsideAngular(() => svg.call(zoom));
    this.svgRef = svg;
    this.zoomBehavior = zoom;
    return { svg, g };
  }

  /** Rellena el territorio de España antes de dibujar las regiones */
  private dibujarFondoTierra(
    g: d3.Selection<SVGGElement, unknown, null, undefined>,
    topo: TopoGenerico,
    path: d3.GeoPath
  ): void {
    const border = topojson.feature(topo, topo.objects['border']);
    g.append('path')
      .datum(border)
      .attr('fill', '#eaedf0')
      .attr('stroke', 'none')
      .attr('pointer-events', 'none')
      .attr('d', path);
  }

  /** Dibuja la línea de costa / frontera exterior encima de todo */
  private dibujarCosta(
    g: d3.Selection<SVGGElement, unknown, null, undefined>,
    topo: TopoGenerico,
    path: d3.GeoPath
  ): void {
    const border = topojson.feature(topo, topo.objects['border']);
    g.append('path')
      .datum(border)
      .attr('fill', 'none')
      .attr('stroke', '#7892a8')
      .attr('stroke-width', 0.7)
      .attr('pointer-events', 'none')
      .attr('d', path);
  }

  /**
   * Máscara océano: rectángulo grande con agujero en forma de España (evenodd).
   * Cubre cualquier fill de región que se haya extendido más allá de la costa
   * por efecto del clipExtent interno de geoConicConformalSpain.
   */
  private dibujarMascaraOceano(
    g: d3.Selection<SVGGElement, unknown, null, undefined>,
    topo: TopoGenerico,
    path: d3.GeoPath,
    ancho: number,
    alto: number
  ): void {
    const border = topojson.feature(topo, topo.objects['border']);
    const borderD = path(border) ?? '';
    const m = 10000;
    g.append('path')
      .attr('d', `M ${-m},${-m} H ${ancho + m} V ${alto + m} H ${-m} Z ${borderD}`)
      .attr('fill', '#f5f7fb')
      .attr('fill-rule', 'evenodd')
      .attr('pointer-events', 'none');
  }

  private dibujarBordesInset(
    g: d3.Selection<SVGGElement, unknown, null, undefined>,
    projection: ReturnType<typeof geoConicConformalSpain>
  ): void {
    g.append('path')
      .attr('d', projection.getCompositionBorders())
      .attr('fill', 'none')
      .attr('stroke', '#8099b0')
      .attr('stroke-width', 0.8)
      .attr('stroke-dasharray', '4,3')
      .attr('pointer-events', 'none');
  }

  // ── render principal ──────────────────────────────────────────────────────

  private async renderizarMapa(modo: ModoVista): Promise<void> {
    const el = this.contenedor().nativeElement;
    d3.select(el).selectAll('svg').remove();
    d3.select(el).selectAll('canvas').remove();
    this.svgRef = null;
    this.zoomBehavior = null;

    if (modo === 'municipios') await this.renderizarMunicipios(el);
    else await this.renderizarNivel(el, modo);
  }

  private async renderizarNivel(el: HTMLDivElement, modo: 'provincias' | 'comunidades'): Promise<void> {
    const ancho = el.clientWidth || 800;
    const alto = el.clientHeight || 500;

    if (!this.topoCache) {
      this.topoCache = await d3.json<TopoProvincias>('/assets/provinces.json') ?? null;
    }
    if (modo === 'provincias' && !this.pobProvinciasCache) {
      this.pobProvinciasCache = await d3.json<Record<string, number>>('/assets/provincias-poblacion.json') ?? null;
    }
    if (modo === 'comunidades' && !this.pobComunidadesCache) {
      this.pobComunidadesCache = await d3.json<Record<string, number>>('/assets/comunidades-poblacion.json') ?? null;
    }
    if (!this.topoCache) return;

    const objeto = modo === 'provincias'
      ? this.topoCache.objects['provinces']
      : this.topoCache.objects['autonomous_regions'];
    const datos = (modo === 'provincias' ? this.pobProvinciasCache : this.pobComunidadesCache) ?? {};

    const coleccion = topojson.feature(this.topoCache, objeto);
    const features = 'features' in coleccion ? coleccion.features : [];
    const mallaBordes = topojson.mesh(this.topoCache, objeto, (a, b) => a !== b);

    const projection = geoConicConformalSpain();
    projection.fitSize([ancho, alto], coleccion);
    const path = d3.geoPath().projection(projection);
    const colorScale = this.crearEscalaColor(datos);

    const { g } = this.crearSvgBase(el, ancho, alto, 12);

    this.dibujarFondoTierra(g, this.topoCache, path);

    // Fuera de la zona de Angular: hover/mousemove sobre las regiones no debe
    // disparar change detection en cada píxel de movimiento del ratón.
    this.ngZone.runOutsideAngular(() => {
      g.selectAll<SVGPathElement, (typeof features)[number]>('.region')
        .data(features)
        .enter()
        .append('path')
        .attr('class', 'region')
        .attr('d', path)
        .attr('fill', d => {
          const valor = datos[d.properties.name];
          return valor != null ? (colorScale(valor) ?? '#d0d0d0') : '#d0d0d0';
        })
        .attr('stroke', '#fff')
        .attr('stroke-width', 0.5)
        .on('mouseover', (event: MouseEvent, d) => this.alHover(event, d, datos))
        .on('mousemove', (event: MouseEvent) => this.alMover(event))
        .on('mouseout', () => this.alSalir())
        .on('click', (_event: MouseEvent, d) => this.ngZone.run(() => this.alHacerClick(d)));
    });

    g.append('path')
      .datum(mallaBordes)
      .attr('fill', 'none')
      .attr('stroke', '#fff')
      .attr('stroke-width', 0.5)
      .attr('pointer-events', 'none')
      .attr('d', path);

    this.dibujarMascaraOceano(g, this.topoCache, path, ancho, alto);
    this.dibujarCosta(g, this.topoCache, path);
    this.dibujarBordesInset(g, projection);
  }

  private async renderizarMunicipios(el: HTMLDivElement): Promise<void> {
    this.cargando.set(true);
    try {
      const ancho = el.clientWidth || 800;
      const alto = el.clientHeight || 500;

      if (!this.topoMunicipiosCache) {
        this.topoMunicipiosCache = await d3.json<TopoMunicipios>('/assets/municipalities.json') ?? null;
      }
      if (!this.pobMunicipiosCache) {
        this.pobMunicipiosCache = await d3.json<Record<string, number>>('/assets/municipios-poblacion.json') ?? null;
      }
      if (!this.topoMunicipiosCache) return;

      const topo = this.topoMunicipiosCache;
      const pob = this.pobMunicipiosCache ?? {};
      const coleccion = topojson.feature(topo, topo.objects['municipalities']);
      const features = 'features' in coleccion ? coleccion.features : [];
      const mallaProvincias = topojson.mesh(topo, topo.objects['provinces'], (a, b) => a !== b);
      const mallaMunicipios = topojson.mesh(topo, topo.objects['municipalities'], (a, b) => a !== b);

      if (!this.topoCache) {
        this.topoCache = await d3.json<TopoProvincias>('/assets/provinces.json') ?? null;
      }

      const projection = geoConicConformalSpain();
      const fitTarget = this.topoCache
        ? topojson.feature(this.topoCache, this.topoCache.objects['provinces'])
        : topojson.feature(topo, topo.objects['border']);
      projection.fitSize([ancho, alto], fitTarget);
      const path = d3.geoPath().projection(projection);

      // Escala cuantil 7 clases: samplea interpolateBlues desde 0.25 (azul visible)
      // hasta 1.0, evitando los azules casi-blancos que se pierden contra el fondo.
      const colorRange = d3.range(7).map(i => d3.interpolateBlues(0.35 + 0.65 * (i / 6)));
      const colorScale = d3.scaleQuantile<string>()
        .domain(Object.values(pob).filter(v => v > 0))
        .range(colorRange);

      const formatPob = this.formatPoblacion;

      // ── Canvas para los rellenos de los municipios ──────────────────────────
      // Pintar 8.213 <path> de SVG individuales obliga al navegador a
      // recomponer miles de nodos del DOM en cada frame de zoom/pan, y a
      // zoom bajo (toda España visible a la vez) eso se nota muchísimo. Un
      // <canvas> es un único destino de rasterizado: cada frame se redibuja
      // de una vez, sin el coste de gestión de miles de elementos del DOM.
      const dpr = window.devicePixelRatio || 1;
      const canvas = d3.select<HTMLDivElement, unknown>(el)
        .append<HTMLCanvasElement>('canvas')
        .attr('width', ancho * dpr)
        .attr('height', alto * dpr)
        .style('width', '100%')
        .style('height', '100%')
        .style('position', 'absolute')
        .style('inset', '0')
        .style('pointer-events', 'none');
      const ctx = canvas.node()!.getContext('2d')!;
      const borderFeature = topojson.feature(topo, topo.objects['border']);
      const borderPath2D = new Path2D(path(borderFeature) ?? '');

      const dMap = new Map<string, string>();
      const fillMap = new Map<string, string>();
      // Path2D precalculado por municipio: evita volver a proyectar (trigonometría
      // de la cónica conforme) las ~8.213 geometrías en cada frame de zoom/pan.
      // Solo se recorre el punto a punto una vez, al cargar; luego cada redibujado
      // reutiliza la forma ya vectorizada y únicamente cambia fillStyle + fill().
      const path2DMap = new Map<string, Path2D>();

      interface CentroidEntry {
        x: number; y: number;
        name: string; nombreProv: string; mid: string;
        poblacion: number | undefined;
      }
      const centroids: CentroidEntry[] = [];

      for (const feat of features) {
        this.repararGiroAnillos(feat.geometry);
        const dVal = path(feat);
        if (!dVal) continue;

        const mid = String(feat.id ?? '');
        const name = feat.properties?.name ?? '';
        const codigoProv = mid.padStart(5, '0').slice(0, 2);
        const nombreProv = this.codigosProvincias[codigoProv] ?? '';
        const poblacion = pob[mid.padStart(5, '0')];
        const fillColor = poblacion != null ? (colorScale(poblacion) ?? '#dce8f5') : '#dce8f5';

        const c = path.centroid(feat);
        if (isFinite(c[0]) && isFinite(c[1])) {
          centroids.push({ x: c[0], y: c[1], name, nombreProv, mid, poblacion });
        }

        dMap.set(mid, dVal);
        fillMap.set(mid, fillColor);
        path2DMap.set(mid, new Path2D(dVal));
      }

      /** Redibuja el canvas entero aplicando la transformación de zoom/pan actual. */
      const redibujarCanvas = (transform: d3.ZoomTransform): void => {
        const nodo = canvas.node()!;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, nodo.width, nodo.height);
        ctx.scale(dpr, dpr);
        ctx.translate(transform.x, transform.y);
        ctx.scale(transform.k, transform.k);

        // Fondo gris tierra, igual que antes hacía dibujarFondoTierra() en SVG.
        ctx.fillStyle = '#eaedf0';
        ctx.fill(borderPath2D);

        // Recorte a la silueta de España: sin esto los paths costeros, que se
        // proyectan ligeramente fuera de la costa, pintarían azul en el océano.
        ctx.save();
        ctx.clip(borderPath2D);
        for (const [mid, fill] of fillMap) {
          const p2d = path2DMap.get(mid);
          if (!p2d) continue;
          ctx.fillStyle = fill;
          ctx.fill(p2d);
        }
        ctx.restore();
        ctx.restore();
      };

      // d3-zoom dispara 'zoom' muchas veces durante un solo gesto; coalescemos
      // los redibujados a un máximo de uno por frame con requestAnimationFrame
      // en vez de redibujar las 8.213 geometrías en cada evento.
      let transformPendiente: d3.ZoomTransform | null = null;
      let rafPendiente = false;
      const programarRedibujado = (transform: d3.ZoomTransform): void => {
        transformPendiente = transform;
        if (rafPendiente) return;
        rafPendiente = true;
        requestAnimationFrame(() => {
          rafPendiente = false;
          if (transformPendiente) redibujarCanvas(transformPendiente);
        });
      };

      const { svg, g } = this.crearSvgBase(el, ancho, alto, 40, programarRedibujado);
      redibujarCanvas(d3.zoomIdentity);

      // Bordes encima de los colores
      g.append('path').datum(mallaMunicipios)
        .attr('fill', 'none').attr('stroke', 'rgba(255,255,255,0.3)')
        .attr('stroke-width', 0.15).attr('pointer-events', 'none').attr('d', path);

      g.append('path').datum(mallaProvincias)
        .attr('fill', 'none').attr('stroke', '#fff')
        .attr('stroke-width', 0.9).attr('pointer-events', 'none').attr('d', path);

      this.dibujarCosta(g, topo, path);
      this.dibujarBordesInset(g, projection);

      // Path de highlight encima de todo: el municipio resaltado se dibuja con
      // un fill más claro + contorno oscuro sobre el canvas. Al ser un único
      // elemento SVG, actualizarlo en cada cambio de hover es barato — no hace
      // falta tocar/redibujar el canvas para resaltar un municipio.
      const highlightPath = g.append('path')
        .attr('fill', 'none')
        .attr('stroke', '#1a1a2e')
        .attr('stroke-width', 1.5)
        .attr('pointer-events', 'none')
        .attr('d', '');

      // ── Quadtree + overlay para hover preciso ──────────────────────────────
      const qt = d3.quadtree<CentroidEntry>()
        .x(d => d.x).y(d => d.y)
        .addAll(centroids);

      let activeMid: string | null = null;
      let mousedownXY: [number, number] = [0, 0];

      const highlightMunicipio = (mid: string | null) => {
        if (mid) {
          const d = dMap.get(mid);
          const orig = fillMap.get(mid);
          if (d && orig) {
            const base = d3.color(orig) ?? d3.color('#6baed6')!;
            highlightPath.attr('d', d).attr('fill', base.brighter(0.8).formatHex());
          }
        } else {
          highlightPath.attr('d', '').attr('fill', 'none');
        }
        activeMid = mid;
      };

      const textoTooltip = (e: CentroidEntry): string => {
        if (e.poblacion != null) return `${e.name}: ${formatPob(e.poblacion)}`;
        return e.nombreProv ? `${e.name} · ${e.nombreProv}` : e.name;
      };

      // Busca el municipio bajo el cursor: el quadtree da el centroide más
      // cercano SIN límite de radio (a zoom alto un municipio mide cientos de
      // píxeles en pantalla y el cursor puede estar lejos de su centroide,
      // p.ej. cerca de un borde — un radio fijo en píxeles de pantalla lo
      // dejaba sin encontrar nada). Ese candidato se confirma con
      // isPointInPath sobre su Path2D real: barato (una sola llamada nativa)
      // y geométricamente exacto a cualquier nivel de zoom.
      const buscarMunicipio = (gx: number, gy: number): CentroidEntry | undefined => {
        const candidato = qt.find(gx, gy);
        if (!candidato) return undefined;
        const p2d = path2DMap.get(candidato.mid);
        return p2d && ctx.isPointInPath(p2d, gx, gy) ? candidato : undefined;
      };

      // Rect transparente encima de todo el SVG — captura todos los eventos.
      // Registrado fuera de la zona de Angular: mousemove dispara este handler
      // decenas de veces por segundo y, con miles de municipios en pantalla,
      // dejar que cada uno disparase change detection era la causa del lag.
      this.ngZone.runOutsideAngular(() => {
        svg.append('rect')
          .attr('class', 'municipios-overlay')
          .attr('width', ancho).attr('height', alto)
          .attr('fill', 'none')
          .attr('pointer-events', 'all')
          .style('cursor', 'pointer')
          .on('mousedown', (event: MouseEvent) => {
            mousedownXY = [event.clientX, event.clientY];
          })
          .on('mousemove', (event: MouseEvent) => {
            const xform = d3.zoomTransform(svg.node()!);
            const [px, py] = d3.pointer(event);
            const [gx, gy] = xform.invert([px, py]);
            const found = buscarMunicipio(gx, gy);
            if (found) {
              if (found.mid !== activeMid) highlightMunicipio(found.mid);
              const pos = this.posicionRelativa(event);
              this.mostrarTooltip(textoTooltip(found), pos.x, pos.y);
            } else {
              if (activeMid) highlightMunicipio(null);
              this.ocultarTooltip();
            }
          })
          .on('mouseout', () => {
            highlightMunicipio(null);
            this.ocultarTooltip();
          })
          .on('click', (event: MouseEvent) => {
            const dx = event.clientX - mousedownXY[0];
            const dy = event.clientY - mousedownXY[1];
            if (Math.sqrt(dx * dx + dy * dy) > 5) return;
            const xform = d3.zoomTransform(svg.node()!);
            const [px, py] = d3.pointer(event);
            const [gx, gy] = xform.invert([px, py]);
            const found = buscarMunicipio(gx, gy);
            if (found) this.ngZone.run(() => this.zonaSeleccionada.update(a => a === found.name ? null : found.name));
          });
      });

    } finally {
      this.cargando.set(false);
    }
  }

  // ── eventos ───────────────────────────────────────────────────────────────

  private alHover(event: MouseEvent, d: { properties: PropiedadesRegion }, datos: Record<string, number>): void {
    const nombre = d.properties.name;
    const valor = datos[nombre];
    const texto = valor != null ? `${nombre}: ${this.formatPoblacionCompleta(valor)}` : nombre;
    const pos = this.posicionRelativa(event);
    this.mostrarTooltip(texto, pos.x, pos.y);
    d3.select(event.currentTarget as Element).attr('stroke', '#1a1a2e').attr('stroke-width', 1.5);
  }

  private alMover(event: MouseEvent): void {
    const pos = this.posicionRelativa(event);
    const el = this.tooltipEl().nativeElement;
    el.style.left = `${pos.x + 14}px`;
    el.style.top = `${pos.y - 36}px`;
  }

  private alSalir(): void {
    this.ocultarTooltip();
    d3.selectAll<SVGPathElement, unknown>('.region').attr('stroke', '#fff').attr('stroke-width', 0.5);
  }

  private alHacerClick(d: { properties: PropiedadesRegion }): void {
    const nombre = d.properties.name;
    this.zonaSeleccionada.update(actual => actual === nombre ? null : nombre);
  }
}
