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
  private svgRef: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  private zoomBehavior: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;

  private readonly datosProvincias: Record<string, number> = {
    'A Coruña': 1.12, 'Araba/Álava': 0.33, 'Albacete': 0.39, 'Alacant/Alicante': 1.88,
    'Almería': 0.73, 'Asturias': 1.02, 'Ávila': 0.16, 'Badajoz': 0.68,
    'Illes Balears': 1.17, 'Barcelona': 5.71, 'Burgos': 0.36, 'Cáceres': 0.39,
    'Cádiz': 1.24, 'Cantabria': 0.58, 'Castelló/Castellón': 0.60, 'Ciudad Real': 0.50,
    'Córdoba': 0.78, 'Cuenca': 0.20, 'Girona': 0.78, 'Granada': 0.92,
    'Guadalajara': 0.27, 'Gipuzkoa': 0.72, 'Huelva': 0.52, 'Huesca': 0.22,
    'Jaén': 0.63, 'León': 0.45, 'Lleida': 0.44, 'La Rioja': 0.32,
    'Lugo': 0.33, 'Madrid': 6.75, 'Málaga': 1.68, 'Murcia': 1.51,
    'Navarra/Nafarroa': 0.66, 'Ourense': 0.31, 'Palencia': 0.16, 'Las Palmas': 1.13,
    'Pontevedra': 0.94, 'Salamanca': 0.33, 'Santa Cruz de Tenerife': 1.03,
    'Segovia': 0.16, 'Sevilla': 1.95, 'Soria': 0.09, 'Tarragona': 0.82,
    'Teruel': 0.14, 'Toledo': 0.70, 'Valencia/València': 2.58, 'Valladolid': 0.52,
    'Bizkaia': 1.15, 'Zamora': 0.17, 'Zaragoza': 0.97,
    'Ceuta': 0.08, 'Melilla': 0.08
  };

  private readonly datosComunidades: Record<string, number> = {
    'Andalucía': 8.50, 'Aragón': 1.33, 'Principado de Asturias': 1.02,
    'Illes Balears': 1.17, 'Canarias': 2.17, 'Cantabria': 0.58,
    'Castilla-La Mancha': 2.10, 'Castilla y León': 2.39, 'Cataluña/Catalunya': 7.80,
    'Comunitat Valenciana': 5.06, 'Extremadura': 1.07, 'Galicia': 2.70,
    'La Rioja': 0.32, 'Comunidad de Madrid': 6.75, 'Región de Murcia': 1.51,
    'Comunidad Foral de Navarra': 0.66, 'País Vasco/Euskadi': 2.22,
    'Ciudad Autónoma de Ceuta': 0.08, 'Ciudad Autónoma de Melilla': 0.08
  };

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

    // Fondo color océano — así las áreas fuera de España quedan visualmente claras
    svg.append('rect')
      .attr('width', ancho)
      .attr('height', alto)
      .attr('fill', '#c6dff0');

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
      .attr('fill', '#c6dff0')
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
    if (!this.topoCache) return;

    const objeto = modo === 'provincias'
      ? this.topoCache.objects['provinces']
      : this.topoCache.objects['autonomous_regions'];
    const datos = modo === 'provincias' ? this.datosProvincias : this.datosComunidades;

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
      if (!this.topoMunicipiosCache) return;

      const topo = this.topoMunicipiosCache;
      const coleccion = topojson.feature(topo, topo.objects['municipalities']);
      const features = 'features' in coleccion ? coleccion.features : [];
      const mallaProvincias = topojson.mesh(topo, topo.objects['provinces'], (a, b) => a !== b);
      const mallaMunicipios = topojson.mesh(topo, topo.objects['municipalities'], (a, b) => a !== b);

      const projection = geoConicConformalSpain();
      projection.fitSize([ancho, alto], coleccion);
      const path = d3.geoPath().projection(projection);
      const colorScale = this.crearEscalaColor(this.datosProvincias);

      const { g } = this.crearSvgBase(el, ancho, alto, 40);

      this.dibujarFondoTierra(g, topo, path);

      g.selectAll<SVGPathElement, (typeof features)[number]>('.municipio')
        .data(features)
        .enter()
        .append('path')
        .attr('class', 'region municipio')
        .attr('data-mid', d => String(d.id ?? ''))
        .attr('data-name', d => d.properties?.name ?? '')
        .attr('d', path)
        .attr('fill', d => {
          const codigo = String(d.id ?? '').slice(0, 2);
          const nombreProv = this.codigosProvincias[codigo];
          const valor = nombreProv ? this.datosProvincias[nombreProv] : undefined;
          return valor != null ? (colorScale(valor) ?? '#d0d0d0') : '#d0d0d0';
        })
        .attr('stroke', '#fff')
        .attr('stroke-width', 0.1)
        .on('mouseover', (event: MouseEvent) => {
          const el = event.currentTarget as SVGPathElement;
          const mid = el.getAttribute('data-mid') ?? '';
          const name = el.getAttribute('data-name') ?? '';
          const codigo = mid.slice(0, 2);
          const nombreProv = this.codigosProvincias[codigo] ?? '';
          const valor = this.datosProvincias[nombreProv];
          const texto = valor != null
            ? `${name} · ${nombreProv}: ${valor.toFixed(2)}M hab.`
            : name;
          const pos = this.posicionRelativa(event);
          this.tooltip.set({ visible: true, texto, x: pos.x, y: pos.y });
          d3.select(el).attr('stroke', '#1a1a2e').attr('stroke-width', 0.8);
        })
        .on('mousemove', (event: MouseEvent) => this.alMover(event))
        .on('mouseout', () => {
          this.tooltip.update(t => ({ ...t, visible: false }));
          d3.selectAll<SVGPathElement, unknown>('.municipio')
            .attr('stroke', '#fff').attr('stroke-width', 0.1);
        })
        .on('click', (event: MouseEvent) => {
          const el = event.currentTarget as SVGPathElement;
          const name = el.getAttribute('data-name') ?? '';
          this.zonaSeleccionada.update(actual => actual === name ? null : name);
        });

      // Bordes municipales muy finos
      g.append('path').datum(mallaMunicipios)
        .attr('fill', 'none').attr('stroke', 'rgba(255,255,255,0.3)')
        .attr('stroke-width', 0.15).attr('pointer-events', 'none').attr('d', path);

      // Bordes provinciales más visibles encima
      g.append('path').datum(mallaProvincias)
        .attr('fill', 'none').attr('stroke', '#fff')
        .attr('stroke-width', 0.9).attr('pointer-events', 'none').attr('d', path);

      this.dibujarMascaraOceano(g, topo, path, ancho, alto);
      this.dibujarCosta(g, topo, path);
      this.dibujarBordesInset(g, projection);

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
