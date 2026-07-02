import { Component, ElementRef, signal, viewChild, afterNextRender, effect } from '@angular/core';
import * as d3 from 'd3';
import * as topojson from 'topojson-client';
import { geoConicConformalSpain } from 'd3-composite-projections';
import type { Topology, GeometryCollection } from 'topojson-specification';

export type ModoVista = 'provincias' | 'comunidades' | 'municipios';

interface TooltipState {
  visible: boolean;
  texto: string;
  x: number;
  y: number;
}

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

  modoVista = signal<ModoVista>('provincias');
  cargando = signal(false);
  tooltip = signal<TooltipState>({ visible: false, texto: '', x: 0, y: 0 });
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
    this.tooltip.set({ visible: false, texto: '', x: 0, y: 0 });
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

  private formatPoblacion(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M hab.`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k hab.`;
    return `${n} hab.`;
  }

  private crearEscalaColor(datos: Record<string, number>): d3.ScaleQuantile<string, never> {
    return d3.scaleQuantile<string>()
      .domain(Object.values(datos))
      .range([...d3.schemeBlues[7]]);
  }

  private crearSvgBase(
    el: HTMLDivElement,
    ancho: number,
    alto: number,
    maxZoom: number
  ): {
    svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
    g: d3.Selection<SVGGElement, unknown, null, undefined>;
  } {
    const svg = d3.select<HTMLDivElement, unknown>(el)
      .append<SVGSVGElement>('svg')
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('viewBox', `0 0 ${ancho} ${alto}`)
      .attr('preserveAspectRatio', 'xMidYMid meet');

    svg.append('rect')
      .attr('width', ancho)
      .attr('height', alto)
      .attr('fill', '#f5f7fb');

    const g = svg.append('g');

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.8, maxZoom])
      .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        g.attr('transform', event.transform.toString());
      });

    svg.call(zoom);
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
      .on('click', (_event: MouseEvent, d) => this.alHacerClick(d));

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

      const { svg, g } = this.crearSvgBase(el, ancho, alto, 40);

      // Fondo gris tierra
      this.dibujarFondoTierra(g, topo, path);

      // ClipPath: recorta los fills de municipios exactamente al borde de España.
      // Sin esto, los paths costeros se proyectan ligeramente fuera de la costa y
      // muestran color azul en el área del océano.
      const clipId = 'municipios-spain-clip';
      const borderClipD = path(topojson.feature(topo, topo.objects['border'])) ?? '';
      svg.append('defs')
        .append('clipPath').attr('id', clipId)
        .append('path').attr('d', borderClipD);

      // Sub-grupo recortado: ningún fill sale al océano
      const gMun = g.append('g').attr('clip-path', `url(#${clipId})`);

      type PathSel = d3.Selection<SVGPathElement, unknown, null, undefined>;
      const pathMap = new Map<string, PathSel>();

      interface CentroidEntry {
        x: number; y: number;
        name: string; nombreProv: string; mid: string;
        poblacion: number | undefined;
      }
      const centroids: CentroidEntry[] = [];

      for (const feat of features) {
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

        const pSel = gMun.append<SVGPathElement>('path')
          .attr('class', 'region municipio')
          .attr('d', dVal)
          .style('fill', fillColor)
          .attr('stroke', '#fff')
          .attr('stroke-width', 0.1);
        pathMap.set(mid, pSel);
      }

      // Bordes encima de los colores
      g.append('path').datum(mallaMunicipios)
        .attr('fill', 'none').attr('stroke', 'rgba(255,255,255,0.3)')
        .attr('stroke-width', 0.15).attr('pointer-events', 'none').attr('d', path);

      g.append('path').datum(mallaProvincias)
        .attr('fill', 'none').attr('stroke', '#fff')
        .attr('stroke-width', 0.9).attr('pointer-events', 'none').attr('d', path);

      this.dibujarCosta(g, topo, path);
      this.dibujarBordesInset(g, projection);

      // Path de highlight encima de todo (no recortado → trazo siempre visible)
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
      const savedFill = new Map<string, string>();

      const highlightMunicipio = (mid: string | null) => {
        if (activeMid) {
          const prev = pathMap.get(activeMid);
          if (prev) {
            const orig = savedFill.get(activeMid);
            if (orig) prev.style('fill', orig);
          }
        }
        if (mid) {
          const cur = pathMap.get(mid);
          if (cur) {
            if (!savedFill.has(mid)) savedFill.set(mid, cur.style('fill') || cur.attr('fill'));
            const base = d3.color(savedFill.get(mid)!) ?? d3.color('#6baed6')!;
            cur.style('fill', base.brighter(0.8).formatHex());
            highlightPath.attr('d', cur.attr('d') ?? '');
          }
        } else {
          highlightPath.attr('d', '');
        }
        activeMid = mid;
      };

      const textoTooltip = (e: CentroidEntry): string => {
        if (e.poblacion != null) return `${e.name}: ${formatPob(e.poblacion)}`;
        return e.nombreProv ? `${e.name} · ${e.nombreProv}` : e.name;
      };

      // Rect transparente encima de todo el SVG — captura todos los eventos
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
          const found = qt.find(gx, gy, 15 / xform.k);
          if (found) {
            if (found.mid !== activeMid) highlightMunicipio(found.mid);
            const pos = this.posicionRelativa(event);
            this.tooltip.set({ visible: true, texto: textoTooltip(found), x: pos.x, y: pos.y });
          } else {
            if (activeMid) highlightMunicipio(null);
            this.tooltip.update(s => ({ ...s, visible: false }));
          }
        })
        .on('mouseout', () => {
          highlightMunicipio(null);
          this.tooltip.update(s => ({ ...s, visible: false }));
        })
        .on('click', (event: MouseEvent) => {
          const dx = event.clientX - mousedownXY[0];
          const dy = event.clientY - mousedownXY[1];
          if (Math.sqrt(dx * dx + dy * dy) > 5) return;
          const xform = d3.zoomTransform(svg.node()!);
          const [px, py] = d3.pointer(event);
          const [gx, gy] = xform.invert([px, py]);
          const found = qt.find(gx, gy, 15 / xform.k);
          if (found) this.zonaSeleccionada.update(a => a === found.name ? null : found.name);
        });

    } finally {
      this.cargando.set(false);
    }
  }

  // ── eventos ───────────────────────────────────────────────────────────────

  private alHover(event: MouseEvent, d: { properties: PropiedadesRegion }, datos: Record<string, number>): void {
    const nombre = d.properties.name;
    const valor = datos[nombre];
    const texto = valor != null ? `${nombre}: ${valor.toFixed(2)}M hab.` : nombre;
    const pos = this.posicionRelativa(event);
    this.tooltip.set({ visible: true, texto, x: pos.x, y: pos.y });
    d3.select(event.currentTarget as Element).attr('stroke', '#1a1a2e').attr('stroke-width', 1.5);
  }

  private alMover(event: MouseEvent): void {
    const pos = this.posicionRelativa(event);
    this.tooltip.update(t => ({ ...t, x: pos.x, y: pos.y }));
  }

  private alSalir(): void {
    this.tooltip.update(t => ({ ...t, visible: false }));
    d3.selectAll<SVGPathElement, unknown>('.region').attr('stroke', '#fff').attr('stroke-width', 0.5);
  }

  private alHacerClick(d: { properties: PropiedadesRegion }): void {
    const nombre = d.properties.name;
    this.zonaSeleccionada.update(actual => actual === nombre ? null : nombre);
  }
}
