import { Component, ElementRef, signal, viewChild, afterNextRender, effect } from '@angular/core';
import * as d3 from 'd3';
import * as topojson from 'topojson-client';
import { geoConicConformalSpain } from 'd3-composite-projections';
import type { Topology, GeometryCollection } from 'topojson-specification';

export type ModoVista = 'provincias' | 'comunidades';

interface TooltipState {
  visible: boolean;
  texto: string;
  x: number;
  y: number;
}

interface PropiedadesRegion {
  name: string;
}

type TopoEspana = Topology<{
  provinces: GeometryCollection<PropiedadesRegion>;
  autonomous_regions: GeometryCollection<PropiedadesRegion>;
}>;

@Component({
  selector: 'app-mapa',
  templateUrl: './mapa.html',
  styleUrl: './mapa.scss'
})
export class MapaComponent {
  private contenedor = viewChild.required<ElementRef<HTMLDivElement>>('contenedor');

  modoVista = signal<ModoVista>('provincias');
  tooltip = signal<TooltipState>({ visible: false, texto: '', x: 0, y: 0 });
  zonaSeleccionada = signal<string | null>(null);

  private mapListo = signal(false);
  private topoCache: TopoEspana | null = null;

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
    'Andalucía': 8.50,
    'Aragón': 1.33,
    'Principado de Asturias': 1.02,
    'Illes Balears': 1.17,
    'Canarias': 2.17,
    'Cantabria': 0.58,
    'Castilla-La Mancha': 2.10,
    'Castilla y León': 2.39,
    'Cataluña/Catalunya': 7.80,
    'Comunitat Valenciana': 5.06,
    'Extremadura': 1.07,
    'Galicia': 2.70,
    'La Rioja': 0.32,
    'Comunidad de Madrid': 6.75,
    'Región de Murcia': 1.51,
    'Comunidad Foral de Navarra': 0.66,
    'País Vasco/Euskadi': 2.22,
    'Ciudad Autónoma de Ceuta': 0.08,
    'Ciudad Autónoma de Melilla': 0.08
  };

  constructor() {
    afterNextRender(() => this.mapListo.set(true));

    effect(() => {
      const modo = this.modoVista();
      if (this.mapListo()) {
        void this.renderizarMapa(modo);
      }
    });
  }

  cambiarModo(modo: ModoVista): void {
    this.zonaSeleccionada.set(null);
    this.tooltip.set({ visible: false, texto: '', x: 0, y: 0 });
    this.modoVista.set(modo);
  }

  private async renderizarMapa(modo: ModoVista): Promise<void> {
    const el = this.contenedor().nativeElement;
    d3.select(el).selectAll('svg').remove();

    const ancho = el.clientWidth || 800;
    const alto = el.clientHeight || 500;

    if (!this.topoCache) {
      this.topoCache = await d3.json<TopoEspana>('/assets/provinces.json') ?? null;
    }
    if (!this.topoCache) return;

    const objeto = modo === 'provincias'
      ? this.topoCache.objects.provinces
      : this.topoCache.objects.autonomous_regions;
    const datos = modo === 'provincias' ? this.datosProvincias : this.datosComunidades;

    const coleccion = topojson.feature(this.topoCache, objeto);
    const features = 'features' in coleccion ? coleccion.features : [];
    const mallaBordes = topojson.mesh(this.topoCache, objeto, (a, b) => a !== b);

    const projection = geoConicConformalSpain();
    projection.fitSize([ancho, alto], coleccion);
    const path = d3.geoPath().projection(projection);

    const maxValor = d3.max(Object.values(datos)) ?? 1;
    const colorScale = d3.scaleSequential(d3.interpolateBlues).domain([0, maxValor]);

    const svg = d3.select(el)
      .append('svg')
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('viewBox', `0 0 ${ancho} ${alto}`)
      .attr('preserveAspectRatio', 'xMidYMid meet');

    const g = svg.append('g');

    g.selectAll<SVGPathElement, (typeof features)[number]>('.region')
      .data(features)
      .enter()
      .append('path')
      .attr('class', 'region')
      .attr('d', path)
      .attr('fill', d => {
        const valor = datos[d.properties.name];
        return valor != null ? colorScale(valor) : '#d0d0d0';
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
      .attr('d', path);
  }

  private alHover(event: MouseEvent, d: { properties: PropiedadesRegion }, datos: Record<string, number>): void {
    const nombre = d.properties.name;
    const valor = datos[nombre];
    const texto = valor != null ? `${nombre}: ${valor.toFixed(2)}M hab.` : nombre;

    this.tooltip.set({ visible: true, texto, x: event.offsetX, y: event.offsetY });
    d3.select(event.currentTarget as Element).attr('stroke', '#1a1a2e').attr('stroke-width', 1.5);
  }

  private alMover(event: MouseEvent): void {
    this.tooltip.update(t => ({ ...t, x: event.offsetX, y: event.offsetY }));
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
