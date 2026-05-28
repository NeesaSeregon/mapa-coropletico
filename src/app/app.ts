import { Component } from '@angular/core';
import { MapaComponent } from './components/mapa/mapa';

@Component({
  selector: 'app-root',
  imports: [MapaComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {}
